#!/bin/bash

# Exit immediately if a command exits with a non-zero status.
set -e
# Ensure pipeline errors are propagated (e.g., if a command in a pipe fails).
set -o pipefail

# --- Configuration ---
TEMP_DIR_BASE_NAME="temp"
OUTPUT_FILE_NAME="data.csv"
EXCLUSION_FILE_NAME=".stat_exclude" # Name of the exclusion file

# --- Globals ---
SCRIPT_CWD=""
TEMP_DIR_PATH=""
INITIAL_PWD=""

# --- Functions ---
cleanup() {
  ( # Subshell for cd to not affect main script's PWD if trap is complex
    echo # Newline for cleaner exit messages
    echo "--- Cleaning up ---"
    if [ -n "$INITIAL_PWD" ] && [ "$(pwd)" != "$INITIAL_PWD" ]; then
      echo "Returning to initial directory: $INITIAL_PWD"
      cd "$INITIAL_PWD" || echo "Warning: Failed to cd back to $INITIAL_PWD during cleanup."
    fi

    if [ -d "$TEMP_DIR_PATH" ]; then
      echo "Removing temporary directory: $TEMP_DIR_PATH"
      rm -rf "$TEMP_DIR_PATH"
    else
      echo "Temporary directory '$TEMP_DIR_PATH' not found or already removed."
    fi
    echo "-------------------"
  )
}

# --- Main Script ---
INITIAL_PWD=$(pwd)

if [ -z "$1" ]; then
  echo "Usage: $0 <git_repo_url>"
  echo "The script will look for an exclusion file named '$EXCLUSION_FILE_NAME' in the root of the cloned repository."
  echo "Each line in '$EXCLUSION_FILE_NAME' should be a file path glob pattern (e.g., '*.log', 'docs/*')."
  echo "Lines starting with '#' and empty lines will be ignored."
  exit 1
fi
GIT_REPO_URL="$1"

SCRIPT_CWD="$INITIAL_PWD"
TEMP_DIR_NAME="${TEMP_DIR_BASE_NAME}" # Unique temp directory name
TEMP_DIR_PATH="$SCRIPT_CWD/$TEMP_DIR_NAME"
OUTPUT_FILE_PATH="$SCRIPT_CWD/public/$OUTPUT_FILE_NAME"

trap cleanup EXIT SIGINT SIGTERM # Setup cleanup routine

echo "Output will be saved to: $OUTPUT_FILE_PATH"
if [ -f "$OUTPUT_FILE_PATH" ]; then
    echo "INFO: Existing output file '$OUTPUT_FILE_PATH' will be overwritten."
fi

echo "Creating temporary directory: $TEMP_DIR_PATH"
mkdir -p "$TEMP_DIR_PATH"

echo "Cloning repository $GIT_REPO_URL into $TEMP_DIR_PATH..."
git clone --quiet "$GIT_REPO_URL" "$TEMP_DIR_PATH"
echo "Successfully cloned to $TEMP_DIR_PATH"

# Change to the cloned repository directory to find .stat_exclude and run git commands
cd "$TEMP_DIR_PATH"

# --- Prepare AWK filter program for exclusions ---
# This AWK program:
# 1. Reads $EXCLUSION_FILE_NAME (if it exists in the cloned repo root).
# 2. Converts glob patterns from the exclusion file into regular expressions.
# 3. Filters the input file paths (from git log) against these regexes.
# 4. Skips empty lines from input (replaces the previous 'sed /^$/d').
# Note: The shell variable EXCLUSION_FILE_NAME is embedded into the awk script string.
AWK_FILTER_PROGRAM='
BEGIN {
    idx = 0;  # Index for the exclude_regexes array
    # Get the exclusion filename from the shell variable passed into the awk script string
    exclusion_file = "'../"$EXCLUSION_FILE_NAME"'"; 

    # Check if the exclusion file exists and is readable in the current directory
    # system() call returns 0 on success for shell commands
    # Quoting exclusion_file for system() call to handle potential special characters (though unlikely for ".stat_exclude")
    if (system("test -f \"" exclusion_file "\" && test -r \"" exclusion_file "\"") == 0) {
        # Read patterns from the exclusion file
        while ((getline pattern < exclusion_file) > 0) {
            # Skip empty lines or lines starting with # (comments)
            if (pattern ~ /^[[:space:]]*$/ || pattern ~ /^[[:space:]]*#/) {
                continue;
            }
            
            # Basic glob to regex conversion:
            # 1. Escape backslashes (must be done first for other escapes to work correctly)
            gsub(/\\/, "\\\\", pattern); # \   -> \\ (literal backslash for regex engine)
            # 2. Escape other regex metacharacters that might appear literally in file paths or globs
            gsub(/\./, "\\.", pattern);  # .   -> \. (literal dot)
            gsub(/\+/, "\\+", pattern);  # +   -> \+ (literal plus)
            gsub(/\$/, "\\$", pattern);  # $   -> \$ (literal dollar)
            gsub(/\^/, "\\^", pattern);  # ^   -> \^ (literal caret)
            gsub(/\[/, "\\[", pattern); # [   -> \[ (literal open bracket)
            gsub(/\]/, "\\]", pattern); # ]   -> \] (literal close bracket)
            gsub(/\(/, "\\(", pattern); # (   -> \( (literal open parenthesis)
            gsub(/\)/, "\\)", pattern); # )   -> \) (literal close parenthesis)
            gsub(/\{/, "\\{", pattern); # {   -> \{ (literal open brace)
            gsub(/\}/, "\\}", pattern); # }   -> \} (literal close brace)
            gsub(/\|/, "\\|", pattern); # |   -> \| (literal pipe)
            # 3. Convert actual glob wildcards to their regex equivalents
            gsub(/\?/, ".", pattern);      # ?   -> . (matches any single character)
            gsub(/\*/, ".*", pattern);     # * -> .* (matches any sequence of zero or more characters)
            
            # Anchor pattern to match the whole line (filepath)
            exclude_regexes[idx++] = "^" pattern "$";
        }
        close(exclusion_file); # Close the file after reading

        if (idx > 0) {
            # Print informational messages to stderr so they don'\''t go into the CSV
            print "INFO: Loaded " idx " exclusion patterns from '\''" exclusion_file "'\''." > "/dev/stderr";
        } else {
            print "INFO: Exclusion file '\''" exclusion_file "'\'' was empty or only contained comments/blank lines. No patterns loaded." > "/dev/stderr";
        }
    } else {
        print "INFO: No exclusion file named '\''" exclusion_file "'\'' found or readable in the repository root. No path exclusions will be applied." > "/dev/stderr";
    }
}

# Process each input line (filepath from git log stdin)
{
    # Skip empty lines or lines consisting only of whitespace
    if ($0 ~ /^[[:space:]]*$/) {
        next;
    }

    # Check against exclusion patterns if any were loaded
    if (idx > 0) { # idx is the count of loaded patterns from BEGIN block
        is_excluded = 0;
        for (j = 0; j < idx; j++) {
            if ($0 ~ exclude_regexes[j]) { # If current filepath matches an exclusion regex
                is_excluded = 1;
                # Optional: print excluded path to stderr for debugging
                # print "DEBUG: Excluding path: '\''" $0 "'\'' (matched by regex: " exclude_regexes[j] ")" > "/dev/stderr";
                break; # No need to check other patterns for this filepath
            }
        }
        if (is_excluded) {
            next; # Skip this line (filepath) if it was matched for exclusion
        }
    }
    
    # If not an empty line and not excluded, print it to stdout for the next stage in the pipeline
    print $0;
}
' # End of AWK_FILTER_PROGRAM string

echo "Generating Git stats (this may take a while for large repositories)..."
# The output redirection '>' to OUTPUT_FILE_PATH happens for the entire compound command { ... }.
{
  # Header for the CSV file.
  echo "count,path,loc"

  # Git stats generation pipeline with the new awk filter
  git log --all --pretty=format:"" --name-only |
  awk "$AWK_FILTER_PROGRAM" | # Apply AWK script to filter paths and remove empty lines
  sort |                     # Sort file paths to group them for uniq
  uniq -c |                  # Count occurrences of each file path (commit count)
  sort -nr |                 # Sort numerically by count, descending
  # Reformat ' <count> <path>' to '<count>,<path>'
  sed -E 's/^[[:space:]]*([0-9]+)[[:space:]]+(.*)/\1,\2/' |
  # Process each resulting line (count,path) to get current lines of code (loc)
  while IFS=, read -r commit_count filepath; do
    current_loc=0 # Default LOC to 0
    if [ -f "$filepath" ]; then # Check if path is an existing regular file
      loc_value=$(wc -l < "$filepath" 2>/dev/null | awk '{print $1}')
      # Validate that loc_value is indeed a non-empty string of digits
      if [[ -n "$loc_value" && "$loc_value" =~ ^[0-9]+$ ]]; then
        current_loc="$loc_value"
      fi
      # If loc_value is not a number (empty or malformed), current_loc remains 0
    fi
    # Output the CSV line: count,path,loc
    echo "$commit_count,$filepath,$current_loc"
  done
} > "$OUTPUT_FILE_PATH"

echo "Git stats saved to $OUTPUT_FILE_PATH"
echo "Script completed successfully."

# The 'trap cleanup EXIT' will handle the cleanup process automatically.
exit 0
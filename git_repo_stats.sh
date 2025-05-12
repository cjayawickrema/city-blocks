#!/bin/bash

# Exit immediately if a command exits with a non-zero status.
set -e
# Ensure pipeline errors are propagated (e.g., if a command in a pipe fails).
set -o pipefail

# --- Configuration ---
TEMP_DIR_NAME="temp" # Fixed temporary directory name
PUBLIC_SUBDIR_NAME="public" # Subdirectory for the output CSV
OUTPUT_FILE_NAME="data.csv"
EXCLUSION_FILE_NAME=".stat_exclude" # Name of the exclusion file

# --- Globals ---
SCRIPT_CWD=""
TEMP_DIR_PATH=""
INITIAL_PWD=""
OUTPUT_DIR_PATH="" # Will store the full path to the public subdirectory

# --- Functions ---
cleanup() {
  ( # Subshell for cd to not affect main script's PWD if trap is complex
    echo # Newline for cleaner exit messages
    echo "--- Cleaning up ---"
    if [ -n "$INITIAL_PWD" ] && [ "$(pwd)" != "$INITIAL_PWD" ]; then
      echo "Returning to initial directory: $INITIAL_PWD"
      cd "$INITIAL_PWD" || echo "Warning: Failed to cd back to $INITIAL_PWD during cleanup."
    fi

    # Use the absolute path for removal to be safe
    if [ -d "$TEMP_DIR_PATH" ]; then
      echo "Removing temporary directory: $TEMP_DIR_PATH"
      rm -rf "$TEMP_DIR_PATH"
    else
      # This might occur if the directory wasn't created or already removed
      echo "Temporary directory '$TEMP_DIR_PATH' not found or already removed."
    fi
    # Remove the temporary CSV file if it still exists (e.g., if mv failed)
    # TEMP_CSV_PATH is derived from OUTPUT_FILE_PATH which now includes the public subdir
    if [ -f "${OUTPUT_DIR_PATH}/${OUTPUT_FILE_NAME}.tmp" ]; then # Check using the full path
        echo "Removing temporary CSV file: ${OUTPUT_DIR_PATH}/${OUTPUT_FILE_NAME}.tmp"
        rm -f "${OUTPUT_DIR_PATH}/${OUTPUT_FILE_NAME}.tmp"
    fi
    echo "-------------------"
  )
}

# --- Main Script ---
INITIAL_PWD=$(pwd) # Save initial PWD for robust cleanup and exclusion file path

if [ -z "$1" ]; then
  echo "Usage: $0 <git_repo_url>"
  echo "The script will look for an exclusion file named '$EXCLUSION_FILE_NAME' in the directory *where the script is run*."
  echo "Each line in '$EXCLUSION_FILE_NAME' should be a file path glob pattern (e.g., '*.log', 'docs/*')."
  echo "Lines starting with '#' and empty lines will be ignored."
  echo "Output 'data.csv' will be saved in the '$PUBLIC_SUBDIR_NAME/' subdirectory."
  echo "Output will only include files with a line count (loc) greater than 0."
  exit 1
fi
GIT_REPO_URL="$1"

SCRIPT_CWD="$INITIAL_PWD"
# Define the temporary directory path using the fixed name, relative to where the script is run
TEMP_DIR_PATH="$SCRIPT_CWD/$TEMP_DIR_NAME"

# Define the output directory and file paths
OUTPUT_DIR_PATH="$SCRIPT_CWD/$PUBLIC_SUBDIR_NAME"
OUTPUT_FILE_PATH="$OUTPUT_DIR_PATH/$OUTPUT_FILE_NAME"
TEMP_CSV_PATH="${OUTPUT_FILE_PATH}.tmp" # Temporary file for the second pass

# Define the absolute path to the exclusion file (one level up from the temp dir, which is SCRIPT_CWD)
EXCLUSION_FILE_PATH_ABS="$SCRIPT_CWD/$EXCLUSION_FILE_NAME"

trap cleanup EXIT SIGINT SIGTERM # Setup cleanup routine

# Create the public subdirectory if it doesn't exist
echo "Ensuring output directory '$OUTPUT_DIR_PATH' exists..."
mkdir -p "$OUTPUT_DIR_PATH"

echo "Output will be saved to: $OUTPUT_FILE_PATH"
if [ -f "$OUTPUT_FILE_PATH" ]; then
    echo "INFO: Existing output file '$OUTPUT_FILE_PATH' will be overwritten."
fi

# Handle potential existing "temp" directory
if [ -d "$TEMP_DIR_PATH" ]; then
    echo "Warning: Temporary directory '$TEMP_DIR_PATH' already exists. It will be removed."
    rm -rf "$TEMP_DIR_PATH"
fi

echo "Creating temporary directory: $TEMP_DIR_PATH"
mkdir -p "$TEMP_DIR_PATH"

echo "Cloning repository $GIT_REPO_URL into $TEMP_DIR_PATH..."
git clone --quiet "$GIT_REPO_URL" "$TEMP_DIR_PATH"
echo "Successfully cloned to $TEMP_DIR_PATH"

# Change to the cloned repository directory to run git log and wc -l relative to repo root
cd "$TEMP_DIR_PATH"

# --- Prepare AWK filter program for exclusions ---
# This AWK program now looks for the exclusion file one directory level up.
# We pass the absolute path to the exclusion file into the awk script.
AWK_FILTER_PROGRAM='
BEGIN {
    idx = 0;  # Index for the exclude_regexes array
    # Get the ABSOLUTE path to the exclusion file from the shell variable
    exclusion_file_abs_path = "'"$EXCLUSION_FILE_PATH_ABS"'"; 

    # Check if the exclusion file exists and is readable using its absolute path
    # system() call returns 0 on success for shell commands
    if (system("test -f \"" exclusion_file_abs_path "\" && test -r \"" exclusion_file_abs_path "\"") == 0) {
        # Read patterns from the exclusion file using its absolute path
        while ((getline pattern < exclusion_file_abs_path) > 0) {
            # Skip empty lines or lines starting with # (comments)
            if (pattern ~ /^[[:space:]]*$/ || pattern ~ /^[[:space:]]*#/) {
                continue;
            }
            
            # Basic glob to regex conversion:
            gsub(/\\/, "\\\\", pattern); # \   -> \\
            gsub(/\./, "\\.", pattern);  # .   -> \.
            gsub(/\+/, "\\+", pattern);  # +   -> \+
            gsub(/\$/, "\\$", pattern);  # $   -> \$
            gsub(/\^/, "\\^", pattern);  # ^   -> \^
            gsub(/\[/, "\\[", pattern); # [   -> \[
            gsub(/\]/, "\\]", pattern); # ]   -> \]
            gsub(/\(/, "\\(", pattern); # (   -> \(
            gsub(/\)/, "\\)", pattern); # )   -> \)
            gsub(/\{/, "\\{", pattern); # {   -> \{
            gsub(/\}/, "\\}", pattern); # }   -> \}
            gsub(/\|/, "\\|", pattern); # |   -> \|
            gsub(/\?/, ".", pattern);      # ?   -> .
            gsub(/\*/, ".*", pattern);     # * -> .*
            
            # Anchor pattern to match the whole line (filepath relative to repo root)
            exclude_regexes[idx++] = "^" pattern "$";
        }
        close(exclusion_file_abs_path); # Close the file after reading

        if (idx > 0) {
            print "INFO: Loaded " idx " exclusion patterns from '\''" exclusion_file_abs_path "'\''." > "/dev/stderr";
        } else {
            print "INFO: Exclusion file '\''" exclusion_file_abs_path "'\'' was empty or only contained comments/blank lines. No patterns loaded." > "/dev/stderr";
        }
    } else {
        print "INFO: No exclusion file named '\''" exclusion_file_abs_path "'\'' found or readable. No path exclusions will be applied." > "/dev/stderr";
    }
}

# Process each input line (filepath from git log stdin, relative to repo root)
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

echo "Generating Git stats (Pass 1: Including zero LOC files)..."
# The output redirection '>' to OUTPUT_FILE_PATH happens for the entire compound command { ... }.
# OUTPUT_FILE_PATH is in the SCRIPT_CWD/public, not the temp dir.
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
    # Check if the path points to an existing regular file IN THE CURRENT DIR (repo root).
    if [ -f "$filepath" ]; then
      # Get line count; suppress wc errors; awk extracts just the number.
      loc_value=$(wc -l < "$filepath" 2>/dev/null | awk '{print $1}')
      
      # Validate that loc_value is indeed a non-empty string of digits.
      if [[ -n "$loc_value" && "$loc_value" =~ ^[0-9]+$ ]]; then
        current_loc="$loc_value"
      fi
      # If loc_value is not a number (empty or malformed due to wc -l error), current_loc remains 0.
    fi

    # Write the line regardless of LOC value in this first pass
    echo "$commit_count,$filepath,$current_loc"

  done
} > "$OUTPUT_FILE_PATH" # This now points to SCRIPT_CWD/public/data.csv

echo "Git stats first pass saved to $OUTPUT_FILE_PATH"

# --- Second Pass: Filter out zero LOC lines ---
# This happens in the SCRIPT_CWD using the absolute paths defined earlier.
echo "Filtering Git stats (Pass 2: Removing zero LOC files)..."
# Use awk to print the header (NR==1) or lines where the 3rd field (loc), treated numerically, is not 0.
# Read from the original output file and write to a temporary file.
awk -F',' 'NR == 1 || $3+0 != 0' "$OUTPUT_FILE_PATH" > "$TEMP_CSV_PATH"

# Replace the original file with the filtered temporary file.
mv "$TEMP_CSV_PATH" "$OUTPUT_FILE_PATH"

echo "Filtered Git stats saved to $OUTPUT_FILE_PATH"
echo "Script completed successfully."

# The 'trap cleanup EXIT' will handle the cleanup process automatically.
# cd back to original directory before exiting (trap will handle deletion)
if [ "$(pwd)" != "$INITIAL_PWD" ]; then
    cd "$INITIAL_PWD"
fi
exit 0

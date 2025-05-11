#!/bin/bash

# Exit immediately if a command exits with a non-zero status.
set -e
# Ensure pipeline errors are propagated (e.g., if a command in a pipe fails).
set -o pipefail

# --- Configuration ---
# Base name for the temporary directory to avoid conflicts.
# We'll add a timestamp and PID for uniqueness.
TEMP_DIR_BASE_NAME="temp"
OUTPUT_FILE_NAME="data.csv"

# --- Globals ---
# These will be set in the main part of the script.
# SCRIPT_CWD stores where the script was launched from.
# TEMP_DIR_PATH will be the absolute path to the temporary clone.
# INITIAL_PWD stores the exact directory at script start for robust cleanup.
SCRIPT_CWD=""
TEMP_DIR_PATH=""
INITIAL_PWD=""

# --- Functions ---
cleanup() {
  # Using a subshell for cd to not affect the main script's PWD if trap is complex.
  # This ensures that 'rm -rf' has the correct context even if 'cd' fails.
  (
    echo # Newline for cleaner exit messages from script vs. trap.
    echo "--- Cleaning up ---"
    # Ensure we are not in the directory we are about to delete.
    # Change to the initial directory if we are not already there.
    if [ -n "$INITIAL_PWD" ] && [ "$(pwd)" != "$INITIAL_PWD" ]; then
      echo "Returning to initial directory: $INITIAL_PWD"
      cd "$INITIAL_PWD" || echo "Warning: Failed to cd back to $INITIAL_PWD during cleanup."
    fi

    # Remove the temporary directory if it exists.
    if [ -d "$TEMP_DIR_PATH" ]; then # Check if TEMP_DIR_PATH was set and is a directory.
      echo "Removing temporary directory: $TEMP_DIR_PATH"
      rm -rf "$TEMP_DIR_PATH"
    else
      # This message might appear if TEMP_DIR_PATH was never properly created.
      echo "Temporary directory '$TEMP_DIR_PATH' not found or already removed."
    fi
    echo "-------------------"
  )
}

# --- Main Script ---
INITIAL_PWD=$(pwd) # Save initial PWD for robust cleanup.

# Check for Git repository URL argument.
if [ -z "$1" ]; then
  echo "Usage: $0 <git_repo_url>"
  exit 1
fi
GIT_REPO_URL="$1"

# Define a unique temporary directory path and the output file path.
# SCRIPT_CWD is where the script was launched from, so the output file and temp dir are relative to it.
SCRIPT_CWD="$INITIAL_PWD"
# Generate a unique name for the temporary directory.
TEMP_DIR_NAME="${TEMP_DIR_BASE_NAME}" # timestamp and PID for uniqueness.
TEMP_DIR_PATH="$SCRIPT_CWD/$TEMP_DIR_NAME"
OUTPUT_FILE_PATH="$SCRIPT_CWD/public/$OUTPUT_FILE_NAME"

# Setup trap for cleanup on EXIT (normal or error) and on signals like SIGINT (Ctrl+C) or SIGTERM.
trap cleanup EXIT SIGINT SIGTERM

# Output file will be overwritten if it exists.
echo "Output will be saved to: $OUTPUT_FILE_PATH"

# Create temporary directory.
echo "Creating temporary directory: $TEMP_DIR_PATH"
# mkdir -p creates parent directories if needed and doesn't error if it already exists (though it shouldn't).
mkdir -p "$TEMP_DIR_PATH"

# Clone the repository.
echo "Cloning repository $GIT_REPO_URL into $TEMP_DIR_PATH..."
# Full clone is needed for 'git log --all' to get full commit history by path.
# Using --quiet to reduce verbosity from git clone itself.
# set -e will cause script to exit if git clone fails.
git clone --quiet "$GIT_REPO_URL" "$TEMP_DIR_PATH"

echo "Successfully cloned to $TEMP_DIR_PATH"

# Change to the cloned repository directory.
# set -e will cause script to exit if cd fails.
cd "$TEMP_DIR_PATH"

echo "Generating Git stats (this may take a while for large repositories)..."
# The output redirection '>' happens for the entire compound command { ... }.
{
  # Header for the CSV file.
  echo "count,path,loc"

  # The actual stats generation pipeline:
  # 1. Get all file names from all commits in history.
  # 2. Remove empty lines that git log might produce between commits' file lists.
  # 3. Sort file paths to group identical paths together for 'uniq'.
  # 4. Count occurrences of each file path (this is the commit count for that path).
  # 5. Sort numerically by count, in reverse (descending) order.
  # 6. Reformat ' <count> <path>' to '<count>,<path>' CSV format.
  # 7. For each resulting line (count,path), calculate current lines of code (loc) for that file.
  git log --all --pretty=format:"" --name-only |
  sed '/^$/d' |
  sort |
  uniq -c |
  sort -nr |
  sed -E 's/^[[:space:]]*([0-9]+)[[:space:]]+(.*)/\1,\2/' |
  while IFS=, read -r commit_count filepath; do
    current_loc=0 # Default LOC to 0.
    
    # Check if the path points to an existing regular file in the current directory (which is the repo root).
    if [ -f "$filepath" ]; then
      # Get line count; suppress wc errors; awk extracts just the number.
      loc_value=$(wc -l < "$filepath" 2>/dev/null | awk '{print $1}')
      
      # Validate that loc_value is indeed a non-empty string of digits.
      if [[ -n "$loc_value" && "$loc_value" =~ ^[0-9]+$ ]]; then
        current_loc="$loc_value"
      fi
      # If loc_value is not a number (e.g., empty or malformed due to wc -l error), current_loc remains 0.
    fi
    # Output the CSV line: count,path,loc.
    echo "$commit_count,$filepath,$current_loc"
  done
} > "$OUTPUT_FILE_PATH" # Redirect output to data.csv in the original script directory.

echo "Git stats saved to $OUTPUT_FILE_PATH"
echo "Script completed successfully."

# The 'trap cleanup EXIT' will handle the cleanup process now.
# Explicitly exit with 0 for success.
exit 0
#!/bin/sh
set -e

# Discover playwright's installed chromium and export CHROME_PATH for Stagehand
CHROME_EXEC=$(find /root/.cache/ms-playwright -type f -name "chrome" 2>/dev/null | head -1)
if [ -n "$CHROME_EXEC" ]; then
  export CHROME_PATH="$CHROME_EXEC"
fi

exec "$@"

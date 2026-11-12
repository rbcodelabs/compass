#!/usr/bin/env bash
# Vercel "ignoreCommand": exit 0 = SKIP the build, exit 1 = BUILD.
# Builds only for main, or when the commit message contains [deploy].
if [ "$VERCEL_GIT_COMMIT_REF" = "main" ] || [[ "$VERCEL_GIT_COMMIT_MESSAGE" == *"[deploy]"* ]]; then
  echo "Building (ref=$VERCEL_GIT_COMMIT_REF)"; exit 1
fi
echo "Skipping build: not main and no [deploy] in commit message"; exit 0

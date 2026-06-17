#!/bin/bash
# Auto-deploy: pull latest main and restart if changed
cd /opt/whatsapp-agent || exit 1
git fetch -q origin main 2>/dev/null || exit 0
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)
if [ "$LOCAL" != "$REMOTE" ]; then
  echo "$(date '+%F %T') deploying $REMOTE"
  NEEDNPM=0
  git diff --quiet HEAD origin/main -- package-lock.json package.json || NEEDNPM=1
  git reset --hard -q origin/main
  [ "$NEEDNPM" = "1" ] && npm ci --omit=dev --silent
  systemctl restart whatsapp-agent
  echo "$(date '+%F %T') deployed + restarted"
fi

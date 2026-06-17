#!/bin/bash
# Auto-deploy: pull latest main, VALIDATE, restart — roll back if broken.
cd /opt/whatsapp-agent || exit 1
git fetch -q origin main 2>/dev/null || exit 0
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)
[ "$LOCAL" = "$REMOTE" ] && exit 0

echo "$(date '+%F %T') deploying $REMOTE"
NEEDNPM=0
git diff --quiet HEAD origin/main -- package-lock.json package.json || NEEDNPM=1
git reset --hard -q origin/main
[ "$NEEDNPM" = "1" ] && npm ci --omit=dev --silent

# Guardrail: syntax-check every file + run unit tests before restarting the bot.
validate() {
  for f in *.js; do node --check "$f" || return 1; done
  npm test --silent >/dev/null 2>&1 || return 1
  return 0
}

if validate; then
  systemctl restart whatsapp-agent
  echo "$(date '+%F %T') deployed + restarted ($REMOTE)"
else
  echo "$(date '+%F %T') VALIDATION FAILED — rolling back to $LOCAL"
  git reset --hard -q "$LOCAL"
  [ "$NEEDNPM" = "1" ] && npm ci --omit=dev --silent
  printf '%s deploy %s failed validation; kept running on %s\n' "$(date '+%F %T')" "$REMOTE" "$LOCAL" >> NEEDS_REPAIR.txt
  echo "$(date '+%F %T') rolled back — bot still running on $LOCAL"
fi

#!/bin/bash
# restart-clean.sh — Docker-varianten. "Full ren omstart" när något krånglar.
# Datan i ./data (databas, backuper) rörs INTE — bara containern byggs om
# från grunden.
set -e

BACKUP_DIR="pre-update-backups/$(date +%Y-%m-%d_%H-%M-%S)_restart-clean"
if [ -d "data" ]; then
  echo "Säkerhetskopierar data/ till $BACKUP_DIR innan omstarten..."
  mkdir -p "$BACKUP_DIR"
  cp -r data/. "$BACKUP_DIR/" 2>/dev/null || true
  ls -1dt pre-update-backups/*/ 2>/dev/null | tail -n +11 | xargs -r rm -rf
fi

echo "Stoppar och tar bort containern..."
docker compose down

echo "Bygger om helt från grunden (ingen cache)..."
docker compose build --no-cache

echo "Startar..."
docker compose up -d

echo ""
echo "Klart. Kolla loggar med: docker compose logs -f lager"
echo "Säkerhetskopia sparad i: $BACKUP_DIR"

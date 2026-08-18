#!/bin/bash
# update.sh — Docker-varianten. Kör vid varje uppdatering: bash update.sh
set -e

echo "========================================"
echo "   Uppdaterar Lager (Docker)..."
echo "========================================"
echo ""

# SÄKERHETSKOPIA FÖRST, ALLTID — automatiskt, ingen åtgärd krävs. Sparas
# UTANFÖR ./data (i ./pre-update-backups) så den aldrig kan råka skrivas
# över eller tas bort av misstag tillsammans med den vanliga datan. Om
# NÅGOT går fel i uppdateringen finns alltid en färsk återgångspunkt.
BACKUP_DIR="pre-update-backups/$(date +%Y-%m-%d_%H-%M-%S)"
if [ -d "data" ]; then
  echo "Säkerhetskopierar data/ till $BACKUP_DIR innan något annat görs..."
  mkdir -p "$BACKUP_DIR"
  cp -r data/. "$BACKUP_DIR/" 2>/dev/null || true
  echo "  Klart. Behåller de 10 senaste säkerhetskopiorna, tar bort äldre."
  # Behåll bara de 10 senaste — annars växer disken sig full över tid
  ls -1dt pre-update-backups/*/ 2>/dev/null | tail -n +11 | xargs -r rm -rf
else
  echo "  (Ingen data/-mapp hittad än — första installationen, inget att säkerhetskopiera.)"
fi
echo ""

echo "Hämtar från GitHub..."
git pull

echo ""
echo "Bygger om och startar om containern..."
# --build bygger om imagen med den nya koden. Datan i ./data (databas,
# backuper) rörs inte — den ligger utanför containern, se docker-compose.yml.
docker compose up -d --build

echo ""
echo "Väntar på att servern svarar..."
for i in $(seq 1 20); do
  if curl -sf http://localhost:3000/api/network > /dev/null 2>&1; then
    echo "  Servern svarar!"
    break
  fi
  sleep 1
done

echo ""
echo "========================================"
echo "   Klart!"
echo "========================================"
echo ""
echo "  Loggar: docker compose logs -f lager"
echo "  Säkerhetskopia sparad i: $BACKUP_DIR"
echo "  (Återställ vid behov: stoppa containern, kopiera tillbaka till data/)"
echo ""

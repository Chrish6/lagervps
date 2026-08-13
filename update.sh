#!/bin/bash
# update.sh — Docker-varianten. Kör vid varje uppdatering: bash update.sh
set -e

echo "========================================"
echo "   Uppdaterar Lager (Docker)..."
echo "========================================"
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
echo ""

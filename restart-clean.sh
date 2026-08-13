#!/bin/bash
# restart-clean.sh — Docker-varianten. "Full ren omstart" när något krånglar.
# Datan i ./data (databas, backuper) rörs INTE — bara containern byggs om
# från grunden.
set -e

echo "Stoppar och tar bort containern..."
docker compose down

echo "Bygger om helt från grunden (ingen cache)..."
docker compose build --no-cache

echo "Startar..."
docker compose up -d

echo ""
echo "Klart. Kolla loggar med: docker compose logs -f lager"

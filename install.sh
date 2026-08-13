#!/bin/bash
# install.sh — Docker-varianten. Kör en gång vid nyinstallation: bash install.sh
set -e

echo "========================================"
echo "   Lager (Docker) — Installation"
echo "========================================"
echo ""

echo "[1/4] Kontrollerar Docker..."
if ! command -v docker &> /dev/null; then
  echo "  Docker saknas. Installerar via Dockers officiella skript..."
  curl -fsSL https://get.docker.com | sh
else
  echo "  Docker finns: $(docker --version)"
fi

echo ""
echo "[2/4] Kontrollerar Docker Compose..."
if ! docker compose version &> /dev/null; then
  echo "  Docker Compose-pluginet saknas. Installerar..."
  apt-get update && apt-get install -y docker-compose-plugin
else
  echo "  Docker Compose finns: $(docker compose version)"
fi

echo ""
echo "[3/4] Skapar mapp för beständig data (databas, backuper)..."
mkdir -p data
echo "  Klart: ./data"

echo ""
echo "[4/4] Bygger och startar containern..."
docker compose up -d --build

echo ""
echo "========================================"
echo "   Klart!"
echo "========================================"
echo ""
echo "  Servern kör nu lokalt på: http://localhost:3000"
echo "  (bara nåbar från servern själv — nginx sköter HTTPS utåt, se nedan)"
echo ""
echo "  Kvar att göra:"
echo "  1. Sätt upp nginx + HTTPS — se nginx-lager.conf och kör:"
echo "       apt install -y nginx certbot python3-certbot-nginx"
echo "       cp nginx-lager.conf /etc/nginx/sites-available/lager"
echo "       ln -s /etc/nginx/sites-available/lager /etc/nginx/sites-enabled/"
echo "       certbot --nginx -d ditt-domän.se"
echo "  2. Peka ditt domännamns DNS-post mot VPS:ens IP-adress."
echo "  3. Kontrollera att allt fungerar:"
echo "       docker compose logs -f lager"
echo ""

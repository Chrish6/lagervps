#!/bin/bash
# install.sh — Motsvarigheten till INSTALLERA.bat, fast för Linux-VPS.
# Kör en gång vid nyinstallation: bash install.sh
set -e

echo "========================================"
echo "   Lager (VPS) — Installation"
echo "========================================"
echo ""

echo "[1/7] Kontrollerar Node.js..."
if ! command -v node &> /dev/null; then
  echo "  Node.js saknas. Installerar via NodeSource..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt install -y nodejs
else
  echo "  Node.js finns: $(node --version)"
fi

echo ""
echo "[2/7] Installerar byggverktyg (behövs för att kompilera sqlite3)..."
sudo apt install -y build-essential python3

echo ""
echo "[3/7] Installerar npm-paket..."
npm install

echo ""
echo "[4/7] Bygger appen..."
npm run build

echo ""
echo "[5/7] Installerar PM2 globalt (om det saknas)..."
if ! command -v pm2 &> /dev/null; then
  sudo npm install -g pm2
else
  echo "  PM2 finns redan."
fi

echo ""
echo "[6/7] Installerar rclone (valfritt — för att skicka backuper till OneDrive)..."
if ! command -v rclone &> /dev/null; then
  curl https://rclone.org/install.sh | sudo bash
else
  echo "  rclone finns redan."
fi

echo ""
echo "[7/7] Startar servern med PM2..."
pm2 start ecosystem.config.js
pm2 save

echo ""
echo "========================================"
echo "   Klart!"
echo "========================================"
echo ""
echo "  Servern kör nu lokalt på: http://localhost:3000"
echo ""
echo "  Kvar att göra:"
echo "  1. Kör 'pm2 startup' och följ instruktionen som visas,"
echo "     så startar servern automatiskt om VPS:en startas om."
echo "  2. Sätt upp nginx + HTTPS — se nginx-lager.conf och kör:"
echo "       sudo certbot --nginx -d ditt-domän.se"
echo "  3. Peka ditt domännamns DNS-post mot VPS:ens IP-adress."
echo "  4. (Valfritt) Koppla backuper till OneDrive:"
echo "       rclone config   →  välj 'onedrive', logga in i webbläsaren"
echo "     Lägg sedan till RCLONE_REMOTE i ecosystem.config.js och kör:"
echo "       pm2 restart lager --update-env"
echo ""

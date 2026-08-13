#!/bin/bash
# update.sh — Motsvarigheten till UPPDATERA.bat, fast för Linux-VPS.
# Kör vid varje uppdatering: bash update.sh
set -e

echo "========================================"
echo "   Uppdaterar Lager (VPS)..."
echo "========================================"
echo ""

echo "Kör automatiska tester först..."
npm test || { echo "FEL: Testerna misslyckades — avbryter uppdateringen."; exit 1; }

echo ""
echo "Hämtar från GitHub..."
git pull

echo ""
echo "Installerar ev. nya beroenden..."
npm install

echo ""
echo "Bygger om appen..."
npm run build

echo ""
echo "Startar om servern..."
pm2 restart lager

echo ""
echo "========================================"
echo "   Klart!"
echo "========================================"
echo ""
echo "Kontrollera status: pm2 status"
echo "Se loggen:          pm2 logs lager --lines 30 --nostream"
echo ""

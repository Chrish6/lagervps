#!/bin/bash
# restart-clean.sh — "Full ren omstart", samma metod som beskrivs i
# Windows- och Raspberry Pi-guiderna, fast för VPS:en. Använd om en
# uppdatering inte verkar slå igenom, eller om servern beter sig konstigt
# trots en vanlig "pm2 restart".
set -e

echo "Full ren omstart av Lager..."
pm2 kill
pkill -f node || true
sleep 1
pm2 start ecosystem.config.js
pm2 save
pm2 flush lager

echo ""
echo "Klart. Kontrollera:"
echo "  pm2 status"
echo "  pm2 logs lager --lines 20 --nostream"

// ── Lager — Direkt återställning från backup-fil ──────────────────────────────
// Kör: node restore.cjs "C:\sökväg\till\lager_backup.json"
// Läser backupen och lägger in den direkt i databasen — utan webbläsare.

const sqlite3 = require("sqlite3").verbose();
const path = require("path");
const fs = require("fs");

const backupFile = process.argv[2];
if (!backupFile) {
  console.error("\n  Användning: node restore.cjs \"sökväg\\till\\backup.json\"\n");
  process.exit(1);
}
if (!fs.existsSync(backupFile)) {
  console.error("\n  Filen hittades inte:", backupFile, "\n");
  process.exit(1);
}

// SÄKERHET/DRIFT: samma DB_PATH-mönster som server.cjs — annars skriver
// detta skript till fel fil i Docker-miljön (där riktiga databasen ligger
// på /app/data/lager.db, inte bredvid själva skriptet), och rapporterar
// "lyckad återställning" trots att den riktiga produktionsdatabasen
// aldrig rördes alls.
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "lager.db");
const db = new sqlite3.Database(DB_PATH);
console.log(`Använder databas: ${DB_PATH}`);

// SÄKERHET: exakt samma bildvalidering som server.cjs använder för webb-
// baserad återställning (riktiga JPEG/PNG/WebP-signaturer, max 8MB per
// bild) — annars skulle det här kommandoradsverktyget vara en oskyddad
// bakväg som skriver in ovaliderade "bilder" direkt i databasen, förbi
// alla kontroller webb-API:t redan har.
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
function isValidImageDataUrl(dataUrl) {
  if (typeof dataUrl !== "string") return false;
  const m = dataUrl.match(/^data:([^;]+);base64,(.*)$/);
  if (!m) return false;
  const declaredType = m[1].toLowerCase();
  if (!["image/jpeg", "image/png", "image/webp"].includes(declaredType)) return false;
  let buf;
  try { buf = Buffer.from(m[2], "base64"); } catch { return false; }
  if (buf.length === 0 || buf.length > MAX_IMAGE_BYTES) return false;
  const isJpeg = buf[0]===0xFF && buf[1]===0xD8 && buf[2]===0xFF;
  const isPng  = buf[0]===0x89 && buf[1]===0x50 && buf[2]===0x4E && buf[3]===0x47;
  const isWebp = buf.length>12 && buf.toString("ascii",0,4)==="RIFF" && buf.toString("ascii",8,12)==="WEBP";
  if (declaredType==="image/jpeg" && !isJpeg) return false;
  if (declaredType==="image/png" && !isPng) return false;
  if (declaredType==="image/webp" && !isWebp) return false;
  return true;
}

function run(sql, params) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) { err ? reject(err) : resolve(this); });
  });
}

(async () => {
  try {
    console.log("\n========================================");
    console.log("   Lager - Återställning från backup");
    console.log("========================================");
    console.log("  Läser fil:", backupFile);

    const raw = fs.readFileSync(backupFile, "utf8");
    const data = JSON.parse(raw);
    if (!data.items) throw new Error("Ogiltig backup — saknar items");

    console.log("  Antal delar:", data.items.length);

    // Säkerställ tabeller
    await run(`CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER DEFAULT (strftime('%s','now')))`);
    await run(`CREATE TABLE IF NOT EXISTS images (item_id TEXT PRIMARY KEY, data TEXT)`);

    // Dela upp items i lätt lista + bilder
    const lightItems = [];
    let imageCount = 0;
    let skippedInvalidImages = 0;

    console.log("  Bearbetar bilder...");
    await run("BEGIN TRANSACTION");
    await run("DELETE FROM images");

    for (const it of data.items) {
      const rawImgs = it.images || [];
      const imgs = rawImgs.filter(isValidImageDataUrl);
      skippedInvalidImages += rawImgs.length - imgs.length;
      const thumb = it.thumb && isValidImageDataUrl(it.thumb) ? it.thumb : (imgs.length > 0 ? imgs[0] : null);
      lightItems.push({ ...it, images: [], hasImages: imgs.length, thumb });
      if (imgs.length > 0) {
        await run("INSERT OR REPLACE INTO images(item_id,data) VALUES(?,?)", [it.id, JSON.stringify(imgs)]);
        imageCount++;
      }
    }
    if (skippedInvalidImages > 0) {
      console.log(`  OBS: hoppade över ${skippedInvalidImages} ogiltiga bilder (fel format eller för stora)`);
    }

    // Spara lätt lista + övrig data
    await run("INSERT OR REPLACE INTO store(key,value,updated_at) VALUES('ow:items',?,strftime('%s','now'))", [JSON.stringify(lightItems)]);
    if (data.sales)     await run("INSERT OR REPLACE INTO store(key,value,updated_at) VALUES('ow:sales',?,strftime('%s','now'))", [JSON.stringify(data.sales)]);
    if (data.users)     await run("INSERT OR REPLACE INTO store(key,value,updated_at) VALUES('ow:users',?,strftime('%s','now'))", [JSON.stringify(data.users)]);
    if (data.settings)  await run("INSERT OR REPLACE INTO store(key,value,updated_at) VALUES('ow:settings',?,strftime('%s','now'))", [JSON.stringify(data.settings)]);
    if (data.suppliers) await run("INSERT OR REPLACE INTO store(key,value,updated_at) VALUES('ow:suppliers',?,strftime('%s','now'))", [JSON.stringify(data.suppliers)]);

    await run("COMMIT");

    console.log("========================================");
    console.log(`  KLART! ${lightItems.length} delar återställda`);
    console.log(`  ${imageCount} delar med bilder`);
    console.log("========================================");
    console.log("  Starta om servern: pm2 restart lager\n");

    db.close();
  } catch (e) {
    console.error("\n  FEL:", e.message, "\n");
    try { await run("ROLLBACK"); } catch {}
    db.close();
    process.exit(1);
  }
})();

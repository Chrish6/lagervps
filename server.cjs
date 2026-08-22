const express = require("express");
const helmet  = require("helmet");
const sqlite3 = require("sqlite3").verbose();
const path    = require("path");
const os      = require("os");
const fs      = require("fs");

// ── Windows vs VPS — DOKUMENTERADE SKILLNADER ───────────────────────────────
// Den här filen (server.vps.cjs) och server.cjs (Windows) ska vara IDENTISKA
// förutom exakt tre saker, av tekniska skäl. Alla API-endpoints/funktioner
// ska alltid finnas i BÅDA filerna — hittar du en skillnad som inte står i
// listan här är det ett misstag, inte avsett.
//   1. mDNS (lager.local) — BORTTAGET här (VPS har ett riktigt domännamn
//      istället, ingen lokal nätverksannonsering behövs), finns i server.cjs
//   2. Backup-molnsynk — HÄR: sparar lokalt på servern OCH skickar en kopia
//      till OneDrive via rclone (valfritt, styrs av RCLONE_REMOTE), eftersom
//      VPS:en inte har någon OneDrive-app. server.cjs (Windows): OneDrive-
//      appen körs redan på datorn, sparar direkt dit. Slutresultatet är
//      detsamma: backupen syns i samma OneDrive-mapp oavsett variant.
//   3. Startbannerns text — smärre skillnad i vad som skrivs ut vid start.

const PORT = process.env.PORT || 3000;

// Förhindra att servern kraschar av oväntade fel
process.on("uncaughtException", (err) => {
  console.error("[Ohanterat fel — servern fortsätter]:", err.message);
  throttledNotify("serverError", "Serverfel upptäckt",
    `<p>Ett ohanterat fel inträffade på servern:</p><p style="font-family:monospace;background:#f4f5f7;padding:10px;border-radius:6px">${err.message}</p><p>Servern fortsatte köra, men det kan vara värt att kontrollera loggen (<code>pm2 logs lager</code>).</p>`);
});
process.on("unhandledRejection", (err) => {
  console.error("[Ohanterad rejection — servern fortsätter]:", err?.message || err);
  throttledNotify("serverError", "Serverfel upptäckt",
    `<p>Ett ohanterat asynkront fel inträffade på servern:</p><p style="font-family:monospace;background:#f4f5f7;padding:10px;border-radius:6px">${err?.message || err}</p><p>Servern fortsatte köra, men det kan vara värt att kontrollera loggen (<code>pm2 logs lager</code>).</p>`);
});

// mDNS (lager.local) är MEDVETET BORTTAGET här — servern nås via ett riktigt
// domännamn på internet, ingen lokal nätverksannonsering behövs. (Windows-
// varianten server.cjs har kvar mDNS-blocket.)

const app  = express();
// SÄKERHET: talar om för Express att den KÖR bakom en reverse proxy
// (Traefik, på samma maskin — containern är bunden till 127.0.0.1:3000,
// bara nåbar lokalt). "loopback" betyder att Express bara litar på
// X-Forwarded-For-headern när anropet kommer från localhost (dvs. FRÅN
// Traefik självt) — inte från en extern klient som skulle kunna sätta
// headern själv för att förfalska sin IP och kringgå IP-baserad
// utspärrning vid t.ex. upprepade felaktiga inloggningsförsök. Med detta
// beräknar Express req.ip säkert själv, istället för att koden manuellt
// (och otryggt) läser headern rakt av.
app.set("trust proxy", "loopback");
// Konfigurerbar via miljövariabel (används av Docker-uppsättningen för att
// peka på en monterad, beständig mapp) — annars exakt samma beteende som
// innan (en lager.db bredvid server.cjs), inget ändras för Windows/vanlig
// VPS-drift utan Docker.
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "lager.db");


// ── Databas ───────────────────────────────────────────────────────────────────
const db = new sqlite3.Database(DB_PATH);

db.serialize(() => {
  // WAL-läge — bättre samtidighet, mindre risk för "database is locked"
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA busy_timeout = 5000");
  db.run("PRAGMA synchronous = NORMAL");

  db.run(`CREATE TABLE IF NOT EXISTS store (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at INTEGER DEFAULT (strftime('%s','now'))
  )`);
  // Separat tabell för bilder — en rad per artikel-id.
  // data = JSON-array av base64-bilder. updated_at för cache-busting.
  db.run(`CREATE TABLE IF NOT EXISTS images (
    item_id TEXT PRIMARY KEY,
    data TEXT,
    updated_at INTEGER DEFAULT (strftime('%s','now'))
  )`);
  db.run("ALTER TABLE images ADD COLUMN updated_at INTEGER DEFAULT 0", () => {});
  db.run(`CREATE TABLE IF NOT EXISTS request_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    method TEXT,
    key TEXT,
    ts INTEGER DEFAULT (strftime('%s','now'))
  )`);
});

function dbGet(key) {
  return new Promise((resolve, reject) => {
    db.get("SELECT value FROM store WHERE key=?", [key], (err, row) => {
      if (err) reject(err); else resolve(row || null);
    });
  });
}
function dbSet(key, value) {
  return new Promise((resolve, reject) => {
    db.run("INSERT OR REPLACE INTO store(key,value,updated_at) VALUES(?,?,strftime('%s','now'))", [key, value], (err) => {
      if (err) reject(err); else resolve();
    });
  });
}
function dbDel(key) {
  return new Promise((resolve, reject) => {
    db.run("DELETE FROM store WHERE key=?", [key], (err) => {
      if (err) reject(err); else resolve();
    });
  });
}

// ── Serverstyrd audit-logg ───────────────────────────────────────────────────
// Separat från den vanliga aktivitetsloggen (ow:activitylog), som klienten
// själv väljer VAD som ska rapporteras dit — en manipulerad/skadlig klient
// skulle alltså i teorin kunna hoppa över att rapportera något dit. Den
// här loggen skrivs ISTÄLLET direkt från servern själv, vid källan, för de
// mest känsliga händelserna (inloggningar, roll-/behörighetsändringar,
// återställningar, konfigurationsändringar) — omöjlig att kringgå från
// klientsidan eftersom den aldrig är klientens beslut att göra.
async function auditLog(event, username, details = {}) {
  try {
    const row = await dbGet("ow:serverauditlog");
    const log = row ? JSON.parse(row.value) : [];
    log.unshift({ event, username: username || "okänd", details, ts: Date.now() });
    // Behåll bara de senaste 2000 posterna — annars växer den obegränsat
    if (log.length > 2000) log.length = 2000;
    await dbSet("ow:serverauditlog", JSON.stringify(log));
  } catch (e) {
    console.error("[audit] Kunde inte skriva logg:", e.message);
  }
}

// ── E-postnotiser (Gmail via app-lösenord) ────────────────────────────────────
const nodemailer = require("nodemailer");

async function getEmailConfig() {
  const row = await dbGet("ow:emailconfig");
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return null; }
}

function makeTransport(cfg) {
  return nodemailer.createTransport({
    service: "gmail",
    auth: { user: cfg.fromEmail, pass: cfg.appPassword },
  });
}

// ── KGK Fordonsdata — artikelnummer-korsreferenser (märke/modell/år/alt.nr) ──
// VIKTIGT: Detta är ett SKELETT byggt i väntan på riktig API-dokumentation
// från KGK. Request-format, autentisering och (framför allt) hur svaret
// tolkas (mapKgkResponse nedan) är en rimlig GISSNING — det måste justeras
// så fort vi har ett riktigt exempel-svar från KGK att titta på. Så länge
// "enabled" är false (standard) görs ALDRIG några anrop mot KGK alls.
async function getKgkConfig() {
  const row = await dbGet("ow:kgkconfig");
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return null; }
}

// Tolkar KGK:s svar till Lagers fältnamn. GISSNING tills vi ser ett riktigt
// svar — justera fältnamnen (raw.xxx) här när vi vet exakt hur det ser ut.
function mapKgkResponse(raw) {
  if (!raw) return null;
  return {
    found: true,
    make: raw.make || raw.brand || raw.tillverkare || null,
    model: raw.model || raw.modell || null,
    yearFrom: raw.yearFrom || raw.arFran || null,
    yearTo: raw.yearTo || raw.arTill || null,
    category: raw.category || raw.kategori || null,
    name: raw.description || raw.benamning || raw.name || null,
    alternativeNumbers: raw.alternativeNumbers || raw.altNr || raw.crossReferences || [],
  };
}

// SÄKERHET: grundläggande säkerhetsheaders (CSP, HSTS, X-Content-Type-
// Options, klickjacknings-skydd m.m.) — saknades tidigare helt.
// Content-Security-Policy nedan är byggd utifrån de EXTERNA resurser
// appen faktiskt använder (kollat igenom hela koden för att hitta dem,
// inte gissat) — QR-koder, Font Awesome, Google Fonts, ZXing (skanning)
// och xlsx-export. 'unsafe-inline' krävs tyvärr för style-src eftersom
// hela appens gränssnitt bygger på Reacts style={{}}-attribut (renderas
// som inline style="..." i DOM:en) — att ta bort det kräver en stor,
// separat omskrivning till CSS-klasser. script-src har DÄREMOT ingen
// 'unsafe-inline' alls, vilket är den viktigaste delen att hålla strikt
// (huvudförsvaret mot XSS) — det inline-skriptet som fanns i index.html
// flyttades till en riktig modulfil just för att slippa behöva det här.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "https://unpkg.com", "https://cdnjs.cloudflare.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdnjs.cloudflare.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com", "data:"],
      imgSrc: ["'self'", "data:", "blob:", "https://api.qrserver.com", "https://barcodeapi.org"],
      connectSrc: ["'self'"],
      mediaSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
    },
  },
  // Kameraåtkomst (QR/streckkodsskanning) kräver HTTPS, men det kravet sätts
  // redan av webbläsaren självt oavsett — påverkas inte av detta.
  crossOriginEmbedderPolicy: false, // skulle annars blockera de externa QR/bild-anropen ovan
}));
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

// ── Skydd för admin-panelen (den separata sidan på /admin) ─────────────────
// Tre nivåer av skydd under /admin/api/*, inte bara två:
//   1. HELT ÖPPET — bara /admin/api/healthcheck (externa övervakningsverktyg,
//      skyddas separat av HEALTHCHECK_TOKEN). Notiser om misslyckade
//      inloggningar/stora köp ligger INTE här längre — de sker numera
//      direkt inuti /api/login respektive den vanliga ow:sales-sparningen,
//      som redan kräver (eller själva ÄR) autentisering. En helt öppen
//      notis-endpoint skulle annars låta vem som helst trigga falska mejl.
//   2. KRÄVER INLOGGNING (vilken roll som helst) — saker som triggas av
//      vanliga, inloggade användares normala handlingar: en notis vid
//      försäljning, en KGK-slagning, ett testmejl. De ska inte kräva
//      adminbehörighet bara för att de råkar ligga under /admin/api/.
//   3. KRÄVER ADMINROLL — själva adminpanelens instrumentpanel (status,
//      enheter, omstart, backup-nu) — det här är den känsliga delen.
const ADMIN_PANEL_PASSWORD = process.env.ADMIN_PANEL_PASSWORD || null;
const ADMIN_FULLY_PUBLIC = new Set(["/admin/api/healthcheck"]);
const ADMIN_LOGIN_ONLY = new Set([
  "/admin/api/event",
  "/admin/api/notify-warehouse-reservation",
  "/admin/api/kgk/test",
  "/admin/api/kgk/lookup",
  "/admin/api/kgk/notify-not-found",
  "/admin/api/email-test",
]);
app.use(async (req, res, next) => {
  if (!req.path.startsWith("/admin")) return next();
  if (ADMIN_FULLY_PUBLIC.has(req.path)) return next();

  if (req.path === "/admin") {
    if (ADMIN_PANEL_PASSWORD) {
      const auth = req.headers.authorization || "";
      const [scheme, encoded] = auth.split(" ");
      const okBasic = scheme === "Basic" && encoded && Buffer.from(encoded,"base64").toString().split(":")[1] === ADMIN_PANEL_PASSWORD;
      if (!okBasic) {
        res.set("WWW-Authenticate", 'Basic realm="Lager Admin"');
        return res.status(401).send("Lösenord krävs för admin-panelen.");
      }
    }
    return next();
  }

  try {
    const token = (req.headers.authorization || "").replace("Bearer ", "");
    const username = await getSessionUser(token);
    if (!username) return res.status(401).json({ ok:false, error:"Inte inloggad." });

    // Nivå 2 — inloggad räcker, adminroll krävs inte
    if (ADMIN_LOGIN_ONLY.has(req.path)) {
      req.authUsername = username;
      return next();
    }

    // Nivå 3 — resten av /admin/api/* kräver faktisk adminroll
    const usersRow = await dbGet("ow:users");
    const usersArr = usersRow ? JSON.parse(usersRow.value) : [];
    const u = usersArr.find(x=>x.username===username);
    if (!u || u.role !== "admin") return res.status(403).json({ ok:false, error:"Kräver adminbehörighet." });
    req.authUsername = username;
    next();
  } catch (e) {
    res.status(500).json({ ok:false, error: e.message });
  }
});

app.post("/admin/api/kgk/test", async (req, res) => {
  try {
    const cfg = await getKgkConfig();
    if (!cfg || !cfg.apiKey || !cfg.baseUrl) {
      return res.status(400).json({ ok:false, error:"Fyll i bas-URL och API-nyckel först." });
    }
    const testUrl = `${cfg.baseUrl.replace(/\/$/,"")}/ping`; // GISSAD endpoint — justera vid behov
    const r = await fetch(testUrl, { headers: { "Authorization": `Bearer ${cfg.apiKey}` } });
    if (!r.ok) return res.status(400).json({ ok:false, error:`KGK svarade med status ${r.status}. Kontrollera nyckel/URL.` });
    res.json({ ok:true, message:"Anslutning fungerar." });
  } catch (e) {
    res.status(500).json({ ok:false, error:"Kunde inte nå KGK: " + e.message });
  }
});

// Slår upp EN artikel hos KGK. Anropas en i taget från klienten vid en
// genomgång av lagret, så att förloppet kan visas live och inte överbelastar
// KGK:s API.
app.post("/admin/api/kgk/lookup", async (req, res) => {
  try {
    const cfg = await getKgkConfig();
    if (!cfg || !cfg.enabled) return res.status(400).json({ ok:false, error:"KGK-integrationen är inte aktiverad." });
    if (!cfg.apiKey || !cfg.baseUrl) return res.status(400).json({ ok:false, error:"Saknar API-uppgifter." });
    const { oem, sku, name } = req.body || {};
    if (!oem && !sku) return res.status(400).json({ ok:false, error:"Artikelnummer saknas." });

    const lookupUrl = `${cfg.baseUrl.replace(/\/$/,"")}/parts/search?number=${encodeURIComponent(oem||sku)}`; // GISSAD endpoint
    const r = await fetch(lookupUrl, { headers: { "Authorization": `Bearer ${cfg.apiKey}` } });
    if (r.status === 404) return res.json({ ok:true, found:false });
    if (!r.ok) return res.status(502).json({ ok:false, error:`KGK svarade med status ${r.status}` });
    const raw = await r.json();
    const mapped = mapKgkResponse(raw);
    res.json({ ok:true, ...mapped });
  } catch (e) {
    res.status(500).json({ ok:false, error: e.message });
  }
});

// Skickar ett mejl med listan över delar som INTE hittades hos KGK efter en
// genomgång — så att de kan kollas manuellt (kanske är artikelnumret
// felskrivet, eller så finns delen helt enkelt inte hos KGK).
app.post("/admin/api/kgk/notify-not-found", async (req, res) => {
  try {
    const { items } = req.body || {};
    if (!Array.isArray(items) || !items.length) return res.json({ ok:true, sent:false });
    const cfg = await getEmailConfig();
    if (cfg?.notifTypes?.kgkNotFound === false) return res.json({ ok:true, sent:false });
    const rows = items.map(i => `<li><strong>${i.name||"Okänt namn"}</strong> — artikelnr: <code>${i.oem||"—"}</code>${i.stockNumber?`, lagernr #${i.stockNumber}`:""}</li>`).join("");
    await sendNotification("kgkNotFound", `${items.length} delar hittades inte hos KGK`,
      `<p>Efter senaste genomgången av lagret mot KGK Fordonsdata hittades <strong>${items.length}</strong> delar inte i katalogen:</p>
       <ul>${rows}</ul>
       <p>Kontrollera gärna om artikelnumren är korrekt inskrivna, eller fyll i uppgifterna manuellt om delen helt enkelt inte finns hos KGK.</p>`);
    res.json({ ok:true, sent:true });
  } catch (e) {
    res.status(500).json({ ok:false, error: e.message });
  }
});

// Skickar ett mejl om notistypen är aktiverad i inställningarna. Fel loggas men kraschar aldrig servern.
async function sendNotification(type, subject, bodyHtml) {
  try {
    const cfg = await getEmailConfig();
    if (!cfg || !cfg.enabled || !cfg.fromEmail || !cfg.appPassword || !cfg.adminEmail) return;
    if (cfg.notifTypes && cfg.notifTypes[type] === false) return; // explicit avstängd
    const transport = makeTransport(cfg);
    await transport.sendMail({
      from: `"Lager" <${cfg.fromEmail}>`,
      to: cfg.adminEmail,
      subject: `[Lager] ${subject}`,
      html: `<div style="font-family:sans-serif;font-size:14px;color:#141820">${bodyHtml}
        <p style="color:#94a3b8;font-size:11px;margin-top:20px">Skickat automatiskt av Lager-systemet · ${new Date().toLocaleString("sv-SE")}</p></div>`,
    });
    console.log(`[email] Skickade notis: ${type}`);
  } catch (e) {
    console.error(`[email] Kunde inte skicka notis (${type}):`, e.message);
  }
}

// Enkel spärr så samma feltyp inte spammar admin — max 1 mejl per typ var 30:e minut
const lastNotifSent = {};
function throttledNotify(type, subject, bodyHtml, cooldownMinutes = 30) {
  const now = Date.now();
  const last = lastNotifSent[type] || 0;
  if (now - last < cooldownMinutes * 60 * 1000) return;
  lastNotifSent[type] = now;
  sendNotification(type, subject, bodyHtml);
}


const stats = { started: Date.now(), requests: 0, errors: 0 };

// ── Enhetsspårning (i minnet) ─────────────────────────────────────────────────
// Spårar varje aktiv enhet per IP: senaste aktivitet, antal anrop, inloggad användare.
const devices = new Map(); // ip -> { ip, firstSeen, lastSeen, count, user, userAgent }
// Live-flöde av senaste händelser (köp, ändringar m.m.) som frontend rapporterar.
const liveFeed = []; // { type, description, user, ip, ts }
const MAX_FEED = 60;

function clientIp(req) {
  // req.ip beräknas av Express själv utifrån "trust proxy"-inställningen
  // ovan — säkert mot förfalskade X-Forwarded-For-headrar från en extern
  // klient, till skillnad från att läsa headern direkt (som den gjorde
  // tidigare här).
  let ip = (req.ip || req.socket.remoteAddress || "").toString();
  return ip.replace(/^::ffff:/, "").replace(/^::1$/, "127.0.0.1");
}

// ═══════════════════════════════════════════════════════════════════════════
// ── SÄKERHET — riktig autentisering ─────────────────────────────────────────
// Tidigare skickades bara ett användarnamn som header, utan någon verklig
// kontroll — vem som helst som kunde nå servern kunde läsa/ändra all data,
// inklusive lösenordshashar, helt utan att logga in. Det här bygger om det
// från grunden:
//   1. Riktig lösenordshashning (scrypt + slumpat salt per användare, inte
//      den gamla enkla checksumman med ett delat salt för alla).
//   2. Riktiga sessionstoken — utfärdas vid inloggning, sparas på servern,
//      måste skickas med (Authorization: Bearer <token>) för att komma åt
//      data. Ett användarnamn i en header räcker inte längre.
//   3. Lösenordshashar skickas ALDRIG till klienten.
//   4. Inloggningsförsök begränsas — 10 felaktiga försök inom 15 minuter
//      låser kontot temporärt (skyddar mot att någon gissar lösenord).
// Gamla lösenord (det enkla hash-formatet) fortsätter fungera vid inloggning
// och skrivs om automatiskt till det nya, säkrare formatet — ingen
// tvingas byta lösenord för att detta ska fungera.
const crypto = require("crypto");

function hashPasswordServer(plain) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(plain), salt, 64).toString("hex");
  return `scrypt:${salt}:${hash}`;
}
function verifyPasswordServer(plain, stored) {
  if (!stored) return false;
  if (stored.startsWith("scrypt:")) {
    const [, salt, hash] = stored.split(":");
    try {
      const check = crypto.scryptSync(String(plain), salt, 64).toString("hex");
      return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(check, "hex"));
    } catch { return false; }
  }
  // Legacy-format (den gamla, svaga hashen) — stöds bara för att låta
  // befintliga användare logga in en sista gång innan den skrivs om.
  let hash = 0;
  const str = String(plain) + "lager_salt_2024";
  for (let i = 0; i < str.length; i++) { hash = ((hash << 5) - hash) + str.charCodeAt(i); hash |= 0; }
  const legacy = "h_" + Math.abs(hash).toString(36) + "_" + str.length;
  return legacy === stored;
}

// Sessioner sparas i databasen (samma nyckel-värde-lager som allt annat)
// så att ett serveromstart inte loggar ut alla — men rensas för utgångna.
async function getSessions() {
  const row = await dbGet("ow:sessions");
  try { return row ? JSON.parse(row.value) : {}; } catch { return {}; }
}
async function saveSessions(sessions) { await dbSet("ow:sessions", JSON.stringify(sessions)); }

// SÄKERHET: sparar en HASH av token i databasen, aldrig den riktiga,
// användbara token själv. Om databasen någonsin skulle läcka (t.ex. via
// en exponerad backup-fil) skulle en angripare annars ha de exakta,
// direkt användbara inloggningstokens för alla aktiva sessioner — kunde
// omedelbart utge sig för att vara vem som helst utan att knäcka något
// alls. Med hashning är det värdelöst utan den ORIGINALA token, som bara
// någonsin skickas till den riktiga klienten vid inloggning. En vanlig,
// snabb hash (inte scrypt som för lösenord) är rätt val här — token är
// redan 32 slumpmässiga byte med hög entropi, inte en människovald,
// gissningsbar hemlighet som lösenord är.
function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

const SESSION_DAYS = 30;
async function createSession(username) {
  const token = crypto.randomBytes(32).toString("hex");
  const sessions = await getSessions();
  sessions[hashToken(token)] = { username, expires: Date.now() + SESSION_DAYS * 864e5 };
  await saveSessions(sessions);
  return token;
}
async function getSessionUser(token) {
  if (!token) return null;
  const sessions = await getSessions();
  const s = sessions[hashToken(token)];
  if (!s || s.expires < Date.now()) return null;
  return s.username;
}

// Kräver att den inloggade användaren (req.authUsername, satt av
// autentiseringsmellanlagret) har adminroll. Skickar 403 och returnerar
// false om inte — annars returnerar true och anroparen fortsätter. Bygger
// alltid på SERVERNS egen lagrade användardata, aldrig något klienten
// skickar med i requesten (som skulle kunna förfalskas).
async function requireAdmin(req, res) {
  try {
    const usersRow = await dbGet("ow:users");
    const users = usersRow ? JSON.parse(usersRow.value) : [];
    const me = users.find(u => u.username === req.authUsername);
    if (!me || me.role !== "admin") {
      res.status(403).json({ ok:false, error:"Kräver adminbehörighet" });
      return false;
    }
    return true;
  } catch (e) {
    res.status(500).json({ ok:false, error: e.message });
    return false;
  }
}

// Misslyckade inloggningsförsök — blockerar efter för många försök
const loginAttempts = {};
function isLockedOut(key) {
  const attempts = (loginAttempts[key] || []).filter(t => Date.now() - t < 15 * 60 * 1000);
  loginAttempts[key] = attempts;
  return attempts.length >= 10;
}
function recordFailedAttempt(key) {
  loginAttempts[key] = [...(loginAttempts[key] || []), Date.now()];
}

// Publika endpoints som INTE kräver inloggning (måste kunna nås för att
// överhuvudtaget kunna logga in, samt hälsokontroll för övervakning).
const PUBLIC_PATHS = new Set(["/api/login", "/api/network", "/admin/api/healthcheck"]);

app.post("/api/login", async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ ok:false, error:"Ange användarnamn och lösenord" });
    const key = clientIp(req) + ":" + username.toLowerCase();
    if (isLockedOut(key)) {
      return res.status(429).json({ ok:false, error:"För många felaktiga försök. Vänta 15 minuter och försök igen." });
    }
    const usersRow = await dbGet("ow:users");
    const users = usersRow ? JSON.parse(usersRow.value) : [];
    const user = users.find(u => u.username?.toLowerCase() === username.toLowerCase());
    const valid = user && verifyPasswordServer(password, user.password);
    if (!valid) {
      recordFailedAttempt(key);
      // Mejlvarning vid upprepade misslyckade försök — ligger HÄR (server-
      // side, redan inloggnings-endpointen) istället för att triggas av ett
      // separat, publikt API-anrop från klienten. En publik notis-endpoint
      // skulle annars låta VEM SOM HELST på internet trigga falska
      // varningsmejl till admin utan att ens försöka logga in på riktigt.
      const notifKey = username.toLowerCase() + "|" + clientIp(req);
      const now = Date.now();
      failedLogins[notifKey] = (failedLogins[notifKey] || []).filter(t => now - t < 15 * 60 * 1000);
      failedLogins[notifKey].push(now);
      if (failedLogins[notifKey].length >= 3) {
        sendNotification("failedLogin", `Flera misslyckade inloggningsförsök — ${username}`,
          `<p>Minst 3 misslyckade inloggningsförsök på användarnamnet <strong>${username}</strong> från IP ${clientIp(req)} under de senaste 15 minuterna.</p>`
        ).catch(()=>{});
        failedLogins[notifKey] = [];
      }
      // Samma generiska felmeddelande oavsett om användarnamnet finns eller
      // ej — avslöjar inte vilka konton som existerar.
      return res.status(401).json({ ok:false, error:"Fel användarnamn eller lösenord" });
    }
    // Skriv om till starkare hash-format om det fortfarande är det gamla
    if (!user.password.startsWith("scrypt:")) {
      user.password = hashPasswordServer(password);
      await dbSet("ow:users", JSON.stringify(users));
    }
    const token = await createSession(user.username);
    auditLog("login", user.username, { ip: clientIp(req) });
    const { password: _pw, ...safeUser } = user;
    res.json({ ok:true, token, user: safeUser });
  } catch (e) {
    res.status(500).json({ ok:false, error: e.message });
  }
});

app.post("/api/logout", async (req, res) => {
  try {
    const token = (req.headers.authorization || "").replace("Bearer ", "");
    const sessions = await getSessions();
    delete sessions[hashToken(token)];
    await saveSessions(sessions);
    res.json({ ok:true });
  } catch (e) { res.status(500).json({ ok:false, error: e.message }); }
});

// Kräv giltig session för huvudappens data-API. OBS: /admin/api/* (den
// separata admin-panelen på /admin) omfattas MEDVETET INTE av detta — den
// använder ett annat, enklare skyddssätt (bara nåbar på det lokala
// nätverket) och skulle sluta fungera annars. Den panelen är i sig ett eget
// separat säkerhetsjobb om striktare skydd önskas där också (t.ex. ett eget
// lösenord) — hör av dig om det ska prioriteras.
app.use(async (req, res, next) => {
  if (!req.path.startsWith("/api/")) return next();
  if (PUBLIC_PATHS.has(req.path)) return next();
  // /api/img/* undantas medvetet — de laddas via vanliga <img src="...">-
  // taggar i sidan, och webbläsaren kan tekniskt inte bifoga en
  // inloggningstoken till den typen av bildförfrågan (till skillnad från
  // fetch(), som kan sätta egna headers). Bilder på bildelar är dessutom
  // inte känslig information på samma sätt som resten av datan.
  if (req.path.startsWith("/api/img/")) return next();
  // Undantag: ALLRA FÖRSTA skrivningen till ow:users (skapar admin-kontot
  // vid en helt ny installation) måste kunna ske innan någon är inloggad —
  // annars kan appen aldrig komma igång. Bara tillåtet om inga användare
  // finns sedan tidigare, annars krävs inloggning som vanligt.
  if (req.path === "/api/ow:users" && req.method === "POST") {
    const existingRow = await dbGet("ow:users");
    let existing = [];
    try { existing = existingRow ? JSON.parse(existingRow.value) : []; } catch {}
    if (existing.length === 0) return next();
  }
  const token = (req.headers.authorization || "").replace("Bearer ", "");
  const username = await getSessionUser(token);
  if (!username) return res.status(401).json({ ok:false, error:"Inte inloggad eller sessionen har gått ut" });
  req.authUsername = username;
  next();
});
// ═══════════════════════════════════════════════════════════════════════════

// Byt sitt eget lösenord — kräver att man är inloggad (req.authUsername) och
// att det gamla lösenordet stämmer, kontrollerat här på servern (aldrig
// klienten, som inte har tillgång till hasharna).
app.post("/api/change-own-password", async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body || {};
    if (!oldPassword || !newPassword) return res.status(400).json({ ok:false, error:"Ange både gammalt och nytt lösenord" });
    if (newPassword.length < 4) return res.status(400).json({ ok:false, error:"Nytt lösenord måste vara minst 4 tecken" });
    const usersRow = await dbGet("ow:users");
    const users = usersRow ? JSON.parse(usersRow.value) : [];
    const idx = users.findIndex(u => u.username === req.authUsername);
    if (idx === -1) return res.status(404).json({ ok:false, error:"Användaren hittades inte" });
    if (!verifyPasswordServer(oldPassword, users[idx].password)) {
      return res.status(401).json({ ok:false, error:"Fel nuvarande lösenord" });
    }
    users[idx].password = hashPasswordServer(newPassword);
    await dbSet("ow:users", JSON.stringify(users));
    res.json({ ok:true });
  } catch (e) {
    res.status(500).json({ ok:false, error: e.message });
  }
});

// Fabriksåterställning — rensar lager/sälj-data helt. Rör ALDRIG användare,
// lösenord, inställningar eller listor (kategorier, lager-orter, osv), så
// man aldrig blir utelåst eller behöver bygga upp konfigurationen igen.
// Kräver adminroll + att klienten skickar en exakt bekräftelsefras, som ett
// extra skydd mot att detta triggas av misstag (t.ex. ett buggigt skript).
app.post("/api/factory-reset", async (req, res) => {
  try {
    const usersRow = await dbGet("ow:users");
    const users = usersRow ? JSON.parse(usersRow.value) : [];
    const me = users.find(u => u.username === req.authUsername);
    if (!me || me.role !== "admin") return res.status(403).json({ ok:false, error:"Kräver adminbehörighet" });
    if (req.body?.confirm !== "NOLLSTÄLL") {
      return res.status(400).json({ ok:false, error:"Fel bekräftelsefras" });
    }
    await dbSet("ow:items", "[]");
    await dbSet("ow:sales", "[]");
    await dbSet("ow:trash", "[]");
    await dbSet("ow:customers", "[]");
    await dbSet("ow:activitylog", "[]");
    console.log(`[reset] Fabriksåterställning utförd av ${req.authUsername}`);
    auditLog("factory_reset", req.authUsername);
    res.json({ ok:true });
  } catch (e) {
    res.status(500).json({ ok:false, error: e.message });
  }
});


app.use((req, res, next) => {
  if (req.path.startsWith("/api/")) {
    const ip = clientIp(req);
    const now = Date.now();
    let d = devices.get(ip);
    if (!d) { d = { ip, firstSeen: now, lastSeen: now, count: 0, user: null, userAgent: req.headers["user-agent"] || "" }; devices.set(ip, d); }
    d.lastSeen = now;
    d.count++;
    // Användarnamn skickas med som header från frontend om inloggad
    const u = req.headers["x-lager-user"];
    if (u) d.user = decodeURIComponent(u);
  }
  next();
});

app.use(express.static(path.join(__dirname, "dist")));

// ── API ───────────────────────────────────────────────────────────────────────
app.get("/api/network", (req, res) => {
  const ips = Object.values(os.networkInterfaces()).flat()
    .filter(i => i.family === "IPv4" && !i.internal)
    .map(i => i.address);
  res.json({ ips, port: PORT });
});

// ── DELTA-SYNK — måste ligga FÖRE /api/:key så den inte fångas av den ─────────
// Returnerar bara artiklar ändrade efter ?since=<tidsstämpel i ms>.
app.get("/api/delta", async (req, res) => {
  try {
    stats.requests++;
    const since = Number(req.query.since) || 0;
    const row = await dbGet("ow:items");
    const items = row ? JSON.parse(row.value) : [];
    const changed = items.filter(i => (i.updatedAt || 0) > since);
    const allIds = items.map(i => i.id);
    const maxUpdatedAt = items.reduce((a, i) => Math.max(a, i.updatedAt || 0), 0);
    res.json({ changed, allIds, maxUpdatedAt, total: items.length });
  } catch (e) {
    stats.errors++;
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/:key", async (req, res) => {
  try {
    stats.requests++;
    const r = await dbGet(req.params.key);
    // Lösenordshashar skickas ALDRIG till klienten, oavsett format
    if (req.params.key === "ow:users" && r && r.value) {
      try {
        const users = JSON.parse(r.value).map(u => ({ ...u, password: undefined }));
        return res.json({ ...r, value: JSON.stringify(users) });
      } catch {}
    }
    // SÄKERHET: konfigurationsnycklar som innehåller riktiga hemligheter
    // (Gmail-app-lösenord, KGK-API-nyckel) ska ALDRIG kunna läsas ut i
    // klartext via det här generiska API:t, bara för att man råkar vara
    // inloggad. Maskerar de specifika känsliga fälten, men behåller
    // resten (t.ex. om det är påslaget, vilken adress) så gränssnittet
    // fortfarande kan visa "konfigurerat: ja/nej" korrekt.
    const SECRET_FIELDS = {
      "ow:emailconfig": ["appPassword"],
      "ow:kgkconfig": ["apiKey"],
    };
    if (SECRET_FIELDS[req.params.key] && r && r.value) {
      try {
        const cfg = JSON.parse(r.value);
        const masked = { ...cfg };
        for (const field of SECRET_FIELDS[req.params.key]) {
          if (masked[field]) { masked[`${field}Configured`] = true; delete masked[field]; }
        }
        return res.json({ ...r, value: JSON.stringify(masked) });
      } catch {}
    }
    res.json(r);
  } catch (e) { stats.errors++; res.status(500).json({ error: e.message }); }
});

app.post("/api/restore", async (req, res) => {
  try {
    stats.requests++;
    // SÄKERHET: återställning är en av de mest kraftfulla operationerna som
    // finns (kan skriva över hela lagret, alla användare, inställningar) —
    // ska bara kunna köras av admin, inte av en vanlig inloggad användare.
    const ok = await requireAdmin(req, res);
    if (!ok) return;
    if (!req.body || typeof req.body !== "object") {
      console.error("[FEL] restore: body tom eller ogiltig, typeof =", typeof req.body);
      return res.status(400).json({ error: "Ingen data mottogs (body tom)" });
    }
    const { items = [], sales = null, users = null, settings = null, suppliers = [], roles = null, lists = null, activitylog = null, favorites = null, trash = null, mode = "replace", first = false } = req.body;

    if (!Array.isArray(items)) {
      console.error("[FEL] restore: items är inte en lista, typeof =", typeof items, "värde:", JSON.stringify(items)?.slice(0,200));
      return res.status(400).json({ error: "items är inte en lista" });
    }
    if (items.length === 0) {
      console.error("[FEL] restore: tom batch mottagen, first =", first, "hela body-nycklar:", Object.keys(req.body));
      return res.status(400).json({ error: "Tom batch (0 delar mottogs)" });
    }

    // Dela upp items i lätt lista + bilder
    const lightItems = [];
    const imageRows = [];
    let skippedInvalidImages = 0;
    for (const it of items) {
      // SÄKERHET: samma bildvalidering som vid vanlig uppladdning — en
      // backup-fil skulle annars kunna vara ett sätt att smyga in en
      // ogiltig "bild" förbi den vanliga kontrollen. Ogiltiga bilder
      // hoppas bara över (delen sparas ändå), avbryter inte hela
      // återställningen för en enda dålig bild.
      const rawImgs = it.images || [];
      const imgs = rawImgs.filter(isValidImageDataUrl);
      skippedInvalidImages += rawImgs.length - imgs.length;
      const light = { ...it, images: [], hasImages: imgs.length };
      lightItems.push(light);
      if (imgs.length > 0) imageRows.push([it.id, JSON.stringify(imgs)]);
    }
    if (skippedInvalidImages > 0) {
      console.warn(`[restore] Hoppade över ${skippedInvalidImages} ogiltiga bilder`);
    }

    // Hämta befintlig lista (för append), eller börja om (för first batch)
    let existing = [];
    if (!first) {
      const row = await dbGet("ow:items");
      existing = row ? JSON.parse(row.value) : [];
    }
    const combined = existing.concat(lightItems);

    // SKYDD: backup-filer innehåller ALDRIG riktiga lösenord (de tas
    // medvetet bort vid export, av samma anledning som webbläsaren aldrig
    // får se lösenordshashar). Skriver vi över ow:users rakt av med det
    // skulle varje användares lösenord försvinna vid en återställning på
    // en miljö som redan har riktiga konton. Bevara därför befintlig hash
    // för varje användarnamn som redan finns, om den inkommande posten
    // saknar lösenord.
    let usersToWrite = users;
    if (users) {
      const existingUsersRow = await dbGet("ow:users");
      const existingUsers = existingUsersRow ? JSON.parse(existingUsersRow.value) : [];
      const byUsername = new Map(existingUsers.map(u => [u.username, u]));
      usersToWrite = users.map(u => {
        if (u.password) return u; // backupen hade faktiskt ett lösenord — använd det
        const prev = byUsername.get(u.username);
        return { ...u, password: prev?.password }; // annars, bevara befintligt om det finns
      });
    }

    await new Promise((resolve, reject) => {
      db.serialize(() => {
        db.run("BEGIN TRANSACTION");
        if (first) db.run("DELETE FROM images");
        const stmt = db.prepare("INSERT OR REPLACE INTO images(item_id,data,updated_at) VALUES(?,?,strftime('%s','now'))");
        for (const [id, data] of imageRows) stmt.run(id, data);
        stmt.finalize();
        db.run("INSERT OR REPLACE INTO store(key,value,updated_at) VALUES('ow:items',?,strftime('%s','now'))", [JSON.stringify(combined)]);
        if (sales) db.run("INSERT OR REPLACE INTO store(key,value,updated_at) VALUES('ow:sales',?,strftime('%s','now'))", [JSON.stringify(sales)]);
        if (users) db.run("INSERT OR REPLACE INTO store(key,value,updated_at) VALUES('ow:users',?,strftime('%s','now'))", [JSON.stringify(usersToWrite)]);
        if (settings) db.run("INSERT OR REPLACE INTO store(key,value,updated_at) VALUES('ow:settings',?,strftime('%s','now'))", [JSON.stringify(settings)]);
        if (suppliers && suppliers.length) db.run("INSERT OR REPLACE INTO store(key,value,updated_at) VALUES('ow:suppliers',?,strftime('%s','now'))", [JSON.stringify(suppliers)]);
        if (roles) db.run("INSERT OR REPLACE INTO store(key,value,updated_at) VALUES('ow:roles',?,strftime('%s','now'))", [JSON.stringify(roles)]);
        if (lists) db.run("INSERT OR REPLACE INTO store(key,value,updated_at) VALUES('ow:lists',?,strftime('%s','now'))", [JSON.stringify(lists)]);
        if (activitylog) db.run("INSERT OR REPLACE INTO store(key,value,updated_at) VALUES('ow:activitylog',?,strftime('%s','now'))", [JSON.stringify(activitylog)]);
        if (favorites) db.run("INSERT OR REPLACE INTO store(key,value,updated_at) VALUES('ow:favorites',?,strftime('%s','now'))", [JSON.stringify(favorites)]);
        if (trash) db.run("INSERT OR REPLACE INTO store(key,value,updated_at) VALUES('ow:trash',?,strftime('%s','now'))", [JSON.stringify(trash)]);
        db.run("COMMIT", (err) => err ? reject(err) : resolve());
      });
    });

    if (first) auditLog("restore", req.authUsername, { itemCount: combined.length });
    res.json({ ok: true, count: combined.length, items: combined });
  } catch (e) {
    stats.errors++;
    console.error("[FEL] restore:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/:key", async (req, res) => {
  try {
    stats.requests++;
    // SÄKERHET: bara admin får skriva över hela användar- eller rollistan.
    // Utan detta kunde VILKEN inloggad användare som helst (även en vanlig
    // lagerarbetare) posta ett eget, modifierat ow:users och t.ex. sätta
    // sin egen roll till "admin" — klientens dolda knappar/behörigheter
    // skyddar bara UI:t, aldrig det faktiska API:t.
    if (req.params.key === "ow:users" || req.params.key === "ow:roles") {
      // Undantag: bootstrap av en helt ny, tom installation (ingen
      // användare finns alls än) — annars kan ingen någonsin skapa det
      // allra första kontot. Skyddas ändå av huvudadmin-kontrollen nedan.
      const existingRow = await dbGet("ow:users");
      const existingUsers = existingRow ? JSON.parse(existingRow.value) : [];
      if (existingUsers.length > 0) {
        const ok = await requireAdmin(req, res);
        if (!ok) return;
      }
    }
    if (req.body.value === undefined) {
      return res.status(400).json({ error: "value saknas i body" });
    }
    // SKYDD: samma princip som för lösenord — klienten kan ha fått tillbaka
    // en MASKERAD version (se GET ovan, ...Configured:true istället för det
    // riktiga värdet). Sparar man då formuläret utan att ha skrivit in en NY
    // hemlighet ska den GAMLA, riktiga hemligheten bevaras — annars raderas
    // t.ex. Gmail-lösenordet bara för att man öppnade och stängde sidan.
    const SECRET_FIELDS = { "ow:emailconfig": ["appPassword"], "ow:kgkconfig": ["apiKey"] };
    if (SECRET_FIELDS[req.params.key]) {
      try {
        const incoming = JSON.parse(req.body.value);
        const existingRow = await dbGet(req.params.key);
        const existing = existingRow ? JSON.parse(existingRow.value) : {};
        for (const field of SECRET_FIELDS[req.params.key]) {
          if (!incoming[field] && existing[field]) incoming[field] = existing[field];
        }
        req.body.value = JSON.stringify(incoming);
        auditLog("config_change", req.authUsername, { key: req.params.key });
      } catch {}
    }
    // SKYDD: vägra skriva över ow:items med tom lista om det redan finns data
    if (req.params.key === "ow:items" && req.body.value === "[]") {
      const existing = await dbGet("ow:items");
      if (existing && existing.value && existing.value !== "[]" && existing.value.length > 10) {
        return res.status(400).json({ error: "Vägrar tömma befintligt lager" });
      }
    }
    // SKYDD: klienten har aldrig lösenordshasharna (de skickas aldrig dit),
    // så en vanlig sparning (t.ex. byter någons e-post) skulle annars
    // radera alla lösenord. Behåll befintlig hash om inget nytt lösenord
    // uttryckligen sätts via fältet "newPlainPassword" (hashas här, servern,
    // aldrig klienten).
    if (req.params.key === "ow:users") {
      try {
        const incoming = JSON.parse(req.body.value);
        const existingRow = await dbGet("ow:users");
        const existing = existingRow ? JSON.parse(existingRow.value) : [];
        const byId = new Map(existing.map(u => [u.id, u]));
        const merged = incoming.map(u => {
          const prev = byId.get(u.id);
          const { newPlainPassword, ...rest } = u;
          if (newPlainPassword) {
            return { ...rest, password: hashPasswordServer(newPlainPassword) };
          }
          return { ...rest, password: prev?.password };
        });
        // SKYDD: måste alltid finnas minst en huvudadmin (admin utan
        // tilldelat hemmalager) — annars kan ingen längre hantera hela
        // systemet eller skapa fler admins. Detta är den riktiga spärren
        // (klientens kontroller kan kringgås, den här kan det inte).
        // Undantag: om det ALDRIG funnits några användare (bootstrap av en
        // helt ny installation) tillåts det, annars skulle första
        // installationen aldrig kunna komma igång.
        const hadUsersBefore = existing.length > 0;
        const huvudadminCount = merged.filter(u => u.role==="admin" && !u.homeWarehouse).length;
        if (hadUsersBefore && huvudadminCount === 0) {
          return res.status(400).json({ error: "Går inte — måste finnas minst en huvudadmin (admin utan tilldelat hemmalager)." });
        }
        // Audit-logg — upptäcker och loggar just ROLLÄNDRINGAR specifikt
        // (jämför varje användares nya roll mot den de hade innan), inte
        // bara att "något" i listan sparades. Det här är den känsligaste
        // typen av ändring som finns i hela systemet.
        for (const u of merged) {
          const prev = byId.get(u.id);
          if (prev && prev.role !== u.role) {
            auditLog("role_change", req.authUsername, { targetUser: u.username, from: prev.role, to: u.role });
          }
        }
        req.body.value = JSON.stringify(merged);
      } catch (e) {
        return res.status(400).json({ error: "Ogiltig användardata: " + e.message });
      }
    }
    // Stor-köp-mejl — upptäcks HÄR (server-side, redan inloggningskrävande),
    // genom att jämföra de nya försäljningarna mot de som redan fanns sen
    // innan. Ligger INTE bakom ett separat, publikt API-anrop längre — det
    // skulle annars låta VEM SOM HELST på internet trigga falska
    // "stort köp"-mejl till admin utan att någon försäljning alls skett.
    if (req.params.key === "ow:sales") {
      try {
        const incoming = JSON.parse(req.body.value);
        const existingRow = await dbGet("ow:sales");
        const existing = existingRow ? JSON.parse(existingRow.value) : [];
        const existingIds = new Set(existing.map(s => s.id));
        const newSales = incoming.filter(s => s.id && !existingIds.has(s.id));
        if (newSales.length) {
          const cfg = await getEmailConfig();
          const threshold = cfg?.largePurchaseThreshold ?? 10000;
          for (const sale of newSales) {
            if ((sale.total || 0) >= threshold) {
              sendNotification("largePurchase", `Stort köp genomfört — ${Number(sale.total).toLocaleString("sv-SE")} kr`,
                `<p>Ett köp på <strong>${Number(sale.total).toLocaleString("sv-SE")} kr</strong> genomfördes.</p>
                 <p>Kund: ${sale.buyer || "Okänd"}<br>Säljare: ${sale.soldBy || req.authUsername || "Okänd"}</p>`
              ).catch(()=>{});
            }
          }
        }
      } catch {}
    }
    await dbSet(req.params.key, req.body.value);
    res.json({ ok: true });
  } catch (e) {
    stats.errors++;
    console.error(`[FEL] POST /api/${req.params.key}:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/:key", async (req, res) => {
  try {
    await dbDel(req.params.key);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Item-level operations (undviker att skriva över andras ändringar) ─────────
// Uppdatera/lägg till EN artikel
app.post("/api/item/upsert", async (req, res) => {
  try {
    stats.requests++;
    const item = req.body.item;
    if (!item || !item.id) return res.status(400).json({ error: "item.id krävs" });
    const row = await dbGet("ow:items");
    const items = row ? JSON.parse(row.value) : [];
    const idx = items.findIndex(i => i.id === item.id);
    if (idx >= 0) items[idx] = item;
    else items.push(item);
    await dbSet("ow:items", JSON.stringify(items));
    res.json({ ok: true, items });
  } catch (e) { stats.errors++; res.status(500).json({ error: e.message }); }
});

// Ta bort EN artikel
app.post("/api/item/delete", async (req, res) => {
  try {
    stats.requests++;
    const id = req.body.id;
    const row = await dbGet("ow:items");
    const items = row ? JSON.parse(row.value) : [];
    const filtered = items.filter(i => i.id !== id);
    await dbSet("ow:items", JSON.stringify(filtered));
    // Ta bort eventuella bilder också
    db.run("DELETE FROM images WHERE item_id=?", [id]);
    res.json({ ok: true, items: filtered });
  } catch (e) { stats.errors++; res.status(500).json({ error: e.message }); }
});

// Mjuk borttagning — tas bort från lagerlistan men BILDERNA BEHÅLLS på servern,
// så att artikeln kan återställas helt (med bilder) från papperskorgen.
// Skiljer sig från /api/item/delete ovan endast genom att inte röra images-tabellen.
app.post("/api/item/soft-delete", async (req, res) => {
  try {
    stats.requests++;
    const id = req.body.id;
    const row = await dbGet("ow:items");
    const items = row ? JSON.parse(row.value) : [];
    const filtered = items.filter(i => i.id !== id);
    await dbSet("ow:items", JSON.stringify(filtered));
    res.json({ ok: true, items: filtered });
  } catch (e) { stats.errors++; res.status(500).json({ error: e.message }); }
});

// ── REDIGERINGSLÅS ────────────────────────────────────────────────────────────
// Hålls i minnet (snabbt, ingen databas-overhead). Map: itemId → {user, action, ts}
// action: "edit" (redigerar) | "cart" (ligger i kassan)
const LOCK_TIMEOUT_MS = 20 * 60 * 1000; // 20 minuter
const locks = new Map();
// Vem väntar på en del: itemId → { user, ts } (för att meddela första användaren)
const waiting = new Map();

function lockInfo(itemId) {
  const lock = locks.get(itemId);
  if (!lock) return null;
  const age = Date.now() - lock.ts;
  if (age > LOCK_TIMEOUT_MS) { locks.delete(itemId); return null; } // utgånget lås
  return { ...lock, remainingMs: LOCK_TIMEOUT_MS - age };
}

// Försök ta ett lås. Returnerar {ok:true} eller {ok:false, lock:{...}} om upptaget.
app.post("/api/lock/acquire", (req, res) => {
  const { itemId, user, action } = req.body || {};
  if (!itemId || !user) return res.status(400).json({ error: "itemId och user krävs" });
  const existing = lockInfo(itemId);
  if (existing && existing.user !== user) {
    // Upptaget av någon annan — registrera att denna user väntar
    waiting.set(itemId, { user, ts: Date.now() });
    return res.json({
      ok: false,
      lockedBy: existing.user,
      action: existing.action,
      remainingMs: existing.remainingMs,
    });
  }
  // Ledigt eller redan mitt eget lås — ta/förnya det
  locks.set(itemId, { user, action: action || "edit", ts: Date.now() });
  res.json({ ok: true });
});

// Släpp ett lås (när man sparar/går ut)
app.post("/api/lock/release", (req, res) => {
  const { itemId, user } = req.body || {};
  const lock = locks.get(itemId);
  if (lock && lock.user === user) locks.delete(itemId);
  waiting.delete(itemId);
  res.json({ ok: true });
});

// Förnya lås (håll det vid liv medan man jobbar) + kolla om någon väntar
app.post("/api/lock/heartbeat", (req, res) => {
  const { itemId, user } = req.body || {};
  const lock = locks.get(itemId);
  if (lock && lock.user === user) {
    lock.ts = Date.now();
    const w = waiting.get(itemId);
    return res.json({ ok: true, waitingUser: w && w.user !== user ? w.user : null });
  }
  res.json({ ok: false }); // låset är inte längre mitt
});

// Kolla låsstatus för en eller flera delar
app.post("/api/lock/status", (req, res) => {
  const ids = req.body.ids || [];
  const result = {};
  for (const id of ids) {
    const info = lockInfo(id);
    if (info) result[id] = { user: info.user, action: info.action, remainingMs: info.remainingMs };
  }
  res.json({ locks: result });
});

// ── Bilder — hämta bilder för EN artikel ──────────────────────────────────────
// SÄKERHET: kontrollerar att en bild-dataURL faktiskt ÄR den bildtyp den
// påstår sig vara — läser de riktiga "magiska byten" i början av filen,
// inte bara den påstådda MIME-typen i själva dataURL-strängen (som går
// att förfalska helt fritt, eftersom bilder skickas som data: URLs direkt
// i JSON, inte som riktiga filuppladdningar). Utan detta skulle någon
// kunna spara t.ex. "data:text/html;base64,<skadlig HTML/JS>" som en
// "bild", och om den sidan sen öppnas direkt (t.ex. /api/img/ID i en ny
// flik) skulle webbläsaren visa/köra den som HTML istället för en bild.
const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8MB per bild — gott om marginal, se compressImage i klienten
function isValidImageDataUrl(dataUrl) {
  if (typeof dataUrl !== "string") return false;
  const m = dataUrl.match(/^data:([^;]+);base64,(.*)$/);
  if (!m) return false;
  const declaredType = m[1].toLowerCase();
  if (!["image/jpeg", "image/png", "image/webp"].includes(declaredType)) return false;
  let buf;
  try { buf = Buffer.from(m[2], "base64"); } catch { return false; }
  if (buf.length === 0 || buf.length > MAX_IMAGE_BYTES) return false;
  // Riktiga magiska byte-signaturer — går inte att förfalska bara genom
  // att ändra MIME-typ-texten i dataURL:en, byten måste faktiskt stämma.
  const isJpeg = buf[0]===0xFF && buf[1]===0xD8 && buf[2]===0xFF;
  const isPng  = buf[0]===0x89 && buf[1]===0x50 && buf[2]===0x4E && buf[3]===0x47;
  const isWebp = buf.length>12 && buf.toString("ascii",0,4)==="RIFF" && buf.toString("ascii",8,12)==="WEBP";
  if (declaredType==="image/jpeg" && !isJpeg) return false;
  if (declaredType==="image/png" && !isPng) return false;
  if (declaredType==="image/webp" && !isWebp) return false;
  return true;
}

app.get("/api/images/:id", (req, res) => {
  db.get("SELECT data FROM images WHERE item_id=?", [req.params.id], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ images: row ? JSON.parse(row.data) : [] });
  });
});

// Spara bilder för EN artikel
app.post("/api/images/:id", (req, res) => {
  const imgs = req.body.images || [];
  // SÄKERHET: varje bild valideras — riktig JPEG/PNG/WebP, rimlig storlek.
  // Sparar ALDRIG in något som inte klarar kontrollen, oavsett vad
  // klienten skickar (bilder kan i teorin skickas direkt till API:t,
  // förbi klientens egen komprimering/kontroll).
  if (imgs.length > 0 && !imgs.every(isValidImageDataUrl)) {
    return res.status(400).json({ error: "En eller flera bilder är ogiltiga (måste vara riktig JPEG/PNG/WebP, max 8MB per bild)." });
  }
  if (imgs.length === 0) {
    db.run("DELETE FROM images WHERE item_id=?", [req.params.id], () => res.json({ ok: true }));
  } else {
    db.run("INSERT OR REPLACE INTO images(item_id,data,updated_at) VALUES(?,?,strftime('%s','now'))",
      [req.params.id, JSON.stringify(imgs)], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ ok: true });
      });
  }
});

// ── Bild som CACHEBAR fil ─────────────────────────────────────────────────────
// Serverar EN bild som riktiga bytes med lång cache. Webbläsaren cachar den och
// hämtar den ALDRIG igen så länge URL:en är samma. URL:en innehåller ?v=<tid>
// så den uppdateras automatiskt när bilden ändras (cache-busting).
// /api/img/:id        → första bilden för artikeln
// /api/img/:id/:idx   → bild med visst index
app.get("/api/img/:id", (req, res) => sendImage(req, res, 0));
app.get("/api/img/:id/:idx", (req, res) => sendImage(req, res, parseInt(req.params.idx || "0", 10) || 0));

function sendImage(req, res, idx) {
  db.get("SELECT data FROM images WHERE item_id=?", [req.params.id], (err, row) => {
    if (err || !row) return res.status(404).end();
    let imgs;
    try { imgs = JSON.parse(row.data); } catch { return res.status(404).end(); }
    const dataUrl = imgs[idx];
    if (!dataUrl || typeof dataUrl !== "string") return res.status(404).end();
    const m = dataUrl.match(/^data:([^;]+);base64,(.*)$/);
    if (!m) return res.status(404).end();
    // SÄKERHET: kontrollerar att den DEKLARERADE typen faktiskt är en bild
    // innan den sätts som Content-Type — annars skulle en förfalskad typ
    // (t.ex. "text/html") kunna få webbläsaren att köra innehållet som
    // HTML/JS istället för att visa det som en bild. Görs medvetet lite
    // enklare här än vid uppladdning (bara typ-kontroll, inte fullständig
    // byte-signaturkontroll) — det viktiga är att stänga just den risken
    // utan att riskera att blockera befintliga, redan sparade bilder som
    // laddades upp innan den striktare kontrollen fanns.
    if (!["image/jpeg", "image/png", "image/webp", "image/gif"].includes(m[1].toLowerCase())) {
      return res.status(404).end();
    }
    const buf = Buffer.from(m[2], "base64");
    res.set("Content-Type", m[1]);
    res.set("Cache-Control", "public, max-age=31536000, immutable");
    res.send(buf);
  });
}

// ── SNABB BULK-RESTORE — tar emot backup i batchar, delar upp på servern ─────

// ── Admin ─────────────────────────────────────────────────────────────────────
// ── Hälsokontroll för externa övervakningsverktyg (t.ex. n8n) ──────────────
const HEALTHCHECK_TOKEN = process.env.HEALTHCHECK_TOKEN || null;
app.get("/admin/api/healthcheck", async (req, res) => {
  try {
    if (HEALTHCHECK_TOKEN && req.query.token !== HEALTHCHECK_TOKEN) {
      return res.status(401).json({ ok:false, error:"Ogiltig eller saknad token." });
    }
    const BACKUP_DIR = getBackupDir();
    let lastBackupDate = null, lastBackupAgeHours = null, backupFileCount = 0;
    try {
      const files = fs.readdirSync(BACKUP_DIR)
        .filter(f => f.startsWith("auto_backup_") && f.endsWith(".json"))
        .sort();
      backupFileCount = files.length;
      if (files.length) {
        const newest = files[files.length - 1];
        const stat = fs.statSync(path.join(BACKUP_DIR, newest));
        lastBackupDate = newest.replace("auto_backup_","").replace(".json","");
        lastBackupAgeHours = Math.round((Date.now() - stat.mtimeMs) / 36e5);
      }
    } catch (e) { /* backup-mappen saknas eller går inte att läsa — fångas nedan */ }
    const backupOk = lastBackupAgeHours !== null && lastBackupAgeHours < 200;
    const [itemsRow, usersRow, salesRow] = await Promise.all([
      dbGet("ow:items"), dbGet("ow:users"), dbGet("ow:sales")
    ]);
    const itemCount = itemsRow ? (JSON.parse(itemsRow.value)||[]).length : 0;
    const userCount = usersRow ? (JSON.parse(usersRow.value)||[]).length : 0;
    const salesCount = salesRow ? (JSON.parse(salesRow.value)||[]).length : 0;
    const dbOk = itemsRow !== null && usersRow !== null;
    const uptimeSeconds = Math.floor(process.uptime());
    const ok = backupOk && dbOk;
    res.json({
      ok,
      checkedAt: new Date().toISOString(),
      backup: { ok: backupOk, lastBackupDate, lastBackupAgeHours, backupFileCount, backupDir: BACKUP_DIR },
      database: { ok: dbOk, itemCount, userCount, salesCount },
      server: { uptimeSeconds, node: process.version },
    });
  } catch (e) {
    res.status(500).json({ ok:false, error: e.message });
  }
});

app.get("/admin/api/status", async (req, res) => {
  const uptimeS = Math.floor((Date.now() - stats.started) / 1000);
  const h = Math.floor(uptimeS / 3600);
  const m = Math.floor((uptimeS % 3600) / 60);
  const s = uptimeS % 60;
  const dbSize = (() => { try { return fs.statSync(DB_PATH).size; } catch { return 0; } })();
  const ips = Object.values(os.networkInterfaces()).flat()
    .filter(i => i.family === "IPv4" && !i.internal).map(i => i.address);

  const [itemsRow, usersRow, salesRow, activityRow] = await Promise.all([
    dbGet("ow:items"), dbGet("ow:users"), dbGet("ow:sales"), dbGet("ow:activitylog")
  ]);
  const items = itemsRow ? JSON.parse(itemsRow.value) : [];
  const users = usersRow ? JSON.parse(usersRow.value) : [];
  const sales = salesRow ? JSON.parse(salesRow.value) : [];
  const activity = activityRow ? JSON.parse(activityRow.value) : [];

  // Försäljning idag och denna vecka
  const now = Date.now();
  const startOfDay = new Date(); startOfDay.setHours(0,0,0,0);
  const weekAgo = now - 7*864e5;
  const salesToday = sales.filter(s => (s.soldAt||0) >= startOfDay.getTime());
  const salesWeek = sales.filter(s => (s.soldAt||0) >= weekAgo);
  const lowStock = items.filter(i => (i.quantity||0) <= 3).length;
  const reservedCount = items.reduce((a,i)=>a+((i.reservations&&i.reservations.length)||0),0);
  const totalQty = items.reduce((a,i)=>a+(i.quantity||0),0);

  // Aktiva enheter senaste 5 minuterna
  const activeWindow = now - 5*60*1000;
  const activeDevices = [...devices.values()].filter(d => d.lastSeen >= activeWindow).length;

  res.json({
    uptime: `${h}t ${m}m ${s}s`,
    uptimeSeconds: uptimeS,
    requests: stats.requests, errors: stats.errors,
    dbSize: (dbSize/1024).toFixed(1)+" KB",
    dbSizeBytes: dbSize,
    items: items.length, users: users.length, sales: sales.length,
    ips, port: PORT,
    totalValue: items.reduce((a,i)=>a+(i.price||0)*(i.quantity||0),0),
    salesTotal: sales.reduce((a,s)=>a+(s.total||0),0),
    salesTodayCount: salesToday.length,
    salesTodayValue: salesToday.reduce((a,s)=>a+(s.total||0),0),
    salesWeekCount: salesWeek.length,
    salesWeekValue: salesWeek.reduce((a,s)=>a+(s.total||0),0),
    lowStock, reservedCount, totalQty,
    activeDevices,
    activityCount: activity.length,
    recentReqs: [],
  });
});

// Anslutna enheter + live-flöde (för admin-panelen)
app.get("/admin/api/devices", (req, res) => {
  const now = Date.now();
  const list = [...devices.values()]
    .sort((a,b) => b.lastSeen - a.lastSeen)
    .map(d => ({
      ip: d.ip,
      user: d.user,
      count: d.count,
      lastSeenAgo: Math.floor((now - d.lastSeen)/1000),
      firstSeen: d.firstSeen,
      active: (now - d.lastSeen) < 5*60*1000,
      device: guessDevice(d.userAgent),
    }));
  res.json({ devices: list, feed: liveFeed.slice(0, MAX_FEED) });
});

// Visar den serverstyrda audit-loggen (inloggningar, rolländringar,
// återställningar, konfigurationsändringar) — kräver adminroll precis
// som resten av /admin/api/* automatiskt gör (se mellanlagret ovan).
app.get("/admin/api/audit-log", async (req, res) => {
  try {
    const row = await dbGet("ow:serverauditlog");
    const log = row ? JSON.parse(row.value) : [];
    res.json({ ok:true, log: log.slice(0, 500) });
  } catch (e) {
    res.status(500).json({ ok:false, error: e.message });
  }
});

// Frontend rapporterar en händelse (köp, ändring m.m.) till live-flödet
app.post("/admin/api/event", (req, res) => {
  const { type, description, user } = req.body || {};
  if (!type || !description) return res.status(400).json({ error: "type och description krävs" });
  liveFeed.unshift({ type, description, user: user||null, ip: clientIp(req), ts: Date.now() });
  if (liveFeed.length > MAX_FEED) liveFeed.length = MAX_FEED;
  res.json({ ok: true });
});

// ── E-postnotiser: händelser som klienten inte kan avgöra själv ska mejlas ──
// (stora köp, misslyckade inloggningar). Servern avgör tröskelvärden och
// skickar. OBS: detta gjordes TIDIGARE via en separat, publik endpoint
// (/admin/api/notify) som klienten anropade efter en lyckad/misslyckad
// åtgärd — men det innebar att VEM SOM HELST på internet, utan att ens
// logga in, kunde posta dit direkt och trigga falska varningsmejl om
// "stora köp" eller "misslyckade inloggningar" som aldrig hänt. Logiken
// bor nu istället DIREKT i /api/login (misslyckade försök) och i den
// generiska ow:sales-skrivningen ovan (stora köp) — båda kräver redan
// autentisering (eller är i sig själva inloggnings-endpointen), så det
// finns ingen publik attackyta kvar för detta.
const failedLogins = {};

// Mejlar SPECIFIKA användare (inte den fasta admin-adressen) — används när
// någon reserverar en del i ett annat lager än sitt eget, så rätt personal
// på det lagret får veta direkt. Mottagarna är de användare vars
// homeWarehouse matchar delens lager OCH som själva satt på
// "Mejla mig vid reservationer från andra lager" i sin användarprofil.
app.post("/admin/api/notify-warehouse-reservation", async (req, res) => {
  try {
    const { warehouse, itemName, stockNumber, oem, location, customer, regNumber, reservedBy } = req.body || {};
    if (!warehouse) return res.status(400).json({ ok:false, error:"Inget lager angivet." });

    const cfg = await getEmailConfig();
    if (!cfg || !cfg.enabled || !cfg.fromEmail || !cfg.appPassword) return res.json({ ok:true, sent:0 }); // e-post ej konfigurerat — inget att göra
    if (cfg.notifTypes && cfg.notifTypes.warehouseReservation === false) return res.json({ ok:true, sent:0 });

    const usersRow = await dbGet("ow:users");
    const users = usersRow ? JSON.parse(usersRow.value) : [];
    const recipients = users.filter(u => u.homeWarehouse === warehouse && u.notifyOtherWarehouseReservations && u.email);
    if (!recipients.length) return res.json({ ok:true, sent:0 });

    const transport = makeTransport(cfg);
    const bodyHtml = `<div style="font-family:sans-serif;font-size:14px;color:#141820">
      <p><strong>${reservedBy||"Någon"}</strong> har reserverat en del i <strong>${warehouse}</strong>:</p>
      <table style="border-collapse:collapse;margin:12px 0">
        <tr><td style="padding:4px 12px 4px 0;color:#8A90A0">Del</td><td style="padding:4px 0;font-weight:600">${itemName||"—"}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#8A90A0">Lagernummer</td><td style="padding:4px 0;font-weight:600">#${stockNumber||"—"}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#8A90A0">Artikelnummer</td><td style="padding:4px 0;font-family:monospace">${oem||"—"}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#8A90A0">Placering</td><td style="padding:4px 0">${location||"—"}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#8A90A0">Kund</td><td style="padding:4px 0">${customer||"—"} ${regNumber?`(${regNumber})`:""}</td></tr>
      </table>
      <p style="color:#94a3b8;font-size:11px;margin-top:16px">Skickat automatiskt av Lager-systemet · ${new Date().toLocaleString("sv-SE")}</p>
    </div>`;

    let sent = 0;
    for (const u of recipients) {
      try {
        await transport.sendMail({
          from: `"Lager" <${cfg.fromEmail}>`,
          to: u.email,
          subject: `[Lager] Reservation i ${warehouse} — #${stockNumber||"?"}`,
          html: bodyHtml,
        });
        sent++;
      } catch (e) {
        console.error(`[email] Kunde inte mejla ${u.email}:`, e.message);
      }
    }
    console.log(`[email] Reservationsnotis skickad till ${sent} mottagare i ${warehouse}`);
    res.json({ ok:true, sent });
  } catch (e) {
    res.status(500).json({ ok:false, error: e.message });
  }
});

// Testmejl så admin kan verifiera att inställningarna stämmer
app.get("/admin/api/email-test", async (req, res) => {
  try {
    const cfg = await getEmailConfig();
    if (!cfg || !cfg.fromEmail || !cfg.appPassword || !cfg.adminEmail) {
      return res.status(400).json({ ok:false, error: "Fyll i avsändare, app-lösenord och mottagare först." });
    }
    const transport = makeTransport(cfg);
    await transport.sendMail({
      from: `"Lager" <${cfg.fromEmail}>`,
      to: cfg.adminEmail,
      subject: "[Lager] Testmejl",
      html: `<div style="font-family:sans-serif;font-size:14px">Det här är ett testmejl från Lager-systemet. Om du ser det här fungerar e-postinställningarna korrekt.</div>`,
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok:false, error: e.message });
  }
});

function guessDevice(ua) {
  if (!ua) return "Okänd";
  if (/iphone|ipad|ipod/i.test(ua)) return "iPhone/iPad";
  if (/android/i.test(ua)) return "Android";
  if (/windows/i.test(ua)) return "Windows";
  if (/macintosh|mac os/i.test(ua)) return "Mac";
  if (/linux/i.test(ua)) return "Linux";
  return "Okänd";
}

app.post("/admin/api/restart", (req, res) => {
  res.json({ ok: true });
  setTimeout(() => process.exit(0), 500);
});

// Manuell trigger för automatisk backup (test)
app.get("/admin/api/backup-now", async (req, res) => {
  try {
    await runBackup();
    res.json({ ok: true, message: "Backup skapad i backups-mappen" });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/admin", (req, res) => {
  // Admin-panelen är en separat, mindre sida med ett eget inline-skript
  // (och ett eget skydd — Basic Auth via ADMIN_PANEL_PASSWORD). Den
  // strikta CSP:n ovan (ingen 'unsafe-inline' för script-src) skulle
  // annars blockera det skriptet helt. Ger den här EN sidan en egen,
  // något mer tillåtande policy istället för att försvaga skyddet för
  // HELA appen bara för den här enda, adminlösenordsskyddade sidan.
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'");
  res.send(`<!DOCTYPE html><html lang="sv"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Lager Admin</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,-apple-system,sans-serif;background:#EEF1F5;color:#1a1a2e;padding-bottom:40px}
.header{background:linear-gradient(135deg,#1B3A6B,#CC1B2B);color:#fff;padding:18px 24px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:10}
.title{font-size:20px;font-weight:800;display:flex;align-items:center;gap:10px}
.dot{width:9px;height:9px;border-radius:50%;background:#34d399;box-shadow:0 0 0 0 rgba(52,211,153,.7);animation:pulse 2s infinite}
@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(52,211,153,.6)}70%{box-shadow:0 0 0 8px rgba(52,211,153,0)}100%{box-shadow:0 0 0 0 rgba(52,211,153,0)}}
.container{max-width:1000px;margin:0 auto;padding:20px 16px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:18px}
.card{background:#fff;border-radius:12px;padding:15px;border:1px solid #e2e8f0;box-shadow:0 1px 3px rgba(0,0,0,.04)}
.label{font-size:10px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px}
.value{font-size:26px;font-weight:800;color:#1B3A6B;line-height:1.1}
.value.green{color:#16a34a}.value.amber{color:#d97706}.value.red{color:#CC1B2B}
.sub{font-size:11px;color:#94a3b8;margin-top:3px}
.section{background:#fff;border-radius:12px;border:1px solid #e2e8f0;margin-bottom:16px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.04)}
.sh{padding:13px 18px;border-bottom:1px solid #eef1f5;font-weight:700;font-size:13px;background:#fafbfc;display:flex;align-items:center;justify-content:space-between}
.sb{padding:14px 18px}
.row{display:flex;justify-content:space-between;align-items:center;padding:9px 0;border-bottom:1px solid #f5f7fa;font-size:13px}
.row:last-child{border:none}
.chip{background:#1B3A6B15;color:#1B3A6B;padding:5px 11px;border-radius:6px;font-size:12px;font-weight:700;font-family:monospace;margin:2px;display:inline-block;cursor:pointer}
.chip:hover{background:#1B3A6B25}
.btn{padding:9px 16px;border-radius:8px;font-weight:700;font-size:13px;cursor:pointer;border:none;display:inline-flex;align-items:center;gap:6px}
.btn-red{background:#CC1B2B;color:#fff}.btn-blue{background:#1B3A6B;color:#fff}.btn-ghost{background:#fff;color:#1B3A6B;border:1.5px solid #d7dee8}
.btn:active{transform:translateY(1px)}
.app-link{display:inline-flex;align-items:center;gap:6px;background:rgba(255,255,255,.2);color:#fff;padding:9px 16px;border-radius:8px;text-decoration:none;font-weight:700;font-size:13px}
.dev{display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid #f5f7fa;font-size:13px}
.dev:last-child{border:none}
.dev .ip{font-family:monospace;font-weight:700;color:#1B3A6B}
.badge{font-size:10px;font-weight:700;padding:2px 8px;border-radius:10px}
.badge.on{background:#dcfce7;color:#16a34a}.badge.off{background:#f1f5f9;color:#94a3b8}
.feed-item{display:flex;gap:10px;padding:9px 0;border-bottom:1px solid #f5f7fa;font-size:13px;align-items:flex-start}
.feed-item:last-child{border:none}
.feed-ico{width:26px;height:26px;border-radius:7px;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:12px}
.muted{color:#94a3b8;font-size:11px}
.toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#1B3A6B;color:#fff;padding:11px 20px;border-radius:8px;font-size:13px;font-weight:600;opacity:0;transition:opacity .3s;z-index:50}
.toast.show{opacity:1}
.controls{display:flex;gap:10px;flex-wrap:wrap}
.empty{text-align:center;color:#94a3b8;padding:24px;font-size:13px}
</style>
</head><body>
<div class="header">
  <div class="title"><span class="dot"></span> Lager Admin</div>
  <a href="/" class="app-link">Öppna app →</a>
</div>

<!-- Inloggningsgrind — visas tills ett giltigt admin-konto är inloggat.
     Använder SAMMA inloggning som huvudappen (/api/login). -->
<div id="loginGate" style="display:none;max-width:340px;margin:60px auto;padding:0 16px">
  <div style="background:#fff;border-radius:14px;padding:28px;border:1px solid #e2e8f0;box-shadow:0 4px 16px rgba(0,0,0,.06)">
    <div style="font-weight:800;font-size:17px;margin-bottom:4px;color:#1B3A6B">Logga in</div>
    <div style="font-size:12.5px;color:#94a3b8;margin-bottom:18px">Kräver ett admin-konto i Lager</div>
    <input id="loginUser" placeholder="Användarnamn" style="width:100%;padding:10px 12px;border:1.5px solid #d7dee8;border-radius:7px;font-size:14px;margin-bottom:10px;box-sizing:border-box">
    <input id="loginPass" type="password" placeholder="Lösenord" style="width:100%;padding:10px 12px;border:1.5px solid #d7dee8;border-radius:7px;font-size:14px;margin-bottom:10px;box-sizing:border-box">
    <div id="loginError" style="display:none;color:#CC1B2B;font-size:12.5px;font-weight:600;margin-bottom:10px"></div>
    <button class="btn btn-blue" style="width:100%;justify-content:center" onclick="doAdminLogin()">Logga in</button>
  </div>
</div>

<div class="container" id="mainContainer" style="display:none">

  <div class="grid">
    <div class="card"><div class="label">Drifttid</div><div class="value" id="uptime">—</div></div>
    <div class="card"><div class="label">Aktiva enheter</div><div class="value green" id="activeDev">—</div><div class="sub">senaste 5 min</div></div>
    <div class="card"><div class="label">Artiklar</div><div class="value" id="items">—</div><div class="sub" id="totalQty"></div></div>
    <div class="card"><div class="label">Lagervärde</div><div class="value green" id="val">—</div></div>
  </div>

  <div class="grid">
    <div class="card"><div class="label">Försäljning idag</div><div class="value" id="salesToday">—</div><div class="sub" id="salesTodayVal"></div></div>
    <div class="card"><div class="label">Senaste 7 dagar</div><div class="value" id="salesWeek">—</div><div class="sub" id="salesWeekVal"></div></div>
    <div class="card"><div class="label">Lågt lager</div><div class="value amber" id="lowStock">—</div><div class="sub">≤ 3 i lager</div></div>
    <div class="card"><div class="label">Reserverade</div><div class="value" id="reserved">—</div></div>
  </div>

  <div class="section">
    <div class="sh">Serverstyrning</div>
    <div class="sb">
      <div class="controls">
        <button class="btn btn-blue" onclick="doBackup(this)"><span>💾</span> Skapa backup nu</button>
        <button class="btn btn-red" onclick="doRestart(this)"><span>🔄</span> Starta om servern</button>
        <button class="btn btn-ghost" onclick="load()"><span>↻</span> Uppdatera</button>
        <button class="btn btn-ghost" onclick="adminLogout()"><span>🚪</span> Logga ut</button>
      </div>
      <div class="muted" style="margin-top:10px">Backup sparas i backup-mappen. Omstart tar några sekunder — appen kommer tillbaka automatiskt.</div>
    </div>
  </div>

  <div class="section">
    <div class="sh"><span>Anslutna enheter</span><span class="muted" id="devCount"></span></div>
    <div class="sb" id="devices"><div class="empty">Laddar…</div></div>
  </div>

  <div class="section">
    <div class="sh"><span>Live-aktivitet</span><span class="muted">uppdateras automatiskt</span></div>
    <div class="sb" id="feed"><div class="empty">Ingen aktivitet ännu</div></div>
  </div>

  <div class="section">
    <div class="sh">Serverinfo</div>
    <div class="sb">
      <div class="row"><span>Databasstorlek</span><span id="db">—</span></div>
      <div class="row"><span>Antal anrop sedan start</span><span id="reqs">—</span></div>
      <div class="row"><span>Fel sedan start</span><span id="errs">—</span></div>
      <div class="row"><span>Användare</span><span id="users">—</span></div>
      <div class="row"><span>Totalt antal försäljningar</span><span id="salesTotal">—</span></div>
      <div class="row"><span>Nätverksadresser</span><div id="ips" style="text-align:right"></div></div>
    </div>
  </div>

</div>
<div class="toast" id="toast"></div>
<script>
// ── Inloggning — samma /api/login som huvudappen, token sparas lokalt ──────
const ADMIN_TOKEN_KEY = 'lager_admin_token';
let ADMIN_TOKEN = localStorage.getItem(ADMIN_TOKEN_KEY) || null;
// Patchar window.fetch globalt så ALLA /admin/api/*-anrop nedan automatiskt
// får med token — enda stället som behöver ändras, istället för varje
// enskilt fetch-anrop i filen.
const _origFetch = window.fetch.bind(window);
window.fetch = (url, opts={}) => {
  if (typeof url === 'string' && url.startsWith('/admin/api/') && !url.includes('healthcheck') && ADMIN_TOKEN) {
    opts = { ...opts, headers: { ...(opts.headers||{}), 'Authorization': 'Bearer ' + ADMIN_TOKEN } };
  }
  return _origFetch(url, opts);
};

async function doAdminLogin(){
  const u = document.getElementById('loginUser').value.trim();
  const p = document.getElementById('loginPass').value;
  const errEl = document.getElementById('loginError');
  errEl.style.display = 'none';
  if (!u || !p) { errEl.textContent = 'Fyll i både användarnamn och lösenord'; errEl.style.display = 'block'; return; }
  try {
    const r = await _origFetch('/api/login', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({username:u,password:p}) }).then(r=>r.json());
    if (!r.ok) { errEl.textContent = r.error || 'Fel inloggningsuppgifter'; errEl.style.display = 'block'; return; }
    if (r.user.role !== 'admin') { errEl.textContent = 'Kontot har inte adminbehörighet'; errEl.style.display = 'block'; return; }
    ADMIN_TOKEN = r.token;
    localStorage.setItem(ADMIN_TOKEN_KEY, r.token);
    showDashboard();
  } catch (e) {
    errEl.textContent = 'Kunde inte nå servern'; errEl.style.display = 'block';
  }
}
function adminLogout(){
  localStorage.removeItem(ADMIN_TOKEN_KEY);
  ADMIN_TOKEN = null;
  location.reload();
}
function showDashboard(){
  document.getElementById('loginGate').style.display = 'none';
  document.getElementById('mainContainer').style.display = 'block';
  startPolling();
}
// Vid start: har vi en token, testa den direkt (misslyckas den — t.ex.
// utgången session — visas inloggningsrutan igen).
(async function initAuth(){
  if (!ADMIN_TOKEN) { document.getElementById('loginGate').style.display='block'; return; }
  try {
    const res = await fetch('/admin/api/status');
    if (res.status === 401 || res.status === 403) {
      localStorage.removeItem(ADMIN_TOKEN_KEY); ADMIN_TOKEN = null;
      document.getElementById('loginGate').style.display = 'block';
    } else {
      showDashboard();
    }
  } catch (e) {
    document.getElementById('loginGate').style.display = 'block';
  }
})();

const kr = n => (n||0).toLocaleString('sv-SE')+' kr';
const feedStyle = {
  sale:{bg:'#dcfce7',c:'#16a34a',i:'🏷️'}, add:{bg:'#dbeafe',c:'#1B3A6B',i:'➕'},
  edit:{bg:'#fef3c7',c:'#d97706',i:'✏️'}, delete:{bg:'#fee2e2',c:'#CC1B2B',i:'🗑️'},
  reserve:{bg:'#fef3c7',c:'#d97706',i:'🔖'}, reverse:{bg:'#f1f5f9',c:'#64748b',i:'↩️'},
  login:{bg:'#e0e7ff',c:'#4f46e5',i:'🔑'}
};
function toast(msg){const t=document.getElementById('toast');t.textContent=msg;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),2500);}
function ago(s){if(s<60)return s+'s sedan';if(s<3600)return Math.floor(s/60)+'m sedan';return Math.floor(s/3600)+'t sedan';}

async function load(){
  try{
    const d = await fetch('/admin/api/status').then(r=>r.json());
    document.getElementById('uptime').textContent = d.uptime;
    document.getElementById('activeDev').textContent = d.activeDevices;
    document.getElementById('items').textContent = d.items;
    document.getElementById('totalQty').textContent = (d.totalQty||0)+' st totalt';
    document.getElementById('val').textContent = kr(d.totalValue);
    document.getElementById('salesToday').textContent = d.salesTodayCount;
    document.getElementById('salesTodayVal').textContent = kr(d.salesTodayValue);
    document.getElementById('salesWeek').textContent = d.salesWeekCount;
    document.getElementById('salesWeekVal').textContent = kr(d.salesWeekValue);
    document.getElementById('lowStock').textContent = d.lowStock;
    document.getElementById('reserved').textContent = d.reservedCount;
    document.getElementById('db').textContent = d.dbSize;
    document.getElementById('reqs').textContent = d.requests;
    document.getElementById('errs').textContent = d.errors;
    document.getElementById('users').textContent = d.users;
    document.getElementById('salesTotal').textContent = d.sales;
    document.getElementById('ips').innerHTML = d.ips.map(ip=>
      '<span class="chip" onclick="navigator.clipboard.writeText(\\'http://'+ip+':'+d.port+'\\');toast(\\'Adress kopierad\\')">http://'+ip+':'+d.port+'</span>'
    ).join('');
  }catch(e){}
}

async function loadDevices(){
  try{
    const d = await fetch('/admin/api/devices').then(r=>r.json());
    const dev = document.getElementById('devices');
    document.getElementById('devCount').textContent = d.devices.length+' totalt';
    if(!d.devices.length){ dev.innerHTML='<div class="empty">Inga enheter har anslutit ännu</div>'; }
    else dev.innerHTML = d.devices.map(x=>
      '<div class="dev"><span class="ip">'+x.ip+'</span>'+
      '<span class="badge '+(x.active?'on':'off')+'">'+(x.active?'aktiv':'inaktiv')+'</span>'+
      '<span style="color:#64748b">'+(x.device||'')+'</span>'+
      '<span style="margin-left:auto;text-align:right">'+
      (x.user?'<strong>'+x.user+'</strong>':'<span class="muted">ej inloggad</span>')+
      '<div class="muted">'+ago(x.lastSeenAgo)+' · '+x.count+' anrop</div></span></div>'
    ).join('');

    const feed = document.getElementById('feed');
    if(!d.feed.length){ feed.innerHTML='<div class="empty">Ingen aktivitet ännu</div>'; }
    else feed.innerHTML = d.feed.map(f=>{
      const s = feedStyle[f.type]||{bg:'#f1f5f9',c:'#64748b',i:'•'};
      const t = new Date(f.ts);
      return '<div class="feed-item"><div class="feed-ico" style="background:'+s.bg+';color:'+s.c+'">'+s.i+'</div>'+
        '<div style="flex:1"><div>'+f.description+'</div>'+
        '<div class="muted">'+(f.user?f.user+' · ':'')+(f.ip||'')+' · '+t.toLocaleTimeString('sv-SE',{hour:'2-digit',minute:'2-digit'})+'</div></div></div>';
    }).join('');
  }catch(e){}
}

async function doBackup(btn){
  btn.disabled=true; const o=btn.innerHTML; btn.innerHTML='<span>⏳</span> Skapar…';
  try{ const r=await fetch('/admin/api/backup-now').then(r=>r.json()); toast(r.ok?'Backup skapad':'Backup misslyckades'); }
  catch(e){ toast('Backup misslyckades'); }
  btn.disabled=false; btn.innerHTML=o;
}
async function doRestart(btn){
  if(!confirm('Starta om servern? Appen är otillgänglig några sekunder.'))return;
  btn.disabled=true; btn.innerHTML='<span>⏳</span> Startar om…';
  try{ await fetch('/admin/api/restart',{method:'POST'}); }catch(e){}
  toast('Servern startar om…');
  setTimeout(()=>{ let n=0; const iv=setInterval(async()=>{ try{ await fetch('/admin/api/status'); clearInterval(iv); location.reload(); }catch(e){ if(++n>20){clearInterval(iv);} } },1000); },1500);
}

// load()/loadDevices() och deras intervaller startas bara EFTER lyckad
// inloggning (se showDashboard) — annars hade de körts direkt och fått 401
// hela tiden innan man loggat in.
let pollingStarted = false;
function startPolling(){
  if (pollingStarted) return;
  pollingStarted = true;
  load(); loadDevices();
  setInterval(load, 5000);
  setInterval(loadDevices, 4000);
}
</script></body></html>`);
});

app.get("/{*path}", (req, res) => {
  res.sendFile(path.join(__dirname, "dist", "index.html"));
});

// ── AUTOMATISK BACKUP — varje fredag kl 22:00 ────────────────────────────────
// VPS-varianten sparar ALLTID lokalt på servern i en vanlig mapp — det finns
// ingen OneDrive-app här att spara direkt i (till skillnad från Windows-
// varianten, server.cjs). Vill du ändå ha backuperna i OneDrive (eller
// Google Drive, Dropbox, m.fl.) sker det via rclone-kopplingen nedan.
// Konfigurerbar via miljövariabel (Docker-uppsättningen pekar den mot en
// monterad, beständig mapp) — annars exakt samma beteende som innan.
const LOCAL_BACKUP_DIR = process.env.BACKUP_DIR || path.join(__dirname, "backups");
function getBackupDir() {
  try {
    if (!fs.existsSync(LOCAL_BACKUP_DIR)) fs.mkdirSync(LOCAL_BACKUP_DIR, { recursive: true });
    return LOCAL_BACKUP_DIR;
  } catch (e) {
    console.error(`[backup] Kunde inte skapa lokal backup-mapp: ${e.message}`);
    return __dirname;
  }
}

// ── Generisk molnanslutning för backup, via rclone ──────────────────────────
// Fungerar med VILKEN molntjänst som helst rclone stödjer (OneDrive, Google
// Drive, Dropbox, S3, med mera — 40+ tjänster). Engångsuppsättning: installera
// rclone och kör `rclone config` för att koppla ditt konto (öppnar webbläsaren
// för inloggning — Lager lagrar aldrig själva lösenordet/nyckeln). Fyll sedan
// bara i fjärrens namn (t.ex. "onedrive:Lager-backups") i Inställningar →
// Backup i appen — resten sker automatiskt.
async function getBackupCloudConfig() {
  const row = await dbGet("ow:backupcloud");
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return null; }
}
// Kontrollerar att en rclone-fjärr ser rimlig ut innan den ens skickas
// vidare — bara bokstäver/siffror/bindestreck/understreck i själva
// fjärrnamnet (före ":"), sen valfri sökväg. execFile() nedan gör redan
// command injection omöjligt (inget skal tolkar strängen), men detta
// stoppar uppenbart trasig/konstig indata tidigt också.
function isValidRcloneRemote(remote) {
  if (typeof remote !== "string" || !remote.includes(":")) return false;
  const name = remote.split(":")[0];
  return /^[A-Za-z0-9_-]+$/.test(name);
}

function pushBackupToCloud(filePath, remote) {
  if (!remote || !isValidRcloneRemote(remote)) return;
  const { execFile } = require("child_process");
  // execFile (INTE exec) — argumenten skickas som en array direkt till
  // rclone-programmet, aldrig genom ett skal som skulle kunna tolka
  // specialtecken (;, |, $(), citattecken m.m.) som egna kommandon.
  execFile("rclone", ["copy", filePath, remote], (err) => {
    if (err) console.error(`[backup] rclone-uppladdning misslyckades: ${err.message}`);
    else console.log(`[backup] Skickad till moln via rclone: ${path.basename(filePath)}`);
  });
}

app.post("/admin/api/backup-cloud/test", async (req, res) => {
  try {
    const { remote } = req.body || {};
    if (!remote) return res.status(400).json({ ok:false, error:"Ingen fjärr angiven." });
    if (!isValidRcloneRemote(remote)) return res.status(400).json({ ok:false, error:"Ogiltigt format på fjärrens namn." });
    const { execFile } = require("child_process");
    execFile("rclone", ["lsd", remote.split(":")[0]+":", "--max-depth", "1"], { timeout: 10000 }, (err, stdout, stderr) => {
      if (err) return res.status(400).json({ ok:false, error: stderr?.trim() || err.message });
      res.json({ ok:true, message:"Anslutningen fungerar." });
    });
  } catch (e) {
    res.status(500).json({ ok:false, error: e.message });
  }
});

// ── Excel-backup — välorganiserad fil med två flikar ─────────────────────────
async function writeExcelBackup(filePath, items, sales, extra = {}) {
  const ExcelJS = require("exceljs");
  const wb = new ExcelJS.Workbook();
  const BLUE = "FF1B3A6B", LIGHT = "FFEEF2F8", WHITE = "FFFFFFFF";

  const styleHeader = (ws, n) => {
    const row = ws.getRow(1);
    for (let c = 1; c <= n; c++) {
      const cell = row.getCell(c);
      cell.font = { name: "Arial", bold: true, color: { argb: WHITE }, size: 11 };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BLUE } };
      cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    }
    row.height = 26;
    ws.views = [{ state: "frozen", ySplit: 1 }];
  };
  const zebra = (ws, nrows, ncols) => {
    for (let r = 2; r <= nrows; r++) {
      const row = ws.getRow(r);
      for (let c = 1; c <= ncols; c++) row.getCell(c).font = { name: "Arial", size: 10 };
      if (r % 2 === 0) for (let c = 1; c <= ncols; c++)
        row.getCell(c).fill = { type: "pattern", pattern: "solid", fgColor: { argb: LIGHT } };
    }
  };

  // ── Flik 1: Lager ──
  const ws = wb.addWorksheet("Lager");
  ws.columns = [
    { header: "Lagernummer", width: 13 },
    { header: "Artikelnummer", width: 16 },
    { header: "Namn", width: 18 },
    { header: "Sida", width: 10 },
    { header: "Märke", width: 12 },
    { header: "Modell", width: 10 },
    { header: "Årsmodell", width: 13 },
    { header: "Kategori", width: 13 },
    { header: "Skick", width: 22 },
    { header: "Antal", width: 8 },
    { header: "Pris (kr)", width: 11 },
    { header: "Inköpspris (kr)", width: 14 },
    { header: "Placering", width: 14 },
    { header: "Reg.nr", width: 10 },
    { header: "Leverantör", width: 14 },
    { header: "Notering", width: 28 },
  ];
  const sorted = [...items].sort((a,b)=>(parseInt(a.stockNumber||"0")||0)-(parseInt(b.stockNumber||"0")||0));
  for (const it of sorted) {
    const arsmodell = [it.yearFrom, it.yearTo].filter(Boolean).join("–");
    const placering = [it.locationType, it.location].filter(Boolean).join(" ");
    ws.addRow([
      it.stockNumber||"", it.oem||"", it.name||"", it.side||"", it.make||"", it.model||"",
      arsmodell, it.category||"", it.condition||"", it.quantity||0, it.price||0, it.costPrice||0,
      placering, it.regNumber||"", it.supplier||"", it.notes||"",
    ]);
  }
  styleHeader(ws, 16);
  zebra(ws, sorted.length+1, 16);
  [1,10,11,12].forEach(c => ws.getColumn(c).alignment = { horizontal: "center" });

  // ── Flik 2: Säljlogg ──
  const ws2 = wb.addWorksheet("Säljlogg");
  ws2.columns = [
    { header: "Datum", width: 17 },
    { header: "Lagernummer", width: 13 },
    { header: "Artikelnummer", width: 16 },
    { header: "Namn", width: 18 },
    { header: "Sida", width: 10 },
    { header: "Antal", width: 7 },
    { header: "Pris exkl. moms (kr)", width: 18 },
    { header: "Moms (kr)", width: 11 },
    { header: "Pris inkl. moms (kr)", width: 18 },
    { header: "Total (kr)", width: 11 },
    { header: "Inköpspris (kr)", width: 14 },
    { header: "Vinst (kr)", width: 11 },
    { header: "Kund", width: 18 },
    { header: "Säljare", width: 12 },
    { header: "Betalning", width: 12 },
    { header: "Notering", width: 20 },
  ];
  const sortedSales = [...(sales||[])].sort((a,b)=>(b.soldAt||0)-(a.soldAt||0));
  for (const s of sortedSales) {
    const d = s.soldAt ? new Date(s.soldAt) : null;
    const datum = d ? `${d.toISOString().slice(0,10)} ${d.toTimeString().slice(0,5)}` : "";
    const exVat = s.priceExclVat!=null ? s.priceExclVat : Math.round((s.unitPrice||0)/1.25);
    const vat = s.vatPerUnit!=null ? s.vatPerUnit : ((s.unitPrice||0)-exVat);
    const snap = s.itemSnapshot || {};
    ws2.addRow([
      datum, s.itemStockNumber||snap.stockNumber||"", snap.oem||"", s.itemName||"", s.itemSide||"",
      s.qty||0, exVat, vat, s.unitPrice||0, s.total||0, s.costPrice||snap.costPrice||0,
      s.profit!=null?s.profit:"", s.buyer||"", s.soldBy||"", s.payMethod||"", s.note||"",
    ]);
  }
  styleHeader(ws2, 16);
  zebra(ws2, sortedSales.length+1, 16);
  [2,6,7,8,9,10,11,12].forEach(c => ws2.getColumn(c).alignment = { horizontal: "center" });

  // ── Flik 3: Reservationer ──
  const ws3 = wb.addWorksheet("Reservationer");
  ws3.columns = [
    { header: "Regnummer", width: 13 },
    { header: "Kund", width: 20 },
    { header: "Lagernummer", width: 13 },
    { header: "Artikelnummer", width: 16 },
    { header: "Namn", width: 18 },
    { header: "Sida", width: 10 },
    { header: "Pris (kr)", width: 11 },
    { header: "Notering", width: 24 },
    { header: "Reserverad av", width: 14 },
    { header: "Datum", width: 13 },
  ];
  const resRows = [];
  for (const it of items) {
    for (const r of (it.reservations||[])) {
      resRows.push({ r, it });
    }
  }
  resRows.sort((a,b)=>(a.r.regNumber||"").localeCompare(b.r.regNumber||""));
  for (const { r, it } of resRows) {
    const d = r.ts ? new Date(r.ts).toISOString().slice(0,10) : "";
    ws3.addRow([
      r.regNumber||"", r.customer||"", it.stockNumber||"", it.oem||"", it.name||"", it.side||"",
      it.price||0, r.note||"", r.by||"", d,
    ]);
  }
  styleHeader(ws3, 10);
  zebra(ws3, resRows.length+1, 10);
  [1,3,7,10].forEach(c => ws3.getColumn(c).alignment = { horizontal: "center" });

  // ── Flik 4: Aktivitetslogg ──
  const ws4 = wb.addWorksheet("Aktivitetslogg");
  ws4.columns = [
    { header: "Datum & tid", width: 18 },
    { header: "Typ", width: 14 },
    { header: "Beskrivning", width: 50 },
    { header: "Användare", width: 14 },
  ];
  const typeLabels = { sale:"Försäljning", add:"Tillagd", edit:"Redigerad", delete:"Borttagen", reserve:"Reserverad", reverse:"Ångrad", import:"Import" };
  const log = (extra.activitylog||[]);
  for (const e of log) {
    const d = e.ts ? new Date(e.ts) : null;
    const datum = d ? `${d.toISOString().slice(0,10)} ${d.toTimeString().slice(0,5)}` : "";
    ws4.addRow([ datum, typeLabels[e.type]||e.type||"", e.description||"", e.user||"" ]);
  }
  styleHeader(ws4, 4);
  zebra(ws4, log.length+1, 4);

  // ── Flik 5: Roller ──
  const ws5 = wb.addWorksheet("Roller");
  ws5.columns = [
    { header: "Roll", width: 18 },
    { header: "Antal behörigheter", width: 18 },
    { header: "Behörigheter", width: 70 },
  ];
  const roles = (extra.roles||[]);
  for (const role of roles) {
    const perms = Object.keys(role.permissions||{}).filter(k=>role.permissions[k]);
    ws5.addRow([ role.name||"", perms.length, perms.join(", ") ]);
  }
  styleHeader(ws5, 3);
  zebra(ws5, roles.length+1, 3);
  ws5.getColumn(2).alignment = { horizontal: "center" };

  await wb.xlsx.writeFile(filePath);
}

async function runBackup() {
  try {
    const [itemsRow, salesRow, usersRow, settingsRow, suppliersRow, rolesRow, listsRow, activityRow, favoritesRow, trashRow] = await Promise.all([
      dbGet("ow:items"), dbGet("ow:sales"), dbGet("ow:users"), dbGet("ow:settings"), dbGet("ow:suppliers"),
      dbGet("ow:roles"), dbGet("ow:lists"), dbGet("ow:activitylog"), dbGet("ow:favorites"), dbGet("ow:trash")
    ]);
    const items = itemsRow ? JSON.parse(itemsRow.value) : [];
    // Samla ihop bilderna så backupen blir komplett
    const itemsWithImages = [];
    for (const it of items) {
      if (it.hasImages > 0) {
        const imgRow = await new Promise(r => db.get("SELECT data FROM images WHERE item_id=?", [it.id], (e,row)=>r(row)));
        let imgs = []; try { imgs = imgRow ? JSON.parse(imgRow.data) : []; } catch {}
        itemsWithImages.push({ ...it, images: imgs });
      } else {
        itemsWithImages.push(it);
      }
    }
    const parse = (row, def) => { try { return row ? JSON.parse(row.value) : def; } catch { return def; } };
    const data = {
      version: 4,
      exportedAt: new Date().toISOString(),
      auto: true,
      items: itemsWithImages,
      sales: parse(salesRow, []),
      users: parse(usersRow, []),
      settings: parse(settingsRow, null),
      suppliers: parse(suppliersRow, []),
      roles: parse(rolesRow, []),
      lists: parse(listsRow, null),
      activitylog: parse(activityRow, []),
      favorites: parse(favoritesRow, []),
      trash: parse(trashRow, []),
    };
    const stamp = new Date().toISOString().slice(0,10);
    const BACKUP_DIR = getBackupDir();
    const cloudCfg = await getBackupCloudConfig();
    const file = path.join(BACKUP_DIR, `auto_backup_${stamp}.json`);
    fs.writeFileSync(file, JSON.stringify(data));
    console.log(`[backup] JSON-backup skapad: ${file} (${items.length} delar)`);
    if (cloudCfg?.remote) pushBackupToCloud(file, cloudCfg.remote);

    // ── Excel-backup (välorganiserad, två flikar) ──
    try {
      const xlsxFile = path.join(BACKUP_DIR, `auto_backup_${stamp}.xlsx`);
      await writeExcelBackup(xlsxFile, itemsWithImages, data.sales, { activitylog: data.activitylog, roles: data.roles });
      console.log(`[backup] Excel-backup skapad`);
      if (cloudCfg?.remote) pushBackupToCloud(xlsxFile, cloudCfg.remote);
    } catch (e) {
      console.error("[backup] Excel misslyckades:", e.message);
    }

    // Behåll bara de 8 senaste auto-backuperna (både .json och .xlsx)
    for (const ext of ["json", "xlsx"]) {
      const files = fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith("auto_backup_") && f.endsWith(ext)).sort();
      while (files.length > 8) {
        const old = files.shift();
        try { fs.unlinkSync(path.join(BACKUP_DIR, old)); } catch {}
      }
    }
  } catch (e) {
    console.error("[backup] Misslyckades:", e.message);
    throttledNotify("backupFailed", "Backup misslyckades",
      `<p>Den automatiska backupen misslyckades:</p><p style="font-family:monospace;background:#f4f5f7;padding:10px;border-radius:6px">${e.message}</p><p>Kontrollera att servern har diskutrymme och att backup-mappen är tillgänglig.</p>`, 60);
  }
}

// Kontrollera varje minut om det är fredag 22:00
let lastBackupKey = "";
setInterval(() => {
  const now = new Date();
  // 5 = fredag (0=söndag). 22:00.
  if (now.getDay() === 5 && now.getHours() === 22 && now.getMinutes() === 0) {
    const key = now.toISOString().slice(0,13); // unik per timme — kör bara en gång
    if (key !== lastBackupKey) {
      lastBackupKey = key;
      console.log("[backup] Fredag 22:00 — kör automatisk backup...");
      runBackup();
    }
  }
}, 60 * 1000);

// ── Papperskorg — städa bort artiklar som legat i papperskorgen 30+ dagar ──
// Körs varje natt 03:00. Tar bort både trash-posten OCH dess bilder permanent.
let lastTrashPurgeKey = "";
setInterval(async () => {
  const now = new Date();
  if (now.getHours() === 3 && now.getMinutes() === 0) {
    const key = now.toISOString().slice(0,10);
    if (key !== lastTrashPurgeKey) {
      lastTrashPurgeKey = key;
      try {
        const row = await dbGet("ow:trash");
        const trash = row ? JSON.parse(row.value) : [];
        if (!trash.length) return;
        const cutoff = Date.now() - 30 * 864e5;
        const keep = [];
        let purged = 0;
        for (const entry of trash) {
          if ((entry.deletedAt || 0) < cutoff) {
            db.run("DELETE FROM images WHERE item_id=?", [entry.id]);
            purged++;
          } else {
            keep.push(entry);
          }
        }
        if (purged > 0) {
          await dbSet("ow:trash", JSON.stringify(keep));
          console.log(`[papperskorg] Rensade ${purged} artiklar äldre än 30 dagar`);
        }
      } catch (e) {
        console.error("[papperskorg] Städning misslyckades:", e.message);
      }
    }
  }
}, 60 * 1000);

// Kontrollera varje dag kl 09:00 om någon säljare varit inaktiv en tid (standard 7 dagar)
let lastInactivityCheckKey = "";
setInterval(async () => {
  const now = new Date();
  if (now.getHours() === 9 && now.getMinutes() === 0) {
    const key = now.toISOString().slice(0,10); // en gång per dag
    if (key !== lastInactivityCheckKey) {
      lastInactivityCheckKey = key;
      try {
        const cfg = await getEmailConfig();
        const days = cfg?.inactivityDays ?? 7;
        const [usersRow, activityRow] = await Promise.all([dbGet("ow:users"), dbGet("ow:activitylog")]);
        const users = usersRow ? JSON.parse(usersRow.value) : [];
        const activity = activityRow ? JSON.parse(activityRow.value) : [];
        const cutoff = Date.now() - days * 864e5;
        const inactive = [];
        for (const u of users) {
          if (u.role === "admin") continue; // huvudadmin behöver inte varnas om sig själv
          const lastEvent = activity.filter(a => a.user === u.username).sort((a,b)=>b.ts-a.ts)[0];
          if (!lastEvent || lastEvent.ts < cutoff) {
            inactive.push({ username: u.username, lastSeen: lastEvent ? new Date(lastEvent.ts).toLocaleDateString("sv-SE") : "aldrig registrerad aktivitet" });
          }
        }
        if (inactive.length) {
          const rows = inactive.map(x => `<li><strong>${x.username}</strong> — senast aktiv: ${x.lastSeen}</li>`).join("");
          await sendNotification("inactiveSeller", `${inactive.length} säljare inaktiva i ${days}+ dagar`,
            `<p>Följande användare har inte haft någon registrerad aktivitet (försäljning, inloggning m.m.) på minst ${days} dagar:</p><ul>${rows}</ul>`);
        }
      } catch (e) {
        console.error("[notify] Inaktivitetskontroll misslyckades:", e.message);
      }
    }
  }
}, 60 * 1000);

// ── Daglig sammanfattning — igår kl 08:00 ("Igår sålde ni X för Y kr") ──
let lastDailySummaryKey = "";
setInterval(async () => {
  const now = new Date();
  if (now.getHours() === 8 && now.getMinutes() === 0) {
    const key = now.toISOString().slice(0,10);
    if (key !== lastDailySummaryKey) {
      lastDailySummaryKey = key;
      try {
        const cfg = await getEmailConfig();
        if (cfg?.notifTypes?.dailySummary === false) return;
        const yesterdayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()-1).getTime();
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
        const salesRow = await dbGet("ow:sales");
        const sales = salesRow ? JSON.parse(salesRow.value) : [];
        const yesterday = sales.filter(s => s.soldAt >= yesterdayStart && s.soldAt < todayStart);
        if (!yesterday.length) return; // ingen försäljning — inget mejl, för att inte spamma i onödan
        const rev = yesterday.reduce((a,s)=>a+s.total,0);
        const profit = yesterday.reduce((a,s)=>a+(s.profit||0),0);
        const dateStr = new Date(yesterdayStart).toLocaleDateString("sv-SE",{weekday:"long",day:"numeric",month:"long"});
        await sendNotification("dailySummary", `Igår sålde ni ${rev.toLocaleString("sv-SE")} kr`,
          `<p>Sammanfattning för <strong>${dateStr}</strong>:</p>
           <ul>
             <li>Intäkt: <strong>${rev.toLocaleString("sv-SE")} kr</strong></li>
             <li>Vinst: <strong style="color:${profit>=0?'#16a34a':'#CC1B2B'}">${profit.toLocaleString("sv-SE")} kr</strong></li>
             <li>Antal affärer: ${yesterday.length}</li>
           </ul>`);
      } catch (e) {
        console.error("[notify] Daglig sammanfattning misslyckades:", e.message);
      }
    }
  }
}, 60 * 1000);

// ── Veckosammanfattning — måndagar kl 08:00, för föregående vecka ──
let lastWeeklySummaryKey = "";
setInterval(async () => {
  const now = new Date();
  if (now.getDay() === 1 && now.getHours() === 8 && now.getMinutes() === 5) { // 08:05, efter dagssammanfattningen
    const key = now.toISOString().slice(0,10);
    if (key !== lastWeeklySummaryKey) {
      lastWeeklySummaryKey = key;
      try {
        const cfg = await getEmailConfig();
        if (cfg?.notifTypes?.weeklySummary === false) return;
        const weekEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime(); // idag 00:00
        const weekStart = weekEnd - 7*864e5;
        const salesRow = await dbGet("ow:sales");
        const sales = salesRow ? JSON.parse(salesRow.value) : [];
        const week = sales.filter(s => s.soldAt >= weekStart && s.soldAt < weekEnd);
        if (!week.length) return;
        const rev = week.reduce((a,s)=>a+s.total,0);
        const profit = week.reduce((a,s)=>a+(s.profit||0),0);
        // Bästsäljande dag
        const byDay = {};
        week.forEach(s => { const d = new Date(s.soldAt).toLocaleDateString("sv-SE",{weekday:"long"}); byDay[d]=(byDay[d]||0)+s.total; });
        const bestDay = Object.entries(byDay).sort((a,b)=>b[1]-a[1])[0];
        // Per säljare
        const bySeller = {};
        week.forEach(s => { bySeller[s.soldBy]=(bySeller[s.soldBy]||0)+s.total; });
        const sellerRows = Object.entries(bySeller).sort((a,b)=>b[1]-a[1])
          .map(([name,v])=>`<li>${name}: ${v.toLocaleString("sv-SE")} kr</li>`).join("");
        await sendNotification("weeklySummary", `Veckans försäljning: ${rev.toLocaleString("sv-SE")} kr`,
          `<p>Sammanfattning för veckan som gick (${new Date(weekStart).toLocaleDateString("sv-SE")}–${new Date(weekEnd-864e5).toLocaleDateString("sv-SE")}):</p>
           <ul>
             <li>Intäkt: <strong>${rev.toLocaleString("sv-SE")} kr</strong></li>
             <li>Vinst: <strong style="color:${profit>=0?'#16a34a':'#CC1B2B'}">${profit.toLocaleString("sv-SE")} kr</strong></li>
             <li>Antal affärer: ${week.length}</li>
             ${bestDay?`<li>Bästa dag: ${bestDay[0]} (${bestDay[1].toLocaleString("sv-SE")} kr)</li>`:""}
           </ul>
           ${sellerRows?`<p><strong>Per säljare:</strong></p><ul>${sellerRows}</ul>`:""}`);
      } catch (e) {
        console.error("[notify] Veckosammanfattning misslyckades:", e.message);
      }
    }
  }
}, 60 * 1000);

// Manuell trigger för test: GET /admin/api/backup-now (registreras före catch-all nedan)

// ── Starta ────────────────────────────────────────────────────────────────────
// Lyssnar på 0.0.0.0 så en reverse proxy (nginx) på samma maskin kan nå den
// och sköta HTTPS/domänen. Byt PORT via miljövariabel om 3000 redan är upptagen.
app.listen(PORT, "0.0.0.0", () => {
  const ips = Object.values(os.networkInterfaces()).flat()
    .filter(i => i.family === "IPv4" && !i.internal).map(i => i.address);
  console.log("\n========================================");
  console.log("     Lager (VPS) - Server igang");
  console.log("========================================");
  console.log(`  Lokalt:   http://localhost:${PORT}`);
  ips.forEach(ip => console.log(`  IP:       http://${ip}:${PORT}`));
  console.log(`  Admin:    http://localhost:${PORT}/admin`);
  console.log(`  OBS: sätt upp nginx + Let's Encrypt för att nå servern via ditt domännamn med HTTPS.`);
  console.log("========================================\n");
});

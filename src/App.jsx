import React, { useState, useEffect, useRef, useCallback, forwardRef } from "react";
import { VirtuosoGrid, Virtuoso } from "react-virtuoso";
import { AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from "recharts";
// Delad, testad beräkningslogik (moms, marginal, lagernummer) — se src/calc.mjs
// och tests/calc.test.mjs. Körs automatiskt med `npm test`.
import { exVatToInclVat, inclVatToExVat, nextAvailableStockNumber, checkStockNumberTaken } from "./calc.mjs";

// ── Error Boundary — fångar krascher och visar fel istället för vit skärm ─────
class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { hasError: false, error: null }; }
  static getDerivedStateFromError(error) { return { hasError: true, error }; }
  componentDidCatch(error, info) { console.error("App-krasch:", error, info); }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",height:"100vh",padding:24,textAlign:"center",fontFamily:"sans-serif",background:"#F5F5F7"}}>
          <div style={{fontSize:48,marginBottom:16}}>⚠️</div>
          <div style={{fontWeight:700,fontSize:18,color:"#141820",marginBottom:8}}>Något gick fel</div>
          <div style={{fontSize:14,color:"#666",marginBottom:16,maxWidth:340}}>Appen stötte på ett problem. Tryck för att ladda om.</div>
          {this.state.error&&(
            <pre style={{fontSize:11,color:"#CC1B2B",background:"#FDECEC",border:"1px solid #f5c6c6",borderRadius:8,padding:"10px 12px",marginBottom:20,maxWidth:360,overflow:"auto",textAlign:"left",whiteSpace:"pre-wrap"}}>{String(this.state.error?.message||this.state.error)}</pre>
          )}
          <button onClick={()=>window.location.reload()} style={{background:"#1B3A6B",color:"#fff",border:"none",borderRadius:8,padding:"12px 24px",fontSize:14,fontWeight:600,cursor:"pointer"}}>
            Ladda om appen
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

// ─── Storage — REST API mot lokal server ──────────────────────────────────────
// Appen och API:et serveras från samma server (server.js på port 3000),
// så en relativ sökväg fungerar alltid — oavsett om man når servern via
// localhost eller via en IP-adress på nätverket.
const API = "/api";

// Nuvarande inloggad användare + sessionstoken (sätts av appen vid inloggning).
// Token skickas med på varje anrop — servern kräver den för all data, ett
// användarnamn i en header räcker inte (det används bara för att visa vem
// som är inloggad på varje enhet i admin-panelen, inte för behörighet).
let CURRENT_USERNAME = null;
let CURRENT_TOKEN = null;
function setCurrentUsername(name) { CURRENT_USERNAME = name || null; }
function setCurrentToken(token) { CURRENT_TOKEN = token || null; }
// Anropas när servern svarar 401 (session ogiltig/utgången) — loggar ut
// användaren så de inte sitter fast i ett trasigt läge.
let onSessionExpired = null;
function setOnSessionExpired(fn) { onSessionExpired = fn; }
function authHeaders(base = {}) {
  const h = { ...base };
  if (CURRENT_USERNAME) h["x-lager-user"] = encodeURIComponent(CURRENT_USERNAME);
  if (CURRENT_TOKEN) h["Authorization"] = `Bearer ${CURRENT_TOKEN}`;
  return h;
}
// Rapportera en händelse till admin-panelens live-flöde (bästa-försök, blockerar inget).
function reportEvent(type, description) {
  try {
    fetch(`/admin/api/event`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ type, description, user: CURRENT_USERNAME }),
    }).catch(()=>{});
  } catch {}
}

// ── Universell utskrift — fungerar i Electron, webbläsare och mobil ───────────
function printHtml(html) {
  // Metod 1: dold iframe (fungerar bäst i Electron)
  try {
    const iframe = document.createElement("iframe");
    iframe.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;";
    document.body.appendChild(iframe);
    const doc = iframe.contentWindow.document;
    doc.open();
    doc.write(html);
    doc.close();
    iframe.contentWindow.focus();
    setTimeout(() => {
      try { iframe.contentWindow.print(); } catch {}
      setTimeout(() => { try { document.body.removeChild(iframe); } catch {} }, 1000);
    }, 500);
    return true;
  } catch {
    // Metod 2: blob URL i ny flik
    const blob = new Blob([html], {type:"text/html"});
    const url = URL.createObjectURL(blob);
    const w = window.open(url, "_blank");
    if (!w) { const a=document.createElement("a"); a.href=url; a.download="utskrift.html"; a.click(); }
    setTimeout(()=>URL.revokeObjectURL(url), 10000);
    return true;
  }
}

// Skapa en liten thumbnail (~120px) från en base64-bild — bara några KB
function makeThumbnail(dataUrl) {
  return new Promise((resolve) => {
    try {
      const img = new Image();
      img.onload = () => {
        const maxW = 120;
        const scale = Math.min(1, maxW / img.width);
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        canvas.getContext("2d").drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", 0.5));
      };
      img.onerror = () => resolve(null);
      img.src = dataUrl;
    } catch { resolve(null); }
  });
}

async function sget(k) {
  try {
    const res = await fetch(`${API}/${k}`, { headers: authHeaders() });
    if (res.status === 401) { onSessionExpired?.(); return null; }
    const r = await res.json();
    return r ? JSON.parse(r.value) : null;
  } catch { return null; }
}
async function sset(k,v) {
  try {
    const res = await fetch(`${API}/${k}`, {
      method:"POST",
      headers: authHeaders({"Content-Type":"application/json"}),
      body: JSON.stringify({value:JSON.stringify(v)})
    });
    if (res.status === 401) { onSessionExpired?.(); return false; }
    if (!res.ok) {
      console.error(`Sparning misslyckades för ${k}: HTTP ${res.status}`);
      return false;
    }
    return true;
  } catch (e) {
    console.error(`Sparning misslyckades för ${k}:`, e.message);
    return false;
  }
}

// Item-level: uppdatera/lägg till EN artikel utan att skriva över andras ändringar
async function saveOneItem(item) {
  try {
    const r = await fetch(`${API}/item/upsert`, {
      method:"POST", headers: authHeaders({"Content-Type":"application/json"}),
      body: JSON.stringify({ item })
    }).then(r=>r.json());
    return r.items || null;
  } catch { return null; }
}
// Item-level: ta bort EN artikel
async function deleteOneItem(id) {
  try {
    const r = await fetch(`${API}/item/delete`, {
      method:"POST", headers: authHeaders({"Content-Type":"application/json"}),
      body: JSON.stringify({ id })
    }).then(r=>r.json());
    return r.items || null;
  } catch { return null; }
}
// Mjuk borttagning — tas bort från lagerlistan men bilderna behålls på servern,
// så artikeln går att återställa helt (med bilder) från Papperskorgen i 30 dagar.
async function softDeleteOneItem(id) {
  try {
    const r = await fetch(`${API}/item/soft-delete`, {
      method:"POST", headers: authHeaders({"Content-Type":"application/json"}),
      body: JSON.stringify({ id })
    }).then(r=>r.json());
    return r.items || null;
  } catch { return null; }
}

// Bilder — hämta för en artikel
async function getImages(id) {
  try {
    const r = await fetch(`${API}/images/${id}`, { headers: authHeaders() }).then(r=>r.json());
    return r.images || [];
  } catch { return []; }
}
// Bilder — spara för en artikel
async function setImages(id, images) {
  try {
    const r = await fetch(`${API}/images/${id}`, {
      method:"POST", headers: authHeaders({"Content-Type":"application/json"}),
      body: JSON.stringify({ images })
    });
    return r.ok;
  } catch { return false; }
}

// ── Redigeringslås — hindrar två användare från att ändra samma del samtidigt ──
async function lockAcquire(itemId, user, action) {
  try {
    return await fetch(`${API}/lock/acquire`, {
      method:"POST", headers: authHeaders({"Content-Type":"application/json"}),
      body: JSON.stringify({ itemId, user, action })
    }).then(r=>r.json());
  } catch { return { ok: true }; } // vid nätverksfel — blockera inte användaren
}
async function lockRelease(itemId, user) {
  try {
    await fetch(`${API}/lock/release`, {
      method:"POST", headers: authHeaders({"Content-Type":"application/json"}),
      body: JSON.stringify({ itemId, user })
    });
  } catch {}
}
async function lockHeartbeat(itemId, user) {
  try {
    return await fetch(`${API}/lock/heartbeat`, {
      method:"POST", headers: authHeaders({"Content-Type":"application/json"}),
      body: JSON.stringify({ itemId, user })
    }).then(r=>r.json());
  } catch { return { ok: true }; }
}
function fmtLockTime(ms) {
  const min = Math.ceil(ms / 60000);
  return min <= 1 ? "mindre än 1 min" : `~${min} min`;
}

// Lösenordshashning sker nu ALLTID på servern (scrypt), aldrig i webbläsaren
// — se server.cjs (hashPasswordServer). Klienten skickar bara lösenordet i
// klartext över den redan autentiserade anslutningen när det faktiskt ska
// sättas/ändras (fältet newPlainPassword), aldrig något hash-värde.

// ─── Session — håller användaren inloggad i 30 dagar ──────────────────────────
// Sparar sessionstoken (utfärdad av servern vid inloggning) tillsammans med
// userId — token är själva beviset på att man loggat in, userId används
// (som förut) för att slå upp rätt användare i users-listan.
const SESSION_KEY = "lager_session";
const SESSION_DAYS = 30;
function saveSession(userId, token) {
  try { localStorage.setItem(SESSION_KEY, JSON.stringify({ userId, token, expires: Date.now() + SESSION_DAYS*864e5 })); } catch {}
}
function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const { userId, token, expires } = JSON.parse(raw);
    if (Date.now() > expires || !token) { localStorage.removeItem(SESSION_KEY); return null; }
    return userId;
  } catch { return null; }
}
function loadToken() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const { token, expires } = JSON.parse(raw);
    if (Date.now() > expires) return null;
    return token || null;
  } catch { return null; }
}
function clearSession() {
  try { localStorage.removeItem(SESSION_KEY); } catch {}
}
// Loggar ut både lokalt och på servern (ogiltigförklarar sessionstoken där,
// så den inte går att återanvända om den skulle läcka ut).
function doLogout() {
  const token = loadToken();
  if (token) fetch(`${API}/logout`, { method:"POST", headers:{ "Authorization": `Bearer ${token}` } }).catch(()=>{});
  clearSession();
  setCurrentToken(null);
}

// ─── Constants ────────────────────────────────────────────────────────────────
const DEFAULT_ADMIN = { id:"admin", username:"admin", newPlainPassword:"admin123", role:"admin", permissions:{}, createdAt:Date.now() };

const DEFAULT_ITEMS = [];

const ALL_PERMISSIONS = [
  { key:"canView",        label:"Visa lager",      icon:"fa-eye" },
  { key:"canAdd",         label:"Lägg till del",   icon:"fa-plus" },
  { key:"canEdit",        label:"Redigera del",    icon:"fa-pen" },
  { key:"canDelete",      label:"Ta bort del",     icon:"fa-trash" },
  { key:"canManageTrash", label:"Hantera papperskorg", icon:"fa-trash-can" },
  { key:"canManageCustomers", label:"Hantera kundregister", icon:"fa-address-book" },
  { key:"canSell",        label:"Sälj direkt (utan kassa)", icon:"fa-tag" },
  { key:"canUseCheckout", label:"Använd kassan (flera artiklar)", icon:"fa-cart-shopping" },
  { key:"canPrintReceipt",label:"Skriv ut kvitto", icon:"fa-receipt" },
  { key:"canExport",      label:"Exportera CSV",   icon:"fa-file-export" },
  { key:"canImport",      label:"Importera Excel/CSV", icon:"fa-file-import" },
  { key:"canViewLog",     label:"Visa säljlogg",   icon:"fa-chart-line" },
  { key:"canViewDashboard", label:"Visa dashboard", icon:"fa-table-cells-large" },
  { key:"canViewReports", label:"Visa rapporter",  icon:"fa-chart-pie" },
  { key:"canScan",        label:"Skanna QR-kod",   icon:"fa-qrcode" },
  { key:"canBulkEdit",    label:"Massredigera",    icon:"fa-layer-group" },
  { key:"canManageSuppliers", label:"Hantera leverantörer", icon:"fa-truck" },
  { key:"canBackup",      label:"Backup & återställning", icon:"fa-rotate" },
  { key:"canViewReservations", label:"Visa reservationer", icon:"fa-bookmark" },
  { key:"canAddReservations",  label:"Lägg till reservationer", icon:"fa-square-plus" },
  { key:"canEditReservations", label:"Ändra reservationer", icon:"fa-pen-to-square" },
  { key:"canViewActivityLog", label:"Visa aktivitetslogg", icon:"fa-clock-rotate-left" },
  { key:"canManageUsers", label:"Hantera användare", icon:"fa-users" },
  { key:"canManageSettings", label:"Ändra inställningar", icon:"fa-sliders" },
];

// Hjälpare: gör ett permissions-objekt med alla angivna nycklar satta till true
const permsFrom = (...keys) => Object.fromEntries(keys.map(k => [k, true]));

// Färdiga roller — admin kan redigera/lägga till/ta bort dessa.
// Sparas i ow:roles. Detta är standarduppsättningen som skapas första gången.
const DEFAULT_ROLES = [
  {
    id: "role_seller", name: "Säljare", color: "#1B3A6B",
    permissions: permsFrom("canView","canSell","canUseCheckout","canPrintReceipt","canScan","canViewReservations"),
  },
  {
    id: "role_warehouse", name: "Lagerarbetare", color: "#2E7D32",
    permissions: permsFrom("canView","canAdd","canEdit","canScan","canBulkEdit","canViewReservations","canAddReservations","canEditReservations"),
  },
  {
    id: "role_viewer", name: "Visning", color: "#757575",
    permissions: permsFrom("canView","canViewReservations"),
  },
];

const DEFAULT_CATEGORIES = ["Skärmar","Motorhuvar","Stötfångare","Dörrar","Spoilers","Sidokjolar","Bakluckor","Speglar","Rutor","Huvar","Övrigt"];
const DEFAULT_CONDITIONS = ["Ny","Begagnad - Gott skick","Begagnad - Liten spricka","Begagnad - Kräver lackering","Reservdelar / Skrotning"];
const DEFAULT_SIDES = ["","Vänster","Höger","Liksidig","Fram","Bak","Fram Vänster","Fram Höger","Bak Vänster","Bak Höger"];
const DEFAULT_LOCATION_TYPES = ["","Hylla","Låda","Hisshylla","Rum","Kontainer","Utomhus","Övrigt"];
const DEFAULT_WAREHOUSES = ["Halmstad","Laholm"];
// Bakåtkompatibilitet — dessa används som standard tills användaren redigerat listorna
const CATEGORIES = DEFAULT_CATEGORIES;
const CONDITIONS = DEFAULT_CONDITIONS;
const SIDES = DEFAULT_SIDES;
const LOCATION_TYPES = DEFAULT_LOCATION_TYPES;
const WAREHOUSES = DEFAULT_WAREHOUSES;

// ── Bilmärkesgrupper ─────────────────────────────────────────────────────────
const BRAND_GROUPS = {
  "VW Group":       ["Volkswagen","VW","Audi","Skoda","Seat","Porsche","Lamborghini","Bentley","Cupra","MAN"],
  "Stellantis":     ["Peugeot","Citroën","Citroen","Opel","Vauxhall","Fiat","Alfa Romeo","Alfa-Romeo","Jeep","DS","Lancia","Chrysler","Dodge","Ram"],
  "Renault Group":  ["Renault","Dacia","Nissan","Mitsubishi"],
  "BMW Group":      ["BMW","Mini","Rolls-Royce"],
  "Mercedes Group": ["Mercedes","Mercedes-Benz","Smart","Maybach"],
  "Ford Group":     ["Ford","Lincoln"],
  "GM Group":       ["Chevrolet","Cadillac","Buick","GMC"],
  "Toyota Group":   ["Toyota","Lexus","Daihatsu","Hino"],
  "Honda Group":    ["Honda","Acura"],
  "Hyundai Group":  ["Hyundai","Kia","Genesis"],
  "Geely Group":    ["Volvo","Geely","Polestar","Lynk & Co"],
  "Tata Group":     ["Jaguar","Land Rover","Tata"],
  "Mazda":          ["Mazda"],
  "Subaru":         ["Subaru"],
  "Suzuki":         ["Suzuki"],
  "Tesla":          ["Tesla"],
};

// Normaliserar märkesnamn — "audi", "AUDI" → "Audi"
// Byggs från BRAND_GROUPS så det är alltid synkat
const MAKE_NORMALIZE = {};
Object.values(BRAND_GROUPS).flat().forEach(brand => {
  MAKE_NORMALIZE[brand.toLowerCase()] = brand;
});
// Extra stavningsvarianter
const MAKE_ALIASES = {
  "vw": "Volkswagen", "mercedes": "Mercedes-Benz", "merc": "Mercedes-Benz",
  "marcedes": "Mercedes-Benz", "merscedes": "Mercedes-Benz",
  "bmw": "BMW", "volov": "Volvo", "volvo": "Volvo",
  "citroen": "Citroën", "alfa romeo": "Alfa Romeo", "alfa-romeo": "Alfa Romeo",
  "land rover": "Land Rover", "landrover": "Land Rover",
  "rolls royce": "Rolls-Royce", "rollsroyce": "Rolls-Royce",
  "mini": "Mini", "seat": "Seat", "skoda": "Skoda",
  "peugeot": "Peugeot", "renault": "Renault", "dacia": "Dacia",
  "hyundai": "Hyundai", "hondai": "Hyundai", "kia": "Kia",
  "toyota": "Toyota", "honda": "Honda", "mazda": "Mazda",
  "ford": "Ford", "opel": "Opel", "fiat": "Fiat",
  "subaru": "Subaru", "suzuki": "Suzuki", "tesla": "Tesla",
  "nissan": "Nissan", "mitsubishi": "Mitsubishi",
};

function normalizeMake(make) {
  if (!make) return make;
  const m = make.trim().toLowerCase();
  if (MAKE_ALIASES[m]) return MAKE_ALIASES[m];
  if (MAKE_NORMALIZE[m]) return MAKE_NORMALIZE[m];
  // Kapitalisera första bokstaven om inget hittas
  return make.trim().charAt(0).toUpperCase() + make.trim().slice(1).toLowerCase();
}

function getBrandGroup(make) {
  if (!make) return null;
  const normalized = normalizeMake(make);
  const m = normalized.toLowerCase();
  for (const [group, brands] of Object.entries(BRAND_GROUPS)) {
    if (brands.some(b => b.toLowerCase() === m)) return group;
  }
  return null;
}

function genId(p="id") { return `${p}_${Date.now()}_${Math.random().toString(36).slice(2,7)}`; }
// Formaterar registreringsnummer konsekvent som "ABC 123" medan man skriver
// — versaler, inga specialtecken, mellanslag automatiskt efter tre tecken.
function formatRegNumber(raw) {
  const clean = (raw||"").toUpperCase().replace(/[^A-ZÅÄÖ0-9]/g,"").slice(0,6);
  return clean.length <= 3 ? clean : clean.slice(0,3) + " " + clean.slice(3);
}

// ── Universell kopiera-funktion — fungerar i Electron, webbläsare och HTTP ────
function copyText(text) {
  // Försök modern API först
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text).catch(() => {
      legacyCopy(text);
    });
  }
  legacyCopy(text);
  return Promise.resolve();
}
function legacyCopy(text) {
  const el = document.createElement("textarea");
  el.value = text;
  el.style.cssText = "position:fixed;left:-9999px;top:-9999px";
  document.body.appendChild(el);
  el.focus(); el.select();
  try { document.execCommand("copy"); } catch {}
  document.body.removeChild(el);
}



const R="#CC1B2B", B="#1B3A6B", BG="var(--bg)", WH="var(--wh)", BD="var(--bd)";
const TX="var(--tx)", TM="var(--tm)", MU="var(--mu)", GR="#16A34A", AM="#D97706";
// BX = samma blå som B, men ljusare i mörkt läge — används där en solid blå
// yta (badge, lagernummer-chip, platsmarkering) annars skulle bli svår att
// se mot ett mörkt kort. B självt rörs aldrig (används med genomskinlighets-
// tricket på många ställen, som kräver ett riktigt hex-värde).
const BX = "var(--b-solid)";
const NOTEBG = "var(--note-bg)";
const SH="0 1px 4px rgba(0,0,0,.08)", SH2="0 4px 20px rgba(0,0,0,.12)";

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Barlow:wght@400;500;600;700&family=Barlow+Condensed:wght@600;700;800&display=swap');
@import url('https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css');
*{box-sizing:border-box;margin:0;padding:0;}
html,body{height:100%;background:${BG};}
/* Blockera zoom på inputs för mobil */
@media (max-width:768px){
  input,select,textarea{font-size:16px!important;}
}
/* Landscape på mobil */
@media (max-width:768px) and (orientation:landscape){
  .page{padding-bottom:env(safe-area-inset-bottom)!important;}
}
/* PWA safe area — alltid, så headern aldrig hamnar under statusfältet/batteriet.
   På enheter utan notch är env() = 0 och detta gör ingen skillnad. */
.topbar-safe{padding-top:env(safe-area-inset-top)!important;}
.pwa-mode .topbar-safe{padding-top:env(safe-area-inset-top)!important;}

/* ── Tema — riktiga färger via CSS-variabler ─────────────────────────────
   De sex neutrala färgerna (bakgrund, kort, ram, text) styrs av variabler
   nedan och byts helt ut i mörkt läge. Varumärkesfärgerna (blått/rött/
   grönt/orange) är medvetet oförändrade i båda lägena — de används på
   många ställen med en inbyggd genomskinlighets-teknik som kräver riktiga
   hex-värden, och konsekventa märkesfärger är i sig ett rimligt designval. */
:root{
  --bg:#F4F5F7; --wh:#FFFFFF; --bd:#E2E5EA;
  --tx:#141820; --tm:#3D4451; --mu:#8A90A0;
  --b-solid:#1B3A6B; --note-bg:#FFFBEB;
}
html.theme-dark{
  --bg:#1A2029; --wh:#242B37; --bd:#3A4356;
  --tx:#E8EBF0; --tm:#AEB6C4; --mu:#838CA0;
  --b-solid:#4A7CE0; --note-bg:#2E2A18;
  background:var(--bg);
  color-scheme:dark;
}
html.theme-dark ::-webkit-scrollbar{background:#1A2029;}
html.theme-dark ::-webkit-scrollbar-thumb{background:#3A4356;border-radius:4px;}
html.theme-dark img{opacity:.94;} /* lätt dämpning så vita produktbilder inte bländar mot mörk bakgrund */
body{font-family:'Barlow',sans-serif;font-size:14px;color:${TX};-webkit-tap-highlight-color:transparent;}
input,select,textarea,button{font-family:'Barlow',sans-serif;outline:none;}
input:focus,select:focus,textarea:focus{border-color:${BX}!important;box-shadow:0 0 0 3px ${B}18!important;}
select option{background:${WH};color:${TX};}
::-webkit-scrollbar{width:6px} ::-webkit-scrollbar-thumb{background:#ccc;border-radius:3px}
@keyframes slideIn{from{opacity:0;transform:translateX(18px)}to{opacity:1;transform:none}}
@keyframes fadeIn{from{opacity:0}to{opacity:1}}
.page{animation:slideIn .2s ease both;}
.fade{animation:fadeIn .15s ease both;}

/* ── Responsive layout ── */
.app-shell{display:flex;height:100%;}
.sidebar{width:240px;flex-shrink:0;background:${WH};border-right:1px solid ${BD};display:flex;flex-direction:column;overflow-y:auto;}
.main-area{flex:1;overflow:hidden;position:relative;}
.content-wrap{max-width:900px;margin:0 auto;padding:20px 24px;}
.content-wrap-wide{max-width:1200px;margin:0 auto;padding:20px 24px;}
.card-grid{display:grid;grid-template-columns:1fr;gap:10px;}
.stat-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;}
.form-row{display:flex;flex-direction:column;gap:12px;}

@media(min-width:640px){
  .card-grid{grid-template-columns:repeat(2,1fr);}
  .stat-grid{grid-template-columns:repeat(3,1fr);}
}
@media(min-width:1024px){
  .card-grid{grid-template-columns:repeat(3,1fr);}
  .stat-grid{grid-template-columns:repeat(4,1fr);}
  .content-wrap{padding:28px 32px;}
  .content-wrap-wide{padding:28px 32px;}
  .form-row{flex-direction:row;}
}
@media(min-width:1280px){
  .card-grid{grid-template-columns:repeat(4,1fr);}
}

/* Desktop sidebar nav (hidden on mobile) */
@media(max-width:767px){
  .sidebar{display:none;}
  .desktop-only{display:none!important;}
}
@media(min-width:768px){
  .mobile-only{display:none!important;}
  .sidebar{display:flex;}
}
`;

// ─── Tiny UI ──────────────────────────────────────────────────────────────────
function Badge({ label, color=BX, small }) {
  if (!label) return null;
  return <span style={{background:color+"18",color,border:`1px solid ${color}28`,borderRadius:4,padding:small?"1px 6px":"2px 8px",fontSize:small?10:11,fontWeight:600,letterSpacing:.3,whiteSpace:"nowrap",display:"inline-block"}}>{label}</span>;
}

function Btn({ children, variant="primary", small, full, disabled, onClick, style:sx={} }) {
  const v = { primary:{background:BX,color:"#fff"}, red:{background:R,color:"#fff"}, success:{background:GR,color:"#fff"}, ghost:{background:WH,color:TM,border:`1px solid ${BD}`}, blue:{background:B+"12",color:BX,border:`1px solid ${B}25`} };
  return <button disabled={disabled} onClick={onClick} style={{display:"inline-flex",alignItems:"center",justifyContent:"center",gap:5,padding:small?"5px 11px":"9px 16px",borderRadius:6,border:"none",fontWeight:600,fontSize:small?12:13,opacity:disabled?.45:1,width:full?"100%":"auto",cursor:"pointer",...v[variant],...sx}}>{children}</button>;
}

function Inp({ label, value, onChange, type="text", placeholder, min }) {
  return (
    <div style={{width:"100%"}}>
      {label && <label style={{display:"block",fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:4}}>{label}</label>}
      <input type={type} value={value} onChange={onChange} placeholder={placeholder} min={min}
        style={{width:"100%",border:`1.5px solid ${BD}`,borderRadius:6,padding:"9px 12px",fontSize:13,color:TX,background:WH}} />
    </div>
  );
}

// Kund-fält med autokomplettering mot kundregistret — skriver man ett namn
// som redan finns kopplas köpet automatiskt till den kunden (för
// köphistorik), annars sparas bara namnet som text precis som förut.
function CustomerPicker({ customers, value, onChange, onSelectCustomer, label="Kund / köpare" }) {
  const [open, setOpen] = useState(false);
  const matches = (customers||[]).filter(c => value.trim() && c.name.toLowerCase().includes(value.trim().toLowerCase())).slice(0,5);
  return (
    <div style={{width:"100%",position:"relative"}}>
      {label && <label style={{display:"block",fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:4}}>{label}</label>}
      <input value={value} onChange={e=>{onChange(e.target.value);setOpen(true);}} onFocus={()=>setOpen(true)} onBlur={()=>setTimeout(()=>setOpen(false),150)}
        placeholder="Namn eller sök befintlig kund…"
        style={{width:"100%",border:`1.5px solid ${BD}`,borderRadius:6,padding:"9px 12px",fontSize:13,color:TX,background:WH,boxSizing:"border-box"}} />
      {open&&matches.length>0&&(
        <div style={{position:"absolute",top:"100%",left:0,right:0,zIndex:20,background:WH,border:`1px solid ${BD}`,borderRadius:8,marginTop:4,boxShadow:SH2,overflow:"hidden"}}>
          {matches.map(c=>(
            <div key={c.id} onMouseDown={()=>{onSelectCustomer(c);setOpen(false);}}
              style={{padding:"9px 12px",cursor:"pointer",borderBottom:`1px solid ${BD}30`,fontSize:13}}>
              <div style={{fontWeight:700}}>{c.name}</div>
              {(c.phone||c.regNumbers?.length>0)&&<div style={{fontSize:11,color:MU}}>{[c.phone,...(c.regNumbers||[])].filter(Boolean).join(" · ")}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Sel({ label, value, onChange, options }) {
  return (
    <div style={{width:"100%"}}>
      {label && <label style={{display:"block",fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:4}}>{label}</label>}
      <select value={value} onChange={onChange} style={{width:"100%",border:`1.5px solid ${BD}`,borderRadius:6,padding:"9px 12px",fontSize:13,color:TX,background:WH,appearance:"none"}}>
        {options.map(o=><option key={o.v??o} value={o.v??o}>{o.l??o}</option>)}
      </select>
    </div>
  );
}

// Liten tagg för aktiva filter, med ✕ för att ta bort
function FilterTag({ label, onRemove }) {
  return (
    <span style={{display:"inline-flex",alignItems:"center",gap:6,padding:"5px 6px 5px 11px",borderRadius:16,background:B+"12",border:`1px solid ${B}30`,color:BX,fontSize:12,fontWeight:600,maxWidth:200}}>
      <span style={{overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{label}</span>
      <button onClick={onRemove} style={{background:B+"20",border:"none",borderRadius:"50%",width:18,height:18,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",color:BX,flexShrink:0,padding:0}}>
        <i className="fa-solid fa-xmark" style={{fontSize:10}}/>
      </button>
    </span>
  );
}

function Field({ label, value, half }) {
  if (!value && value!==0) return null;
  return (
    <div style={{width:half?"calc(50% - 6px)":"100%",minWidth:0}}>
      <div style={{fontSize:10,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.8,marginBottom:2}}>{label}</div>
      <div style={{fontSize:13,fontWeight:500,color:TX,wordBreak:"break-word"}}>{value}</div>
    </div>
  );
}

// ─── Page shell (handles scroll itself) ──────────────────────────────────────
function Page({ children, style:sx, noAnim, maxWidth, flush }) {
  // flush = sidan sköter sin egen scroll/layout (t.ex. kassan med fast fot)
  if (flush) {
    return (
      <div className={noAnim?"":"page"} style={{position:"absolute",inset:0,display:"flex",flexDirection:"column",overflow:"hidden",background:BG,...sx}}>
        {children}
      </div>
    );
  }
  return (
    <div className={noAnim?"":"page"} style={{position:"absolute",inset:0,overflowY:"auto",WebkitOverflowScrolling:"touch",background:BG,...sx}}>
      <div style={maxWidth?{maxWidth,margin:"0 auto",width:"100%"}:{width:"100%"}}>
        {children}
      </div>
    </div>
  );
}

// ─── Top bar ──────────────────────────────────────────────────────────────────
function TopBar({ title, onBack, right, subtitle }) {
  return (
    <div className="topbar-safe" style={{position:"sticky",top:0,zIndex:10,background:WH,borderBottom:`1px solid ${BD}`,boxShadow:SH,flexShrink:0}}><div style={{maxWidth:900,margin:"0 auto",display:"flex",alignItems:"center",minHeight:52,padding:"0 14px",gap:10}}>
      {onBack ? (
        <button onClick={onBack} style={{background:BG,border:`1px solid ${BD}`,borderRadius:8,display:"flex",alignItems:"center",justifyContent:"center",width:34,height:34,color:BX,flexShrink:0,cursor:"pointer"}}>
          <svg viewBox="0 0 320 512" style={{width:12,height:12,fill:"currentColor"}}><path d="M9.4 233.4c-12.5 12.5-12.5 32.8 0 45.3l192 192c12.5 12.5 32.8 12.5 45.3 0s12.5-32.8 0-45.3L77.3 256 246.6 86.6c12.5-12.5 12.5-32.8 0-45.3s-32.8-12.5-45.3 0l-192 192z"/></svg>
        </button>
      ) : (
        <div style={{display:"flex",gap:3,flexShrink:0}}><div style={{width:5,height:26,background:R,borderRadius:3}}/><div style={{width:5,height:26,background:BX,borderRadius:3}}/></div>
      )}
      <div style={{flex:1,minWidth:0}}>
        <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:17,color:TX,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",lineHeight:1.2}}>{title}</div>
        {subtitle&&<div style={{fontSize:10,color:MU,fontWeight:600,textTransform:"uppercase",letterSpacing:.5}}>{subtitle}</div>}
      </div>
      {right && <div style={{display:"flex",gap:8,alignItems:"center",flexShrink:0}}>{right}</div>}
    </div></div>
  );
}

// ─── App root ─────────────────────────────────────────────────────────────────
// ─── Icon — Font Awesome 6 (via CDN) ─────────────────────────────────────────
function Icon({ name, style={}, className="" }) {
  return <i className={`fa-solid fa-${name} ${className}`} style={{display:"inline-block",width:"1.25em",textAlign:"center",...style}} aria-hidden="true"/>;
}

// ─── Responsive hook ──────────────────────────────────────────────────────────
function useIsMobile() {
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 768);
  useEffect(() => {
    const fn = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener("resize", fn);
    return () => window.removeEventListener("resize", fn);
  }, []);
  return isMobile;
}

// ─── Desktop Sidebar ──────────────────────────────────────────────────────────
function Sidebar({ currentUser, isAdmin, can, push, replace, currentPage, stack, setSession, toast$, cart, settings, trash }) {
  const cartCount = (cart||[]).reduce((a,r)=>a+r.qty,0);
  const [netInfo, setNetInfo] = useState(null);

  useEffect(() => {
    fetch("/api/network").then(r=>r.json()).then(setNetInfo).catch(()=>{});
  }, []);

  let navItems = [
    { icon:"house",        label:"Lager",          route:"inventory",  always:true },
    { icon:"cart-shopping",label:"Kassa",          route:"checkout",   show:(can("canUseCheckout")||isAdmin), badge:cartCount },
    { icon:"chart-line",   label:"Dashboard",      route:"dashboard",  show:(isAdmin||can("canViewDashboard")) },
    { icon:"chart-line",   label:"Rapporter",      route:"reports",    show:(isAdmin||can("canViewReports")) },
    { icon:"list",         label:"Säljlogg",       route:"saleslog",   show:(isAdmin||can("canViewLog")) },
    { icon:"bookmark",     label:"Reservationer",  route:"reservations", show:(isAdmin||can("canViewReservations")) },
    { icon:"clock-rotate-left", label:"Aktivitetslogg", route:"activitylog", show:(isAdmin||can("canViewActivityLog")) },
    { icon:"qrcode",       label:"Skanna",         route:"scan",       show:(isAdmin||can("canScan")) },
    { icon:"file-import",  label:"Importera",      route:"import",     show:(isAdmin||can("canImport")) },
    { icon:"layer-group",  label:"Massredigera",   route:"bulkedit",   show:(isAdmin||can("canBulkEdit")) },
    { icon:"qrcode",       label:"Etiketter",       route:"qrlabels",   show:isAdmin },
    { icon:"location-dot", label:"Platser",          route:"locationview", show:(isAdmin||can("canView")) },
    { icon:"truck",        label:"Leverantörer",   route:"suppliers",  show:(isAdmin||can("canManageSuppliers")) },
    { icon:"address-book", label:"Kunder",         route:"customers",  show:(isAdmin||can("canManageCustomers")) },
    { icon:"users",        label:"Användare",      route:"users",      show:(isAdmin||can("canManageUsers")) },
    { icon:"rotate",       label:"Backup",         route:"backup",     show:(isAdmin||can("canBackup")) },
    { icon:"trash-can",    label:"Papperskorg",    route:"trash",      show:(isAdmin||can("canManageTrash")), badge:(trash||[]).length||null },
    { icon:"sliders",      label:"Inställningar",  route:"settings",   show:(isAdmin||can("canManageSettings")) },
  ].filter(i => i.always || i.show);

  // Applicera användarens meny-layout (ordning + dolda) från inställningarna
  const layout = settings?.menuLayout || {};
  const hidden = new Set(layout.hidden || []);
  const order = layout.order || [];
  // Lager och Inställningar går aldrig att dölja (så man inte låser sig ute)
  navItems = navItems.filter(i => i.route==="inventory" || i.route==="settings" || !hidden.has(i.route));
  if (order.length) {
    const idx = r => { const p = order.indexOf(r); return p===-1 ? 999 : p; };
    navItems = [...navItems].sort((a,b) => idx(a.route) - idx(b.route));
  }

  const active = stack[stack.length-1]?.name;

  return (
    <div style={{display:"flex",flexDirection:"column",height:"100%"}}>
      {/* Logo */}
      <div style={{padding:"18px 20px 14px",borderBottom:`1px solid ${BD}`}}>
        <div style={{display:"flex",gap:4,marginBottom:8}}>
          <div style={{width:5,height:28,background:R,borderRadius:3}}/><div style={{width:5,height:28,background:BX,borderRadius:3}}/>
          <span style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:18,color:TX,marginLeft:8,alignSelf:"center"}}>Lager</span>
        </div>
        {currentUser && (
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            <div style={{width:28,height:28,borderRadius:7,background:isAdmin?R:BX,display:"flex",alignItems:"center",justifyContent:"center",color:WH,fontWeight:800,fontSize:12,flexShrink:0}}>
              {currentUser.username[0].toUpperCase()}
            </div>
            <div style={{minWidth:0}}>
              <div style={{fontWeight:700,fontSize:12,color:TX,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{currentUser.username}</div>
              <div style={{fontSize:10,color:MU}}>{isAdmin?"Admin":"Användare"}</div>
            </div>
          </div>
        )}
      </div>

      {/* Nav items */}
      <nav style={{flex:1,overflowY:"auto",padding:"8px 10px"}}>
        {navItems.map(item => {
          const isActive = active === item.route;
          return (
            <button key={item.route} onClick={()=>push(item.route)}
              style={{width:"100%",display:"flex",alignItems:"center",gap:10,padding:"9px 10px",borderRadius:8,border:"none",background:isActive?B+"10":"transparent",color:isActive?BX:TM,fontWeight:isActive?700:500,fontSize:13,cursor:"pointer",marginBottom:2,textAlign:"left",position:"relative"}}>
              <Icon name={item.icon} style={{fontSize:15,color:isActive?BX:MU,flexShrink:0}}/>
              <span style={{flex:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{item.label}</span>
              {item.badge>0 && <span style={{background:R,color:WH,borderRadius:10,padding:"1px 6px",fontSize:10,fontWeight:800}}>{item.badge}</span>}
              {isActive && <div style={{position:"absolute",left:0,top:4,bottom:4,width:3,background:BX,borderRadius:2}}/>}
            </button>
          );
        })}
      </nav>

      {/* Nätverksadresser */}
      {netInfo?.ips?.length>0 && (
        <div style={{padding:"10px 12px",borderTop:`1px solid ${BD}`,background:BG}}>
          <div style={{fontSize:9,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:6}}>
            <i className="fa-solid fa-wifi" style={{marginRight:4}}/>Nå appen från nätverk
          </div>
          {netInfo.ips.map(ip=>(
            <div key={ip} onClick={()=>{
              const url = `http://${ip}:${netInfo.port}`;
              copyText(url).then(()=>toast$("Kopierad!","success"));
            }}
              style={{display:"flex",alignItems:"center",gap:6,padding:"4px 6px",borderRadius:5,cursor:"pointer",marginBottom:2,background:WH,border:`1px solid ${BD}`}}
              title="Klicka för att kopiera">
              <i className="fa-solid fa-copy" style={{fontSize:9,color:MU,flexShrink:0}}/>
              <span style={{fontSize:10,fontFamily:"monospace",fontWeight:700,color:BX,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                {ip}:{netInfo.port}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Profil + Logout */}
      {currentUser && (
        <div style={{padding:"10px",borderTop:`1px solid ${BD}`,display:"flex",flexDirection:"column",gap:2}}>
          <button onClick={()=>push("profile")}
            style={{width:"100%",display:"flex",alignItems:"center",gap:10,padding:"9px 10px",borderRadius:8,border:"none",background:"transparent",color:TM,fontWeight:500,fontSize:13,cursor:"pointer"}}>
            <Icon name="user-gear" style={{fontSize:14,color:MU}}/>
            Min profil
          </button>
          <button onClick={()=>{doLogout();setSession(null);toast$("Utloggad");replace("login");}}
            style={{width:"100%",display:"flex",alignItems:"center",gap:10,padding:"9px 10px",borderRadius:8,border:"none",background:"transparent",color:R,fontWeight:500,fontSize:13,cursor:"pointer"}}>
            <Icon name="right-from-bracket" style={{fontSize:14,color:R}}/>
            Logga ut
          </button>
        </div>
      )}
    </div>
  );
}


export default function App() {
  return <ErrorBoundary><AppInner /></ErrorBoundary>;
}

function AppInner() {
  // Sessionstoken laddas SYNKRONT här, direkt i komponentens kropp — inte i
  // en useEffect. Effekter körs efter första renderingen, vilket tidigare
  // var för sent: den första datahämtningen (users/items/sales/osv, några
  // rader ner) hade redan hunnit köras utan token och fått 401 på allt.
  // En vanlig funktionskörning i komponentkroppen körs däremot ALLTID
  // innan några effekter, garanterat i rätt ordning.
  setCurrentToken(loadToken());

  const [users, setUsers] = useState(null);
  const [items, setItems] = useState(null);
  const [session, setSession] = useState(() => loadSession());
  const [loaded, setLoaded] = useState(false);
  const lastSyncRef = useRef(0);
  const [toast, setToast] = useState(null);
  const tRef = useRef();
  const [installPrompt, setInstallPrompt] = useState(null);
  const [showInstallBanner, setShowInstallBanner] = useState(false);

  // Detektera PWA standalone-läge och lägg till klass på html
  useEffect(() => {
    const isPWA = window.matchMedia("(display-mode: standalone)").matches
      || window.navigator.standalone === true;
    if (isPWA) document.documentElement.classList.add("pwa-mode");
  }, []);

  // PWA install prompt — ska alltid synas i webbläsaren (inte skrivbords-
  // eller mobilappen) tills man aktivt stänger den, oavsett om webbläsaren
  // råkar skicka "beforeinstallprompt" eller inte (Chrome m.fl. har egna,
  // oförutsägbara regler för OM/NÄR den händelsen alls skickas — att bara
  // lita på den gjorde att knappen ibland aldrig dök upp alls).
  useEffect(() => {
    const handler = (e) => {
      e.preventDefault();
      setInstallPrompt(e);
    };
    window.addEventListener("beforeinstallprompt", handler);
    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, []);

  useEffect(() => {
    const isPWA = window.matchMedia("(display-mode: standalone)").matches
      || window.navigator.standalone === true;
    const isDesktopApp = !!window.electronAPI; // skrivbordsappen — "installera" är irrelevant där
    let dismissed = false;
    try { dismissed = localStorage.getItem("ow:install_dismissed") === "1"; } catch {}
    setShowInstallBanner(!isPWA && !isDesktopApp && !dismissed);
  }, []);

  const installApp = async () => {
    if (installPrompt) {
      // Webbläsaren stödjer den riktiga installationsdialogen — använd den
      installPrompt.prompt();
      const { outcome } = await installPrompt.userChoice;
      if (outcome === "accepted") setShowInstallBanner(false);
      setInstallPrompt(null);
    } else {
      // Webbläsaren skickade aldrig händelsen (vanligt, oförutsägbart) —
      // visa instruktioner istället för att bara göra ingenting
      toast$("Använd webbläsarens meny (⋮ eller dela-ikonen) → \"Installera app\" eller \"Lägg till på hemskärmen\"","info");
    }
  };
  const dismissInstallBanner = () => {
    setShowInstallBanner(false);
    try { localStorage.setItem("ow:install_dismissed","1"); } catch {}
  };

  const [viewMode, setViewMode] = useState("cards");
  const [filters, setFilters] = useState({ cats:[], conds:[], sides:[], make:"", brandGroup:"", locationType:"", model:"", yearMin:"", yearMax:"", priceMin:"", priceMax:"", low:false, supplier:"", stockNums:"", artNums:"", reserved:false, noImage:false, warehouse:"" });
  const [search, setSearch] = useState("");
  const [sortPref, setSortPref] = useState({ by:"stockNumber", dir:"asc" });
  const applyFilters = useCallback(f => setFilters(f), []);
  // page stack: each entry = { name, props }
  const [stack, setStack] = useState(() => loadSession() ? [{ name:"inventory" }] : [{ name:"login" }]);
  const push = (name, props={}) => setStack(s => [...s, { name, props }]);
  const pop  = () => setStack(s => s.length > 1 ? s.slice(0,-1) : s);
  const replace = (name, props={}) => setStack(s => [...s.slice(0,-1), { name, props }]);
  const current = stack[stack.length - 1];

  // ── Delbara länkar — synkar adressfältet med ?item=ID när en artikel visas ──
  // Gör att man kan kopiera URL:en och dela en specifik del med kollegor,
  // och att den artikeln öppnas direkt om länken klistras in i webbläsaren.
  useEffect(() => {
    try {
      const url = new URL(window.location.href);
      if (current.name === "detail" && current.props?.item?.id) {
        url.searchParams.set("item", current.props.item.id);
      } else {
        url.searchParams.delete("item");
      }
      window.history.replaceState(null, "", url.toString());
    } catch {}
  }, [current]);

  useEffect(() => {
    // Körs INTE alls om ingen är inloggad — annars gjordes ett bortkastat
    // (och missvisande) hämtningsförsök redan innan inloggning, som satte
    // felaktiga lokala standardvärden istället för den riktiga datan.
    // Beroendet på `session` (inte en tom lista) gör att detta körs på
    // nytt automatiskt direkt efter en lyckad inloggning också — inte bara
    // vid appens allra första start.
    if (!session) { setLoaded(true); return; }
    (async () => {
      let u  = await sget("ow:users");     if (!u)  { u=[DEFAULT_ADMIN];  await sset("ow:users",u);  }
      let i  = await sget("ow:items");     if (!i)  { i=DEFAULT_ITEMS;    await sset("ow:items",i);  }
      let s  = await sget("ow:sales");     if (!s)  { s=[]; }
      let al = await sget("ow:activitylog"); if (!al) { al=[]; }
      let tr = await sget("ow:trash"); if (!tr) { tr=[]; }
      let st = await sget("ow:settings"); if (!st) { st={ companyName:"", companyOrg:"", companyPhone:"", companyAddress:"", defaultMargin:40, currency:"SEK" }; }
      let sup = await sget("ow:suppliers"); if (!sup) { sup=[]; }
      let cust = await sget("ow:customers"); if (!cust) { cust=[]; }
      let fav = await sget("ow:favorites"); if (!fav) { fav=[]; }
      let rl = await sget("ow:roles"); if (!rl || !Array.isArray(rl) || rl.length===0) { rl=DEFAULT_ROLES; await sset("ow:roles",rl); }
      let lst = await sget("ow:lists");
      if (!lst || typeof lst !== "object") { lst = { categories: DEFAULT_CATEGORIES, conditions: DEFAULT_CONDITIONS, sides: DEFAULT_SIDES, locationTypes: DEFAULT_LOCATION_TYPES, warehouses: DEFAULT_WAREHOUSES }; await sset("ow:lists",lst); }
      else {
        lst = {
          categories: lst.categories || DEFAULT_CATEGORIES,
          conditions: lst.conditions || DEFAULT_CONDITIONS,
          sides: lst.sides || DEFAULT_SIDES,
          locationTypes: lst.locationTypes || DEFAULT_LOCATION_TYPES,
          warehouses: lst.warehouses || DEFAULT_WAREHOUSES,
        };
      }

      // Strippa ev. inbäddade bilder så listan hålls lätt och snabb
      if (Array.isArray(i) && i.some(it=>it.images?.length>0)) {
        i = i.map(it => it.images?.length>0 ? {...it, images:[], hasImages:it.images.length} : it);
      }
      // Sätt delta-synk-vattenmärket till senaste kända ändring
      lastSyncRef.current = Array.isArray(i) ? i.reduce((a,it)=>Math.max(a,it.updatedAt||0),0) : 0;

      setUsers(u); setItems(i); setSales(s); setActivityLog(al); setTrash(tr); setSettings(st); setSuppliers(sup); setCustomers(cust); setFavorites(fav); setRoles(rl); setLists(lst); setLoaded(true);

      // Öppna direkt på artikeln om URL:en innehåller ?item=ID (delad länk)
      try {
        const sharedId = new URL(window.location.href).searchParams.get("item");
        if (sharedId) {
          const found = i.find(x=>x.id===sharedId);
          if (found) setStack([{ name:"inventory" }, { name:"detail", props:{item:found} }]);
        }
      } catch {}
    })();
  }, [session]);

  // Håll en ref till stack så polling-intervallet aldrig återskapas
  const stackRef = useRef(stack);
  useEffect(() => { stackRef.current = stack; }, [stack]);

  useEffect(() => {
    // EN enda interval — delta-synk: hämtar BARA ändrade artiklar, inte hela listan.
    // Samma tick uppdaterar även papperskorg och säljlogg i bakgrunden (enklare
    // datatyper, ingen delta-logik behövs för dem) — annars syns t.ex. en tömd
    // papperskorg eller en kollegas försäljning inte förrän man laddar om sidan.
    let tick = 0;
    const id = setInterval(async () => {
      const onEditPage = stackRef.current.some(s => ["edit","sell","checkout","bulkedit","import"].includes(s.name));
      if (onEditPage) return;
      try {
        const r = await fetch(`${API}/delta?since=${lastSyncRef.current}`, { headers: authHeaders() }).then(r=>r.json());
        if (!r || !Array.isArray(r.allIds)) return;
        lastSyncRef.current = r.maxUpdatedAt || lastSyncRef.current;
        setItems(prev => {
          // Inga ändringar och samma antal → behåll exakt samma referens (ingen re-render)
          if ((!r.changed || r.changed.length === 0) && prev.length === r.total) return prev;
          // Bygg en map för snabb uppslagning
          const map = new Map(prev.map(it => [it.id, it]));
          // Applicera ändrade artiklar (strippa ev. bilder för att hålla minnet lågt)
          for (const it of (r.changed || [])) {
            const light = it.images?.length>0 ? {...it, images:[], hasImages:it.images.length} : it;
            map.set(it.id, light);
          }
          // Ta bort artiklar som inte längre finns på servern
          const serverIds = new Set(r.allIds);
          for (const id of map.keys()) if (!serverIds.has(id)) map.delete(id);
          // Bevara serverns ordning
          return r.allIds.map(id => map.get(id)).filter(Boolean);
        });
      } catch {}

      // Allt annat som delas mellan användare — hela listan hämtas var 20:e
      // sekund (varannan tick) istället för varje gång, det är inte lika
      // brådskande som lagerartiklar. Jämför innan vi sätter state så vi
      // inte triggar onödiga omritningar när inget faktiskt ändrats.
      tick++;
      if (tick % 2 === 0) {
        try {
          const [tr, sl, us, al, se, su, fa, ro, li, cu] = await Promise.all([
            sget("ow:trash"), sget("ow:sales"), sget("ow:users"), sget("ow:activitylog"),
            sget("ow:settings"), sget("ow:suppliers"), sget("ow:favorites"), sget("ow:roles"), sget("ow:lists"), sget("ow:customers"),
          ]);
          if (Array.isArray(tr)) setTrash(prev => JSON.stringify(prev)===JSON.stringify(tr) ? prev : tr);
          if (Array.isArray(sl)) setSales(prev => JSON.stringify(prev)===JSON.stringify(sl) ? prev : sl);
          if (Array.isArray(us)) setUsers(prev => JSON.stringify(prev)===JSON.stringify(us) ? prev : us);
          if (Array.isArray(al)) setActivityLog(prev => JSON.stringify(prev)===JSON.stringify(al) ? prev : al);
          if (se) setSettings(prev => JSON.stringify(prev)===JSON.stringify(se) ? prev : se);
          if (Array.isArray(su)) setSuppliers(prev => JSON.stringify(prev)===JSON.stringify(su) ? prev : su);
          if (Array.isArray(fa)) setFavorites(prev => JSON.stringify(prev)===JSON.stringify(fa) ? prev : fa);
          if (Array.isArray(ro)) setRoles(prev => JSON.stringify(prev)===JSON.stringify(ro) ? prev : ro);
          if (li) setLists(prev => JSON.stringify(prev)===JSON.stringify(li) ? prev : li);
          if (Array.isArray(cu)) setCustomers(prev => JSON.stringify(prev)===JSON.stringify(cu) ? prev : cu);
        } catch {}
      }
    }, 10000);
    return () => clearInterval(id);
  }, []); // Tom dependency — körs bara en gång

  const toast$ = useCallback((msg, type="info") => {
    setToast({msg,type}); clearTimeout(tRef.current);
    tRef.current = setTimeout(() => setToast(null), 3000);
  }, []);

  const [sales, setSales] = useState([]);
  const [cart, setCart] = useState(() => {
    // Läs tillbaka kassan om sidan laddats om
    try { const s = localStorage.getItem("ow:cart"); return s ? JSON.parse(s) : []; } catch { return []; }
  });
  const [activityLog, setActivityLog] = useState([]);
  const [trash, setTrash] = useState([]);
  const [settings, setSettings] = useState({ companyName:"", companyOrg:"", companyPhone:"", companyAddress:"", defaultMargin:40, currency:"SEK", lowStockAlert:2 });
  const [suppliers, setSuppliers] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [favorites, setFavorites] = useState([]);
  const [roles, setRoles] = useState(DEFAULT_ROLES);
  const [lists, setLists] = useState({ categories: DEFAULT_CATEGORIES, conditions: DEFAULT_CONDITIONS, sides: DEFAULT_SIDES, locationTypes: DEFAULT_LOCATION_TYPES, warehouses: DEFAULT_WAREHOUSES });

  const saveSales     = useCallback(async v => { setSales(v);     await sset("ow:sales",v);     }, []);
  const saveItems     = useCallback(async v => { setItems(v);     await sset("ow:items",v);     }, []);
  const saveUsers     = useCallback(async v => { setUsers(v);     await sset("ow:users",v);     }, []);
  const saveSettings  = useCallback(async v => { setSettings(v); await sset("ow:settings",v);  }, []);
  const saveSuppliers = useCallback(async v => { setSuppliers(v);await sset("ow:suppliers",v); }, []);
  const saveCustomers = useCallback(async v => { setCustomers(v);await sset("ow:customers",v); }, []);
  const saveRoles = useCallback(async v => { setRoles(v); await sset("ow:roles",v); }, []);
  const saveLists = useCallback(async v => { setLists(v); await sset("ow:lists",v); }, []);
  const saveTrash = useCallback(async v => { setTrash(v); await sset("ow:trash",v); }, []);
  // Flyttar en eller flera artiklar till papperskorgen (håller kvar bilder m.m.)
  // i 30 dagar innan de städas bort automatiskt av servern.
  const moveToTrash = useCallback(async (itemsToTrash, deletedBy) => {
    const arr = Array.isArray(itemsToTrash) ? itemsToTrash : [itemsToTrash];
    if (!arr.length) return;
    // Bilderna ligger kvar orörda på servern (soft-delete rör dem inte) — vi
    // sparar bara metadata i papperskorgen, annars blir den onödigt tung.
    const entries = arr.map(it => ({ ...it, images: [], deletedAt: Date.now(), deletedBy: deletedBy || "Okänd" }));
    setTrash(prev => {
      const next = [...entries, ...prev];
      sset("ow:trash", next);
      return next;
    });
  }, []);
  const saveFavorites = useCallback(async v => { setFavorites(v);await sset("ow:favorites",v); }, []);

  const logActivity = useCallback(async (type, description, extra={}) => {
    const entry = { id:genId("log"), type, description, ...extra, ts:Date.now() };
    reportEvent(type, description); // skicka även till admin-panelens live-flöde
    setActivityLog(prev => {
      const next = [entry, ...prev].slice(0,500);
      sset("ow:activitylog", next);
      return next;
    });
  }, []);

  // Spara kassan lokalt så den överlever en omladdning
  useEffect(() => {
    try { localStorage.setItem("ow:cart", JSON.stringify(cart)); } catch {}
  }, [cart]);

  const addToCart = useCallback((item, qty=1, meta=null) => {
    // Försök låsa delen för kassan — så ingen annan kan sälja/redigera den
    const meUser = (session && Array.isArray(users)) ? (users.find(u=>u.id===session)?.username || "Okänd") : "Okänd";
    lockAcquire(item.id, meUser, "cart").then(r => {
      if (!r.ok && r.lockedBy && r.lockedBy !== meUser) {
        toast$(`${r.lockedBy} ${r.action==="cart"?"har redan den i sin kassa":"redigerar den"} — kunde inte läggas till`, "error");
        return;
      }
      setCart(c => {
        const existing = c.find(r2 => r2.item.id === item.id);
        if (existing) return c.map(r2 => r2.item.id === item.id ? {...r2, qty: r2.qty + qty} : r2);
        return [...c, { item, qty, unitPrice: item.price, discountMode:"pct", discountPct:0, discountKr:0, ...(meta||{}) }];
      });
    });
  }, [session, users]);
  const clearCart = useCallback(() => {
    // Släpp alla kassa-lås
    const meUser = (session && Array.isArray(users)) ? (users.find(u=>u.id===session)?.username || "Okänd") : "Okänd";
    setCart(c => { c.forEach(r => lockRelease(r.item.id, meUser)); return []; });
  }, [session, users]);

  // Must be before any early returns (Rules of Hooks)
  const isMobile = useIsMobile();

  // Synka inloggat användarnamn för API-headers (måste ligga före tidiga returns)
  useEffect(() => {
    const u = (session && Array.isArray(users)) ? (users.find(x=>x.id===session)?.username || null) : null;
    setCurrentUsername(u);
  }, [session, users]);

  // Loggar ut automatiskt om servern svarar 401 (sessionen ogiltig/utgången)
  // — annars sitter man fast i ett trasigt läge där inget laddas men man
  // inte förstår varför. Skickar nu ALLTID till inloggningssidan direkt när
  // detta händer (skickade tidigare bara ut sessionen utan att navigera —
  // man blev stående på en nu låst sida istället för att komma till login).
  useEffect(() => {
    setOnSessionExpired(() => {
      clearSession();
      setCurrentToken(null);
      setSession(null);
      setStack([{ name:"login" }]);
    });
  }, []);

  // ── Tema (mörkt/ljust/system) — sparas per enhet, inte per användare ──
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem("ow:theme") || "system"; } catch { return "system"; }
  });
  useEffect(() => {
    try { localStorage.setItem("ow:theme", theme); } catch {}
    const apply = () => {
      const dark = theme==="dark" || (theme==="system" && window.matchMedia?.("(prefers-color-scheme: dark)").matches);
      document.documentElement.classList.toggle("theme-dark", dark);
    };
    apply();
    if (theme==="system" && window.matchMedia) {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      mq.addEventListener?.("change", apply);
      return () => mq.removeEventListener?.("change", apply);
    }
  }, [theme]);

  // ── Global sökgenväg — tryck "/" varsomhelst för att hoppa till lagrets sök ──
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== "/") return;
      const el = document.activeElement;
      const typing = el && (el.tagName==="INPUT" || el.tagName==="TEXTAREA" || el.tagName==="SELECT" || el.isContentEditable);
      if (typing) return; // låt användaren skriva "/" i ett fält som vanligt
      e.preventDefault();
      if (current?.name !== "inventory") push("inventory");
      // Vänta en tick så sidan hunnit renderas innan vi fokuserar fältet
      setTimeout(() => {
        const input = document.getElementById("main-search-input");
        if (input) { input.focus(); input.select(); }
      }, 60);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current?.name]);

  // Skydd mot en "föräldralös" session — en sparad inloggning (användar-id)
  // som inte längre matchar NÅGON befintlig användare (t.ex. efter en
  // nödåterställning som bytte ut kontona). Token är fortfarande giltig
  // (inga 401 alls), så onSessionExpired triggas aldrig av sig själv i det
  // här fallet — måste upptäckas separat, annars blir man stående på en
  // låst sida utan förklaring istället för att skickas till inloggning.
  // VIKTIGT: måste stå FÖRE "if (!loaded) return" nedan — hooks får aldrig
  // hamna efter ett villkorligt return, annars körs de inte varje gång i
  // samma ordning (Reacts regler för hooks), vilket kraschar hela appen.
  useEffect(() => {
    if (loaded && session && Array.isArray(users) && users.length>0 && !users.some(u=>u.id===session)) {
      clearSession();
      setCurrentToken(null);
      setSession(null);
      setStack([{ name:"login" }]);
      toast$("Din inloggning kunde inte hittas — logga in igen","error");
    }
  }, [loaded, session, users]);

  if (!loaded) return (
    <div style={{minHeight:"100vh",background:BG,display:"flex",alignItems:"center",justifyContent:"center"}}>
      <style>{CSS}</style>
      <div style={{width:32,height:32,border:`3px solid ${BD}`,borderTopColor:BX,borderRadius:"50%",animation:"spin .8s linear infinite"}}/>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );

  const currentUser = (session && Array.isArray(users)) ? users.find(u=>u.id===session) : null;
  const isAdmin = currentUser?.role === "admin";
  // Huvudadmin = admin utan tilldelat hemmalager — obegränsad, som idag.
  // Platsadmin = admin MED ett tilldelat hemmalager — full adminrätt, men
  // bara för sitt eget lager (delar, användare). Samma homeWarehouse-fält
  // som vanliga användare redan har, återanvänt för adminrollen också.
  const isFullAdmin = isAdmin && !currentUser?.homeWarehouse;
  const isPlatsAdmin = isAdmin && !!currentUser?.homeWarehouse;
  const can = p => {
    if (!currentUser) return false; // Inget gästläge — utan inloggning finns ingen behörighet alls
    if (isAdmin) return true;
    // Behörighet från rollen (om användaren har en roll) + ev. egna extra behörigheter
    const role = currentUser.roleId ? roles.find(r => r.id === currentUser.roleId) : null;
    if (role?.permissions?.[p]) return true;
    return !!currentUser.permissions?.[p];
  };
  // Lager-behörighet: kan man redigera/sälja/ta bort DEN HÄR delen, eller
  // bara reservera den (om delen tillhör ett annat lager än ens eget)?
  // Huvudadmin (admin UTAN hemmalager) och vanliga användare utan tilldelat
  // hemmalager är obegränsade. Platsadmin räknas som en vanlig begränsad
  // användare här — bara admin-rättigheterna (användare/roller) är utökade.
  const canManageItem = (item) => {
    if (isFullAdmin) return true;
    if (!currentUser?.homeWarehouse) return true;
    if (!item?.warehouse) return true; // odefinierat lager på delen = ingen begränsning
    return item.warehouse === currentUser.homeWarehouse;
  };

  const sharedProps = { users, items, sales, cart, setCart, addToCart, clearCart, activityLog, logActivity, settings, saveSettings, suppliers, saveSuppliers, customers, saveCustomers, favorites, saveFavorites, saveItems, saveUsers, saveSales, roles, saveRoles, lists, saveLists, session, setSession, currentUser, isAdmin, isFullAdmin, isPlatsAdmin, can, canManageItem, toast$, push, pop, replace, viewMode, setViewMode, filters, applyFilters, search, setSearch, sortPref, setSortPref, setItems, setSales, setSettings, setSuppliers, theme, setTheme, trash, saveTrash, moveToTrash, loaded };
  const showSidebar = !isMobile && currentUser;

  return (
    <div style={{position:"fixed",inset:0,overflow:"hidden",background:BG,display:"flex",flexDirection:"column"}}>
      <style>{CSS}</style>

      {toast && (
        <div className="fade" style={{position:"fixed",bottom:20,left:"50%",transform:"translateX(-50%)",background:toast.type==="error"?R:toast.type==="success"?GR:BX,color:"#fff",padding:"10px 20px",borderRadius:8,zIndex:999,fontSize:13,fontWeight:500,boxShadow:SH2,whiteSpace:"nowrap",pointerEvents:"none"}}>
          {toast.msg}
        </div>
      )}

      {/* PWA Install Banner */}
      {showInstallBanner && (
        <div style={{position:"fixed",bottom:0,left:0,right:0,background:BX,color:WH,padding:"12px 16px",zIndex:998,display:"flex",alignItems:"center",gap:12,boxShadow:"0 -4px 20px rgba(0,0,0,.2)"}}>
          <div style={{width:36,height:36,background:R,borderRadius:8,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,fontSize:18}}>
            <i className="fa-solid fa-box-open"/>
          </div>
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontWeight:700,fontSize:13}}>Installera Lager</div>
            <div style={{fontSize:11,color:"rgba(255,255,255,.7)"}}>Lägg till på hemskärmen</div>
          </div>
          <button onClick={installApp} style={{background:WH,color:BX,border:"none",borderRadius:8,padding:"8px 14px",fontWeight:700,fontSize:13,cursor:"pointer",flexShrink:0}}>
            Installera
          </button>
          <button onClick={dismissInstallBanner} style={{background:"none",border:"none",color:"rgba(255,255,255,.6)",fontSize:18,cursor:"pointer",padding:"4px",flexShrink:0}}>
            ✕
          </button>
        </div>
      )}

      <div style={{display:"flex",flex:1,overflow:"hidden"}}>
        {/* Desktop sidebar */}
        {showSidebar && (
          <div style={{width:220,flexShrink:0,background:WH,borderRight:`1px solid ${BD}`,overflowY:"auto"}}>
            <Sidebar currentUser={currentUser} isAdmin={isAdmin} can={can} push={name=>push(name)} replace={replace} currentPage={current.name} stack={stack} setSession={setSession} toast$={toast$} cart={cart} settings={settings} trash={trash}/>
          </div>
        )}

        {/* Main content */}
        <div style={{flex:1,overflow:"hidden",position:"relative"}}>
          {current.name === "dashboard"    && <DashboardPage    {...sharedProps} />}
          {current.name === "inventory"    && <InventoryPage    {...sharedProps} {...current.props} />}
          {current.name === "detail"       && <DetailPage       {...sharedProps} {...current.props} />}
          {current.name === "filter"       && <FilterPage       {...sharedProps} {...current.props} />}
          {current.name === "edit"         && <EditPage         {...sharedProps} {...current.props} />}
          {current.name === "sell"         && <SellPage         {...sharedProps} {...current.props} />}
          {current.name === "checkout"     && <CheckoutPage     {...sharedProps} />}
          {current.name === "login"        && <LoginPage        {...sharedProps} />}
          {current.name === "users"        && <UsersPage        {...sharedProps} />}
          {current.name === "roles"        && <RolesPage        {...sharedProps} />}
          {current.name === "managelists"  && <ManageListsPage  {...sharedProps} />}
          {current.name === "trash"         && <TrashPage        {...sharedProps} />}
          {current.name === "profile"       && <ProfilePage      {...sharedProps} />}
          {current.name === "menulayout"    && <MenuLayoutPage   {...sharedProps} />}
          {current.name === "emailnotify"   && <EmailNotifyPage  {...sharedProps} />}
          {current.name === "kgkdata"        && <KgkPage          {...sharedProps} />}
          {current.name === "editrole"     && <EditRolePage     {...sharedProps} {...current.props} />}
          {current.name === "edituser"     && <EditUserPage     {...sharedProps} {...current.props} />}
          {current.name === "perms"        && <PermsPage        {...sharedProps} {...current.props} />}
          {current.name === "saleslog"     && <SalesLogPage     {...sharedProps} />}
          {current.name === "reservations" && <ReservationsPage {...sharedProps} />}
          {current.name === "scan"         && <ScanPage         {...sharedProps} {...current.props} />}
          {current.name === "receipt"      && <ReceiptPage      {...sharedProps} {...current.props} />}
          {current.name === "qrlabels"     && <QrLabelsPage     {...sharedProps} {...current.props} />}
          {current.name === "locationview"  && <LocationViewPage {...sharedProps} {...current.props} />}
          {current.name === "nolocation"    && <NoLocationPage    {...sharedProps} />}
          {current.name === "missingitems"  && <MissingItemsPage  {...sharedProps} />}
          {current.name === "import"       && <ImportPage       {...sharedProps} />}
          {current.name === "variants"     && <VariantsPage     {...sharedProps} {...current.props} />}
          {current.name === "reports"      && <ReportsPage      {...sharedProps} />}
          {current.name === "activitylog"  && <ActivityLogPage  {...sharedProps} />}
          {current.name === "settings"     && <SettingsPage     {...sharedProps} />}
          {current.name === "bulkedit"     && <BulkEditPage     {...sharedProps} />}
          {current.name === "suppliers"    && <SuppliersPage    {...sharedProps} />}
          {current.name === "customers"    && <CustomersPage    {...sharedProps} />}
          {current.name === "backup"       && <BackupPage       {...sharedProps} />}
        </div>
      </div>
    </div>
  );
}



// ─── Checkout Page ────────────────────────────────────────────────────────────
function CheckoutPage({ cart, setCart, addToCart, clearCart, items, sales, saveItems, saveSales, currentUser, isAdmin, can, push, pop, toast$, logActivity, customers, saveCustomers }) {
  const [rows, setRows] = useState(() =>
    cart.map(r => ({ priceMode:"incl", discountMode:"pct", discountPct:0, discountKr:0, ...r, key: r.item.id + "-" + (r.key||Date.now()) }))
  );
  // Håll den globala kassan (badge + localStorage) i synk med raderna här
  useEffect(() => { setCart?.(rows); }, [rows]);
  const [buyer, setBuyer] = useState(() => {
    const withCust = cart.find(r=>r.customer||r.regNumber);
    return withCust ? (withCust.customer || withCust.regNumber || "") : "";
  });
  const [customerId, setCustomerId] = useState(null);
  const [anonymous, setAnonymous] = useState(false);
  const [payMethod, setPayMethod] = useState("kontant"); // kontant | swish | kort
  const [cashGiven, setCashGiven] = useState("");
  const [note, setNote] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);
  // Rabatt på HELA köpet, utöver ev. rabatt per rad
  const [wholeDiscMode, setWholeDiscMode] = useState("pct"); // pct | kr
  const [wholeDiscPct, setWholeDiscPct] = useState(0);
  const [wholeDiscKr, setWholeDiscKr] = useState(0);
  // Admin kan välja att INTE registrera köpet i säljloggen (t.ex. intern
  // gratis-utlämning) — lagret minskar ändå, men det syns inte i statistik/logg.
  const [registerSale, setRegisterSale] = useState(true);

  const updateRow = (key, field, val) =>
    setRows(rs => rs.map(r => r.key===key ? {...r, [field]: val} : r));

  const removeRow = (key) => setRows(rs => rs.filter(r => r.key!==key));

  const VAT_RATE = 0.25;
  const addItemToRows = (item) => {
    setRows(rs => {
      const existing = rs.find(r => r.item.id===item.id);
      if (existing) return rs.map(r => r.item.id===item.id ? {...r, qty: r.qty+1} : r);
      return [...rs, { item, qty:1, unitPrice:item.price, priceMode:"incl", discountMode:"pct", discountPct:0, discountKr:0, key: item.id+"-"+Date.now() }];
    });
  };

  // rowTotal: unitPrice tolkas som inkl ELLER exkl moms beroende på radens priceMode.
  // finalPrice/lineTotal är alltid INKL moms (det kunden betalar).
  const rowTotal = r => {
    const base = r.discountMode==="pct"
      ? Math.round(r.unitPrice*(1-r.discountPct/100))
      : Math.max(0, r.unitPrice - r.discountKr);
    const fpIncl = (r.priceMode==="excl") ? Math.round(base*(1+VAT_RATE)) : base;
    const fpExcl = (r.priceMode==="excl") ? base : Math.round(base/(1+VAT_RATE));
    return { finalPrice: fpIncl, finalExcl: fpExcl, lineTotal: r.qty * fpIncl, lineExcl: r.qty * fpExcl };
  };

  const grandTotal = rows.reduce((a,r) => a + rowTotal(r).lineTotal, 0);
  // Rabatt på hela köpet — räknas ovanpå ev. per-rad-rabatter
  const wholeDiscAmount = grandTotal>0 ? (wholeDiscMode==="pct"
    ? Math.round(grandTotal * (wholeDiscPct/100))
    : Math.min(grandTotal, wholeDiscKr)) : 0;
  const finalTotal = Math.max(0, grandTotal - wholeDiscAmount);
  // Andel av helhets-rabatten varje rad ska bära, proportionerligt mot sin andel av totalen
  const wholeDiscShare = r => grandTotal>0 ? (rowTotal(r).lineTotal / grandTotal) * wholeDiscAmount : 0;
  const change = payMethod==="kontant" && cashGiven ? Math.max(0, Number(cashGiven) - finalTotal) : null;
  const canCheckout = rows.length > 0 && rows.every(r => r.qty > 0 && r.qty <= r.item.quantity);

  const checkout = async () => {
    if (!canCheckout) return;
    const now = Date.now();
    const receiptId = genId("rec");
    const saleEntries = rows.map(r => {
      const { finalPrice, finalExcl, lineTotal, lineExcl } = rowTotal(r);
      const effDisc = r.unitPrice>0 ? Math.round((1-(r.priceMode==="excl"?finalExcl:finalPrice)/r.unitPrice)*100) : 0;
      // Den här radens andel av helhets-rabatten, dragen från totalen (exkl. moms proportionerligt)
      const share = wholeDiscShare(r);
      const shareExcl = Math.round(share / (1+VAT_RATE));
      const rowTotalAfterWhole = Math.round(lineTotal - share);
      const rowExclAfterWhole = lineExcl - shareExcl;
      return {
        id: genId("sale"),
        receiptId,
        itemId: r.item.id,
        itemName: r.item.name,
        itemSku: r.item.sku,
        itemStockNumber: r.item.stockNumber||"",
        itemOem: r.item.oem||"",
        itemSide: r.item.side||"",
        qty: r.qty,
        unitPrice: r.qty>0 ? Math.round(rowTotalAfterWhole/r.qty) : finalPrice,
        priceInclVat: finalPrice,
        priceExclVat: finalExcl,
        vatPerUnit: finalPrice - finalExcl,
        vatRate: VAT_RATE,
        totalExclVat: rowExclAfterWhole,
        totalVat: rowTotalAfterWhole - rowExclAfterWhole,
        originalPrice: r.item.price,
        manualPrice: r.unitPrice !== r.item.price ? r.unitPrice : null,
        discount: effDisc,
        discountKr: r.unitPrice - finalPrice,
        wholeDiscountShare: Math.round(share),
        total: rowTotalAfterWhole,
        costPrice: r.item.costPrice||0,
        profit: rowExclAfterWhole - r.qty*(r.item.costPrice||0),
        buyer: buyer.trim()||"Okänd",
        customerId: customerId||null,
        payMethod,
        note: note.trim(),
        soldBy: currentUser?.username||"Okänd",
        soldAt: now,
        registered: registerSale,
        // Snapshot — gör att delen kan återskapas helt om man ångrar köpet
        itemSnapshot: {
          name:r.item.name, oem:r.item.oem, sku:r.item.sku, side:r.item.side,
          stockNumber:r.item.stockNumber, category:r.item.category, condition:r.item.condition,
          make:r.item.make, model:r.item.model, location:r.item.location, locationType:r.item.locationType,
          warehouse:r.item.warehouse,
          regNumber:r.item.regNumber, price:r.item.price, costPrice:r.item.costPrice,
          notes:r.item.notes, supplier:r.item.supplier,
        },
      };
    });

    // Deduct stock
    // Uppdatera varje såld artikel — ta bort om antal når 0
    let latestItems = items;
    for (const entry of saleEntries) {
      const it = latestItems.find(i=>i.id===entry.itemId);
      if (it) {
        // Om raden kom från en reservation — ta bort just den reservationen
        const row = rows.find(r=>r.item.id===entry.itemId);
        const resId = row?.reservationId;
        const trimmedRes = resId ? (it.reservations||[]).filter(x=>x.id!==resId) : it.reservations;
        const newQty = it.quantity - entry.qty;
        if (newQty <= 0) {
          const res = await deleteOneItem(entry.itemId);
          if (res) latestItems = res;
          else latestItems = latestItems.filter(i=>i.id!==entry.itemId);
        } else {
          const updatedItem = {...it, quantity:newQty, reservations:trimmedRes, updatedAt:now};
          const res = await saveOneItem(updatedItem);
          if (res) latestItems = res;
          else latestItems = latestItems.map(i=>i.id===entry.itemId?updatedItem:i);
        }
      }
    }
    saveItems(latestItems);

    // Lagret minskar alltid — men om admin valt att INTE registrera köpet
    // hoppar vi över säljloggen och stor-köp-mejlet (intern gratis-utlämning).
    let finalCustomerId = customerId;
    if (registerSale) {
      // Automatisk kundregistrering — om ett namn angetts men inte redan
      // kopplat till en befintlig kund (via autokompletteringen), skapas
      // en ny kundpost automatiskt. Anonyma köp (inget namn alls) skapar
      // ingen kund — det är precis vad "Anonym"-knappen är till för.
      const buyerName = buyer.trim();
      if (buyerName && !anonymous && !finalCustomerId && saveCustomers) {
        const existingMatch = (customers||[]).find(c => c.name.trim().toLowerCase() === buyerName.toLowerCase());
        if (existingMatch) {
          finalCustomerId = existingMatch.id;
        } else {
          const newCustomer = { id: genId("cust"), name: buyerName, phone:"", email:"", regNumbers:[], notes:"Skapad automatiskt vid köp", createdAt: Date.now() };
          await saveCustomers([newCustomer, ...(customers||[])]);
          finalCustomerId = newCustomer.id;
        }
      }
      const saleEntriesWithCustomer = saleEntries.map(e => ({ ...e, customerId: finalCustomerId||null }));
      await saveSales([...saleEntriesWithCustomer, ...(sales||[])]);
      logActivity&&logActivity("sale", `Kassaköp: ${saleEntries.reduce((a,e)=>a+e.qty,0)} delar för ${finalTotal.toLocaleString("sv-SE")} kr (${buyer.trim()||"Okänd"})`, { user: currentUser?.username });
      fetch("/admin/api/notify",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({type:"large_sale",total:finalTotal,buyer:buyer.trim()||"Okänd",soldBy:currentUser?.username})}).catch(()=>{});
    } else {
      logActivity&&logActivity("sale", `Intern utlämning (ej registrerad): ${saleEntries.reduce((a,e)=>a+e.qty,0)} delar (${buyer.trim()||"Okänd"})`, { user: currentUser?.username });
    }
    clearCart();

    toast$(registerSale ? `Kassa klar — ${finalTotal.toLocaleString("sv-SE")} kr` : "Utlämning klar — ej registrerad i säljlogg", "success");
    push("receipt", { sale: saleEntries[0], receiptRows: saleEntries, payMethod, cashGiven: Number(cashGiven)||0, change: change||0 });
  };

  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQ, setSearchQ] = useState("");
  const searchResults = searchQ.length > 1
    ? items.filter(i => i.quantity > 0 && (i.name.toLowerCase().includes(searchQ.toLowerCase()) || i.sku.toLowerCase().includes(searchQ.toLowerCase()))).slice(0,6)
    : [];

  return (
    <Page flush noAnim>
      <TopBar title="Kassa" onBack={pop} subtitle="Varukorg & betalning" right={
        rows.length>0 ? <button onClick={()=>setConfirmClear(true)} style={{background:"none",border:"none",color:R,fontWeight:600,fontSize:12}}>Töm korg</button> : null
      }/>
      <div style={{flex:1,overflowY:"auto",WebkitOverflowScrolling:"touch",padding:"14px 14px 20px"}}>

        {/* Empty cart */}
        {rows.length===0 && (
          <div style={{textAlign:"center",padding:"60px 20px",color:MU}}>
            <Icon name="cart-shopping" style={{fontSize:48,display:"block",margin:"0 auto 16px",color:BD}}/>
            <div style={{fontWeight:700,fontSize:15,marginBottom:8}}>Korgen är tom</div>
            <div style={{fontSize:13,marginBottom:20}}>Lägg till delar från lagerlistan med korg-knappen</div>
            <Btn onClick={()=>push("inventory")}>Gå till lagret</Btn>
          </div>
        )}

        {/* Cart rows */}
        {rows.map(r => {
          const { finalPrice, finalExcl, lineTotal, lineExcl } = rowTotal(r);
          const priceChanged = r.unitPrice !== r.item.price;
          const hasDisc = r.discountPct>0 || r.discountKr>0;
          const overStock = r.qty > r.item.quantity;
          return (
            <div key={r.key} style={{background:WH,borderRadius:10,border:`1px solid ${overStock?R:BD}`,padding:14,marginBottom:10}}>
              <div style={{display:"flex",gap:10,marginBottom:10}}>
                <div style={{width:44,height:44,borderRadius:7,overflow:"hidden",background:BG,border:`1px solid ${BD}`,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                  {(r.item.thumb||r.item.images?.[0])?<img src={r.item.thumb||r.item.images[0]} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}}/>:<Icon name="wrench" style={{color:MU}}/>}
                </div>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{display:"flex",alignItems:"center",gap:5,marginBottom:2}}>
                    {r.item.stockNumber&&<span style={{background:BX,color:WH,borderRadius:4,padding:"1px 6px",fontSize:10,fontWeight:800,flexShrink:0}}>#{r.item.stockNumber}</span>}
                    <div style={{fontWeight:700,fontSize:13,lineHeight:1.3,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{r.item.name}{r.item.side?` — ${r.item.side}`:""}</div>
                  </div>
                  <div style={{fontSize:11,color:MU}}>I lager: <span style={{color:sc(r.item.quantity),fontWeight:600}}>{r.item.quantity} st</span></div>
                </div>
                <button onClick={()=>removeRow(r.key)} style={{background:"none",border:"none",color:MU,fontSize:16,padding:"2px 4px",flexShrink:0}}>✕</button>
              </div>

              {/* Qty + Price + Discount */}
              <div style={{display:"grid",gridTemplateColumns:"80px 1fr 1fr",gap:8,marginBottom:8}}>
                <div>
                  <label style={{display:"block",fontSize:10,fontWeight:700,color:MU,textTransform:"uppercase",marginBottom:3}}>Antal</label>
                  <div style={{display:"flex",alignItems:"center",border:`1.5px solid ${overStock?R:BD}`,borderRadius:6,overflow:"hidden"}}>
                    <button onClick={()=>updateRow(r.key,"qty",Math.max(1,r.qty-1))} style={{padding:"6px 8px",background:BG,border:"none",fontWeight:700,fontSize:14,cursor:"pointer"}}>−</button>
                    <input type="number" min="1" value={r.qty} onChange={e=>updateRow(r.key,"qty",Math.max(1,Number(e.target.value)))}
                      style={{width:"100%",textAlign:"center",border:"none",fontSize:13,fontWeight:700,padding:"6px 0",color:overStock?R:TX}}/>
                    <button onClick={()=>updateRow(r.key,"qty",r.qty+1)} style={{padding:"6px 8px",background:BG,border:"none",fontWeight:700,fontSize:14,cursor:"pointer"}}>+</button>
                  </div>
                  {overStock && <div style={{fontSize:9,color:R,fontWeight:700,marginTop:2}}>Max {r.item.quantity}</div>}
                </div>

                <div>
                  <label style={{display:"flex",justifyContent:"space-between",alignItems:"center",fontSize:10,fontWeight:700,color:priceChanged?BX:MU,textTransform:"uppercase",marginBottom:3,gap:2}}>
                    <span>Pris/st</span>
                    <div style={{display:"flex",gap:2,background:BG,borderRadius:4,padding:1}}>
                      <button onClick={()=>updateRow(r.key,"priceMode","incl")} style={{padding:"1px 5px",borderRadius:3,border:"none",background:(r.priceMode||"incl")==="incl"?WH:"transparent",color:(r.priceMode||"incl")==="incl"?BX:MU,fontSize:9,fontWeight:700,cursor:"pointer"}}>ink</button>
                      <button onClick={()=>updateRow(r.key,"priceMode","excl")} style={{padding:"1px 5px",borderRadius:3,border:"none",background:r.priceMode==="excl"?WH:"transparent",color:r.priceMode==="excl"?BX:MU,fontSize:9,fontWeight:700,cursor:"pointer"}}>exk</button>
                    </div>
                  </label>
                  <input type="number" min="0" value={r.unitPrice} onChange={e=>updateRow(r.key,"unitPrice",Math.max(0,Number(e.target.value)))}
                    style={{width:"100%",padding:"7px 8px",border:`1.5px solid ${priceChanged?BX:BD}`,borderRadius:6,fontSize:13,fontWeight:priceChanged?700:400,color:priceChanged?BX:TX,background:priceChanged?B+"08":WH}}/>
                </div>

                <div>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:3}}>
                    <label style={{fontSize:10,fontWeight:700,color:hasDisc?AM:MU,textTransform:"uppercase"}}>Rabatt</label>
                    <div style={{display:"flex",gap:2,background:BG,borderRadius:4,padding:1}}>
                      <button onClick={()=>{ updateRow(r.key,"discountMode","pct"); updateRow(r.key,"discountKr",0); }}
                        style={{padding:"2px 6px",borderRadius:3,border:"none",background:r.discountMode==="pct"?WH:"transparent",color:r.discountMode==="pct"?BX:MU,fontSize:9,fontWeight:700,cursor:"pointer"}}>%</button>
                      <button onClick={()=>{ updateRow(r.key,"discountMode","kr"); updateRow(r.key,"discountPct",0); }}
                        style={{padding:"2px 6px",borderRadius:3,border:"none",background:r.discountMode==="kr"?WH:"transparent",color:r.discountMode==="kr"?BX:MU,fontSize:9,fontWeight:700,cursor:"pointer"}}>kr</button>
                    </div>
                  </div>
                  {r.discountMode==="pct"
                    ? <input type="number" min="0" max="100" value={r.discountPct} onChange={e=>updateRow(r.key,"discountPct",Math.min(100,Math.max(0,Number(e.target.value))))}
                        placeholder="0" style={{width:"100%",padding:"7px 8px",border:`1.5px solid ${hasDisc?AM:BD}`,borderRadius:6,fontSize:13}}/>
                    : <input type="number" min="0" value={r.discountKr} onChange={e=>updateRow(r.key,"discountKr",Math.max(0,Number(e.target.value)))}
                        placeholder="0" style={{width:"100%",padding:"7px 8px",border:`1.5px solid ${hasDisc?AM:BD}`,borderRadius:6,fontSize:13}}/>
                  }
                </div>
              </div>

              {/* Row total */}
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",paddingTop:8,borderTop:`1px solid ${BD}50`}}>
                <div style={{fontSize:11,color:MU}}>{r.qty} st · {lineExcl.toLocaleString("sv-SE")} exkl + {(lineTotal-lineExcl).toLocaleString("sv-SE")} moms</div>
                <div style={{fontWeight:800,fontSize:15,color:BX}}>{lineTotal.toLocaleString("sv-SE")} kr</div>
              </div>
            </div>
          );
        })}

        {/* Add more items search */}
        {rows.length>0 && (
          <div style={{marginBottom:14}}>
            {!searchOpen
              ? <button onClick={()=>setSearchOpen(true)} style={{width:"100%",padding:"10px",borderRadius:8,border:`1.5px dashed ${BD}`,background:"transparent",color:MU,fontSize:13,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:6}}>
                  <Icon name="plus"/> Lägg till fler delar
                </button>
              : <div>
                  <input autoFocus value={searchQ} onChange={e=>setSearchQ(e.target.value)} placeholder="Sök artikel att lägga till..."
                    style={{width:"100%",padding:"10px 12px",border:`1.5px solid ${BX}`,borderRadius:8,fontSize:13,marginBottom:6}}/>
                  {searchResults.length>0 && (
                    <div style={{background:WH,borderRadius:8,border:`1px solid ${BD}`,overflow:"hidden"}}>
                      {searchResults.map(i=>(
                        <button key={i.id} onClick={()=>{ addItemToRows(i); setSearchQ(""); setSearchOpen(false); }}
                          style={{width:"100%",textAlign:"left",padding:"10px 12px",border:"none",borderBottom:`1px solid ${BD}50`,background:WH,cursor:"pointer",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                          <div>
                            <div style={{fontWeight:600,fontSize:13}}>{i.name}{i.side?` — ${i.side}`:""}</div>
                            <div style={{fontSize:11,color:MU}}>{i.sku} · {i.quantity} i lager</div>
                          </div>
                          <div style={{fontWeight:700,color:BX,fontSize:13}}>{i.price.toLocaleString("sv-SE")} kr</div>
                        </button>
                      ))}
                    </div>
                  )}
                  <button onClick={()=>{setSearchOpen(false);setSearchQ("");}} style={{marginTop:4,background:"none",border:"none",color:MU,fontSize:12,cursor:"pointer"}}>Avbryt</button>
                </div>
            }
          </div>
        )}

        {/* Buyer + Note */}
        {rows.length>0 && (
          <div style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,padding:14,marginBottom:14,display:"flex",flexDirection:"column",gap:10}}>
            {anonymous ? (
              <div style={{display:"flex",alignItems:"center",gap:10,background:BG,borderRadius:8,padding:"10px 12px"}}>
                <Icon name="user-secret" style={{color:MU}}/>
                <span style={{flex:1,fontSize:13,fontWeight:600,color:TM}}>Anonym försäljning — ingen kund registreras</span>
                <button onClick={()=>{setAnonymous(false);setBuyer("");}} style={{background:"none",border:"none",color:BX,fontWeight:700,fontSize:12,cursor:"pointer"}}>Ångra</button>
              </div>
            ) : (
              <>
                <CustomerPicker customers={customers} value={buyer} onChange={v=>{setBuyer(v);setCustomerId(null);}} onSelectCustomer={c=>{setBuyer(c.name);setCustomerId(c.id);}} label="Kund / köpare (valfritt)"/>
                <button onClick={()=>{setAnonymous(true);setBuyer("Privatkund (anonym)");setCustomerId(null);}} style={{alignSelf:"flex-start",background:"none",border:"none",color:MU,fontSize:12,fontWeight:600,cursor:"pointer",padding:0,display:"flex",alignItems:"center",gap:5}}>
                  <Icon name="user-secret"/> Sälj anonymt (privatkund, ingen registrering)
                </button>
              </>
            )}
            <div>
              <label style={{display:"block",fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:4}}>Notering (valfritt)</label>
              <textarea value={note} onChange={e=>setNote(e.target.value)} rows={2} placeholder="T.ex. fordonsinfo, avtalt pris..."
                style={{width:"100%",border:`1.5px solid ${BD}`,borderRadius:6,padding:"9px 12px",fontSize:13,resize:"none",fontFamily:"inherit",color:TX}}/>
            </div>
          </div>
        )}

        {/* Payment method */}
        {rows.length>0 && (
          <div style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,padding:14,marginBottom:14}}>
            <div style={{fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:10}}>Betalningssätt</div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:12}}>
              {[["kontant","Kontant"],["swish","Swish"],["kort","Kort"]].map(([k,l])=>(
                <button key={k} onClick={()=>setPayMethod(k)}
                  style={{padding:"10px 6px",borderRadius:8,border:`2px solid ${payMethod===k?BX:BD}`,background:payMethod===k?B+"08":WH,color:payMethod===k?BX:TX,fontWeight:payMethod===k?700:500,fontSize:13,cursor:"pointer"}}>
                  {l}
                </button>
              ))}
            </div>
            {payMethod==="kontant" && (
              <div>
                <Inp label="Betalt med (kr)" type="number" min="0" value={cashGiven} onChange={e=>setCashGiven(e.target.value)} placeholder={finalTotal.toString()}/>
                {cashGiven && Number(cashGiven) >= finalTotal && (
                  <div style={{display:"flex",justifyContent:"space-between",marginTop:8,padding:"10px 12px",background:GR+"10",borderRadius:8,border:`1px solid ${GR}30`}}>
                    <span style={{fontWeight:600,color:GR}}>Växel tillbaka</span>
                    <span style={{fontWeight:800,fontSize:16,color:GR}}>{(Number(cashGiven)-finalTotal).toLocaleString("sv-SE")} kr</span>
                  </div>
                )}
                {cashGiven && Number(cashGiven) < finalTotal && (
                  <div style={{marginTop:6,fontSize:11,color:R,fontWeight:600}}>
                    Saknas: {(finalTotal-Number(cashGiven)).toLocaleString("sv-SE")} kr
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Rabatt på HELA köpet — utöver ev. rabatt per rad */}
        {rows.length>0&&(
          <div style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,padding:14,marginTop:14}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
              <span style={{fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7}}>Rabatt på hela köpet</span>
              <div style={{display:"flex",gap:2,background:BG,borderRadius:5,padding:2}}>
                <button onClick={()=>{setWholeDiscMode("pct");setWholeDiscKr(0);}} style={{padding:"3px 10px",borderRadius:4,border:"none",background:wholeDiscMode==="pct"?WH:"transparent",color:wholeDiscMode==="pct"?BX:MU,fontSize:11,fontWeight:700,cursor:"pointer",boxShadow:wholeDiscMode==="pct"?SH:"none"}}>%</button>
                <button onClick={()=>{setWholeDiscMode("kr");setWholeDiscPct(0);}} style={{padding:"3px 10px",borderRadius:4,border:"none",background:wholeDiscMode==="kr"?WH:"transparent",color:wholeDiscMode==="kr"?BX:MU,fontSize:11,fontWeight:700,cursor:"pointer",boxShadow:wholeDiscMode==="kr"?SH:"none"}}>kr</button>
              </div>
            </div>
            {wholeDiscMode==="pct"
              ? <input type="number" min="0" max="100" value={wholeDiscPct} onChange={e=>setWholeDiscPct(Math.min(100,Math.max(0,Number(e.target.value))))} placeholder="0" style={{width:"100%",padding:"9px 12px",border:`1.5px solid ${wholeDiscPct>0?AM:BD}`,borderRadius:7,fontSize:14,boxSizing:"border-box"}}/>
              : <input type="number" min="0" value={wholeDiscKr} onChange={e=>setWholeDiscKr(Math.max(0,Number(e.target.value)))} placeholder="0" style={{width:"100%",padding:"9px 12px",border:`1.5px solid ${wholeDiscKr>0?AM:BD}`,borderRadius:7,fontSize:14,boxSizing:"border-box"}}/>
            }
            {wholeDiscAmount>0&&(
              <div style={{marginTop:10,paddingTop:10,borderTop:`1px solid ${BD}50`}}>
                <div style={{display:"flex",justifyContent:"space-between",fontSize:12,color:MU,marginBottom:3}}>
                  <span>Delsumma</span><span style={{textDecoration:"line-through"}}>{grandTotal.toLocaleString("sv-SE")} kr</span>
                </div>
                <div style={{display:"flex",justifyContent:"space-between",fontSize:12,color:AM,marginBottom:3}}>
                  <span>Rabatt</span><span>-{wholeDiscAmount.toLocaleString("sv-SE")} kr</span>
                </div>
                <div style={{display:"flex",justifyContent:"space-between",fontSize:14,fontWeight:800,color:TX}}>
                  <span>Att betala</span><span>{finalTotal.toLocaleString("sv-SE")} kr</span>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Admin: registrera köpet i säljloggen eller inte (intern utlämning) */}
        {rows.length>0&&isAdmin&&(
          <div style={{background:registerSale?WH:AM+"10",borderRadius:10,border:`1px solid ${registerSale?BD:AM}`,padding:14,marginTop:10,display:"flex",alignItems:"center",gap:12}}>
            <div style={{flex:1}}>
              <div style={{fontWeight:700,fontSize:13}}>Registrera i säljlogg</div>
              <div style={{fontSize:11,color:MU,marginTop:2}}>Av = lagret minskar ändå, men köpet syns inte i säljlogg/statistik (t.ex. intern utlämning)</div>
            </div>
            <button onClick={()=>setRegisterSale(v=>!v)} style={{width:44,height:24,borderRadius:12,border:"none",background:registerSale?GR:BD,position:"relative",cursor:"pointer",flexShrink:0}}>
              <div style={{width:18,height:18,borderRadius:"50%",background:WH,position:"absolute",top:3,left:registerSale?23:3,transition:"left .15s"}}/>
            </button>
          </div>
        )}
      </div>

      {/* Fast fot — sitter alltid längst ner (flex-barn, inte fixed) */}
      {rows.length>0 && (
        <div style={{flexShrink:0,background:WH,borderTop:`1px solid ${BD}`,padding:"12px 14px",paddingBottom:"max(12px,env(safe-area-inset-bottom))",boxShadow:"0 -4px 20px rgba(0,0,0,.08)"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
            <div style={{fontSize:12,color:MU}}>{rows.reduce((a,r)=>a+r.qty,0)} delar · {rows.length} artiklar</div>
            <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:24,fontWeight:800,color:BX}}>{finalTotal.toLocaleString("sv-SE")} kr</div>
          </div>
          <Btn full variant={registerSale?"red":"ghost"} onClick={checkout} disabled={!canCheckout} style={{padding:"13px",fontSize:15,...(registerSale?{}:{border:`2px solid ${AM}`,color:AM})}}>
            <Icon name={registerSale?"cash-register":"box-open"}/> {registerSale?"Slutför kassa":"Lämna ut (ej registrerat)"}
          </Btn>
        </div>
      )}

      {confirmClear && (
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.4)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:200,padding:20}} onClick={()=>setConfirmClear(false)}>
          <div onClick={e=>e.stopPropagation()} style={{background:WH,borderRadius:14,padding:20,maxWidth:320,width:"100%"}}>
            <div style={{fontWeight:700,fontSize:15,marginBottom:8}}>Töm korgen?</div>
            <div style={{fontSize:13,color:MU,marginBottom:16}}>Alla {rows.length} artiklar tas bort från kassan.</div>
            <div style={{display:"flex",gap:8}}>
              <Btn full variant="ghost" onClick={()=>setConfirmClear(false)}>Avbryt</Btn>
              <Btn full variant="red" onClick={()=>{ setRows([]); clearCart(); setConfirmClear(false); }}>Töm</Btn>
            </div>
          </div>
        </div>
      )}
    </Page>
  );
}


// ─── Dashboard Page ───────────────────────────────────────────────────────────

// ─── Scan Page (QR / Streckkod simulering via kamera + manuell input) ─────────
function ScanPage({ items, push, pop, toast$ }) {
  const [manualCode, setManualCode] = useState("");
  const [scanning, setScanning] = useState(false);
  const [lastResult, setLastResult] = useState(null);
  const [cameraError, setCameraError] = useState(null);
  const [continuous, setContinuous] = useState(true);
  const [recentScans, setRecentScans] = useState([]);
  const [devices, setDevices] = useState([]);
  const [deviceIdx, setDeviceIdx] = useState(0);
  const videoRef = useRef(null);
  const readerRef = useRef(null);
  const lastScanRef = useRef({ code: null, ts: 0 });

  useEffect(() => {
    return () => { stopCamera(); };
  }, []);

  const loadZXing = () => new Promise((resolve, reject) => {
    if (window.ZXing) { resolve(window.ZXing); return; }
    const s = document.createElement("script");
    s.src = "https://unpkg.com/@zxing/library@0.19.1/umd/index.min.js";
    s.onload = () => resolve(window.ZXing);
    s.onerror = reject;
    document.head.appendChild(s);
  });

  // Kort pip + vibration vid en lyckad skanning — ger tydlig återkoppling
  // utan att behöva titta på skärmen hela tiden (praktiskt när man skannar
  // många delar i rad, t.ex. vid en inventering).
  const beep = () => {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
      osc.start(); osc.stop(ctx.currentTime + 0.15);
    } catch {}
    if (navigator.vibrate) navigator.vibrate(80);
  };

  const startCamera = async (chosenDeviceId) => {
    setCameraError(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError("Webbläsaren saknar kamerastöd. Kräver HTTPS eller localhost.");
      return;
    }
    try {
      const ZXing = await loadZXing();
      const hints = new Map();
      hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
      const reader = new ZXing.BrowserMultiFormatReader(hints);
      readerRef.current = reader;
      setScanning(true);

      // Lista tillgängliga kameror (för växlingsknappen) — bara första gången
      if (devices.length === 0) {
        try {
          const cams = await ZXing.BrowserMultiFormatReader.listVideoInputDevices();
          setDevices(cams);
        } catch {}
      }

      await reader.decodeFromVideoDevice(chosenDeviceId || null, videoRef.current, (result) => {
        if (!result) return;
        const code = result.getText();
        const now = Date.now();
        // Undvik att samma kod triggar flera gånger i rad om kameran ligger
        // still riktad mot samma etikett en stund
        if (lastScanRef.current.code === code && now - lastScanRef.current.ts < 2500) return;
        lastScanRef.current = { code, ts: now };
        beep();
        lookup(code);
        if (!continuous) stopCamera();
      });
    } catch (err) {
      let msg = "Kunde inte starta kameran.";
      if (err?.name === "NotAllowedError") msg = "Kameraåtkomst nekades. Tillåt kameran i webbläsarens inställningar.";
      else if (err?.name === "NotFoundError") msg = "Ingen kamera hittades på enheten.";
      else if (err?.name === "NotReadableError") msg = "Kameran används redan av en annan app.";
      else if (window.location.protocol !== "https:" && window.location.hostname !== "localhost") msg = "Kameran kräver HTTPS. Fungerar bara på localhost eller säkra anslutningar.";
      setCameraError(msg);
      setScanning(false);
      toast$(msg,"error");
    }
  };

  const switchCamera = () => {
    if (devices.length < 2) return;
    const nextIdx = (deviceIdx + 1) % devices.length;
    setDeviceIdx(nextIdx);
    stopCamera();
    setTimeout(() => startCamera(devices[nextIdx].deviceId), 200);
  };

  const stopCamera = () => {
    if (readerRef.current) {
      try { readerRef.current.reset(); } catch {}
      readerRef.current = null;
    }
    setScanning(false);
  };

  const lookup = (code) => {
    const c = code.trim();
    // Låd-QR — börjar med "LAGERBOX:" (se LocationViewPage) — visa allt i lådan direkt
    if (c.startsWith("LAGERBOX:")) {
      const loc = c.slice("LAGERBOX:".length);
      const exists = items.some(i => [i.locationType, i.location].filter(Boolean).join(" — ") === loc);
      if (!exists) { toast$(`Hittade ingen låda som matchar: ${loc}`,"error"); return; }
      toast$(`Visar innehåll i: ${loc}`,"success");
      push("locationview", { initialExpand: loc });
      return;
    }
    // Lagernummer prioriteras — det är alltid unikt (artikelnummer kan
    // finnas på flera identiska delar, t.ex. 5 likadana stötfångare)
    const matches = items.filter(i => i.stockNumber===c || i.oem===c || i.sku===c || i.id===c || i.alternativeNumbers?.includes(c));
    if (matches.length === 0) {
      setLastResult(null);
      toast$(`Ingen artikel matchade: ${c}`,"error");
    } else if (matches.length > 1) {
      toast$(`Hittade ${matches.length} exemplar`,"success");
      setRecentScans(r => [{ code:c, name: matches[0].name, count: matches.length, ts: Date.now() }, ...r].slice(0,8));
      push("variants", {sku: matches[0].sku});
    } else {
      setLastResult(matches[0]);
      setRecentScans(r => [{ code:c, name: matches[0].name, count: 1, ts: Date.now() }, ...r].slice(0,8));
      toast$(`Hittade: ${matches[0].name}`,"success");
    }
  };

  const submitManual = () => {
    if (!manualCode.trim()) return;
    lookup(manualCode.trim());
    setManualCode("");
  };

  return (
    <Page>
      <TopBar title="Skanna" subtitle="QR-kod eller streckkod" onBack={()=>{stopCamera();pop();}}/>
      <div style={{padding:"14px 14px 60px"}}>

        <div style={{background:WH,borderRadius:12,border:`1px solid ${BD}`,overflow:"hidden",marginBottom:14}}>
          {scanning?(
            <div style={{position:"relative",aspectRatio:"4/3",background:"#000"}}>
              <video ref={videoRef} autoPlay playsInline muted style={{width:"100%",height:"100%",objectFit:"cover"}}/>
              <div style={{position:"absolute",top:"50%",left:"50%",transform:"translate(-50%,-50%)",width:"70%",height:"35%",border:`3px solid ${BX}`,borderRadius:8,boxShadow:"0 0 0 9999px rgba(0,0,0,.3)"}}/>
              <div style={{position:"absolute",bottom:12,left:0,right:0,textAlign:"center",color:"#fff",fontSize:12,fontWeight:600}}>Rikta mot QR-kod eller streckkod</div>
              {devices.length>1&&(
                <button onClick={switchCamera} style={{position:"absolute",top:10,right:10,background:"rgba(0,0,0,.5)",border:"none",borderRadius:8,padding:"8px 10px",color:"#fff",cursor:"pointer"}}>
                  <Icon name="camera-rotate"/>
                </button>
              )}
            </div>
          ):(
            <div style={{padding:40,textAlign:"center"}}>
              <div style={{display:"flex",gap:16,justifyContent:"center",marginBottom:14}}>
                <Icon name="qrcode" style={{fontSize:40,color:BD}}/>
                <Icon name="barcode" style={{fontSize:40,color:BD}}/>
              </div>
              <div style={{fontSize:13,color:MU,marginBottom:16}}>Starta kameran för att skanna QR-kod eller streckkod (EAN, UPC, Code128 m.fl.)</div>
              <Btn onClick={()=>startCamera()}><Icon name="camera"/> Starta kamera</Btn>
              {cameraError&&(
                <div style={{marginTop:14,background:R+"10",border:`1px solid ${R}30`,borderRadius:8,padding:"10px 12px",fontSize:12,color:R,textAlign:"left"}}>
                  <i className="fa-solid fa-triangle-exclamation" style={{marginRight:6}}/>{cameraError}
                </div>
              )}
            </div>
          )}
        </div>

        {scanning&&(
          <div style={{display:"flex",gap:8,marginBottom:14}}>
            <Btn full variant="ghost" onClick={stopCamera}>Stäng kamera</Btn>
            <button onClick={()=>setContinuous(c=>!c)} style={{display:"flex",alignItems:"center",gap:8,padding:"0 14px",border:`1.5px solid ${continuous?BX:BD}`,borderRadius:8,background:continuous?BX+"10":WH,color:continuous?BX:MU,fontSize:12,fontWeight:700,cursor:"pointer",whiteSpace:"nowrap"}}>
              <Icon name={continuous?"toggle-on":"toggle-off"}/> Fortsätt skanna
            </button>
          </div>
        )}

        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10}}>
          <div style={{flex:1,height:1,background:BD}}/>
          <span style={{fontSize:11,color:MU,fontWeight:600}}>ELLER ANGE MANUELLT</span>
          <div style={{flex:1,height:1,background:BD}}/>
        </div>

        <div style={{display:"flex",gap:8,marginBottom:16}}>
          <input value={manualCode} onChange={e=>setManualCode(e.target.value)} onKeyDown={e=>e.key==="Enter"&&submitManual()} placeholder="Artikelnummer" style={{flex:1,padding:"10px 12px",border:`1.5px solid ${BD}`,borderRadius:8,fontSize:13}}/>
          <Btn onClick={submitManual}>Sök</Btn>
        </div>

        {lastResult&&(
          <div onClick={()=>push("detail",{item:lastResult})} style={{background:GR+"10",border:`1px solid ${GR}30`,borderRadius:10,padding:14,cursor:"pointer",marginBottom:14}}>
            <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:6}}>
              <Icon name="check" style={{color:GR}}/>
              <span style={{fontSize:11,fontWeight:700,color:GR,textTransform:"uppercase"}}>Hittad artikel</span>
            </div>
            <div style={{fontWeight:700,fontSize:15}}>{lastResult.name}{lastResult.side?` — ${lastResult.side}`:""}</div>
            <div style={{fontSize:12,color:MU,marginTop:2}}>{lastResult.quantity} st i lager</div>
            <div style={{fontSize:12,color:BX,fontWeight:600,marginTop:6}}>Tryck för att öppna →</div>
          </div>
        )}

        {recentScans.length>0&&(
          <div>
            <div style={{fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:8}}>Senaste skanningarna denna session</div>
            <div style={{display:"flex",flexDirection:"column",gap:6}}>
              {recentScans.map((r,idx)=>(
                <div key={idx} style={{display:"flex",alignItems:"center",gap:10,background:WH,border:`1px solid ${BD}`,borderRadius:8,padding:"8px 12px"}}>
                  <Icon name="qrcode" style={{color:MU,fontSize:13}}/>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontSize:12.5,fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{r.name}{r.count>1?` (${r.count} exemplar)`:""}</div>
                  </div>
                  <span style={{fontSize:10,color:MU}}>{new Date(r.ts).toLocaleTimeString("sv-SE",{hour:"2-digit",minute:"2-digit"})}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </Page>
  );
}

// Naturlig sortering — "Låda 2" ska komma före "Låda 10", inte efter (som
// vanlig bokstavssortering skulle ge eftersom "1" < "2" tecken för tecken).
function naturalCompare(a, b) {
  const re = /(\d+)|(\D+)/g;
  const pa = a.match(re) || [];
  const pb = b.match(re) || [];
  const len = Math.max(pa.length, pb.length);
  for (let i=0;i<len;i++) {
    const xa = pa[i]||"", xb = pb[i]||"";
    const na = parseInt(xa,10), nb = parseInt(xb,10);
    if (!isNaN(na) && !isNaN(nb) && /^\d+$/.test(xa) && /^\d+$/.test(xb)) {
      if (na!==nb) return na-nb;
    } else {
      const c = xa.localeCompare(xb,"sv");
      if (c!==0) return c;
    }
  }
  return 0;
}

// ─── Location View Page ────────────────────────────────────────────────────────
function LocationViewPage({ items, saveItems, lists, saveLists, pop, push, can, isAdmin, toast$, initialExpand }) {
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [expanded, setExpanded] = useState(initialExpand || null);
  const [movingId, setMovingId] = useState(null); // vilken del som just nu visar flytt-panelen
  const [moveType, setMoveType] = useState("");
  const [moveLoc, setMoveLoc] = useState("");
  const [moveParent, setMoveParent] = useState("");
  const [confirmDeleteLoc, setConfirmDeleteLoc] = useState(null);
  const [settingParentFor, setSettingParentFor] = useState(null); // vilken plats-grupp som just nu väljer sin "ligger på"-plats
  const [parentPick, setParentPick] = useState("");

  const norm = s => (s||"").trim().toLowerCase();
  // En plats identifieras av TYP + NAMN + VAR DEN SJÄLV FINNS (parentLocation)
  // — annars skulle t.ex. två olika "Låda 1" (en i Hisshylla 2, en på Hylla
  // 1A) råka slås ihop till en enda plats bara för att de råkar heta
  // likadant. parentLocation gör dem entydigt olika platser istället.
  const fullKey = i => [i.locationType, i.location, i.parentLocation].filter(Boolean).join(" — ");
  // Smart gruppering — "Låda 1" och "låda 1" är samma plats (oavsett
  // skiftläge/mellanslag), MEN bara om de även har samma parentLocation.
  // Grupperas på en normaliserad nyckel, visas med den vanligaste faktiska
  // skrivningen (så en enstaka felstavning inte "vinner" och byter visning).
  const groups = {};
  items.forEach(i => {
    const full = fullKey(i);
    if (!i.location) return;
    const key = norm(full);
    if (!groups[key]) groups[key] = { display: [i.locationType,i.location].filter(Boolean).join(" — "), parent: i.parentLocation||"", count: {} };
    const d = [i.locationType,i.location].filter(Boolean).join(" — ");
    groups[key].count[d] = (groups[key].count[d]||0) + 1;
    if (groups[key].count[d] > (groups[key].count[groups[key].display]||0)) groups[key].display = d;
  });
  const locations = Object.entries(groups)
    .map(([key,g]) => ({ key, display:g.display, parent:g.parent, locationType: items.find(i=>norm(fullKey(i))===key)?.locationType||"" }))
    .sort((a,b)=>naturalCompare(a.display,b.display) || naturalCompare(a.parent,b.parent));

  const filtered = locations.filter(l =>
    (!search || l.display.toLowerCase().includes(search.toLowerCase()) || l.parent.toLowerCase().includes(search.toLowerCase())) &&
    (!typeFilter || l.locationType === typeFilter)
  );
  const getItems = (locKey) => items.filter(i => norm(fullKey(i)) === locKey);
  const noLocationCount = items.filter(i => !i.location).length;
  const missingCount = items.filter(i => i.missing).length;

  // Sätter "var den här platsen själv finns" på ALLA delar i gruppen på en
  // gång — t.ex. att alla delar i "Låda 12" får parentLocation "Hylla A3".
  const setParent = async (locKey, parentDisplay) => {
    const affected = getItems(locKey);
    await saveItems(items.map(i => affected.some(a=>a.id===i.id) ? {...i, parentLocation: parentDisplay} : i));
    setSettingParentFor(null); setParentPick("");
    toast$(parentDisplay?`Plats kopplad till ${parentDisplay}`:"Koppling borttagen","success");
  };

  const startMove = (item) => {
    setMovingId(item.id);
    setMoveType(item.locationType||"");
    setMoveLoc(item.location||"");
    setMoveParent(item.parentLocation||"");
  };
  const cancelMove = () => { setMovingId(null); setMoveType(""); setMoveLoc(""); setMoveParent(""); };
  const confirmMove = async (item) => {
    await saveItems(items.map(i => i.id===item.id ? {...i, locationType:moveType, location:moveLoc, parentLocation:moveParent} : i));
    toast$(`${item.name} flyttad till ${[moveType,moveLoc].filter(Boolean).join(" — ")||"ingen plats"}`,"success");
    cancelMove();
  };

  // Ta bort en plats — rensar location/locationType/parentLocation på ALLA
  // delar som finns där just nu (de hamnar i "Delar utan plats" istället).
  const deleteLocation = async (locKey, display) => {
    const affected = getItems(locKey);
    await saveItems(items.map(i => affected.some(a=>a.id===i.id) ? {...i, location:"", locationType:"", parentLocation:""} : i));
    toast$(`Platsen "${display}" borttagen — ${affected.length} delar flyttade till "Delar utan plats"`,"success");
    setConfirmDeleteLoc(null);
    if (expanded===locKey) setExpanded(null);
  };

  // QR-kod för en hel låda/plats — skanna den för att direkt se allt som
  // finns där (se ScanPage, som känner igen prefixet "LAGERBOX:").
  const printBoxLabel = (loc, count) => {
    const qrData = `LAGERBOX:${loc}`;
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=260x260&data=${encodeURIComponent(qrData)}`;
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Låd-QR — ${loc}</title>
    <style>
      @page{size:A6;margin:0}
      *{box-sizing:border-box}
      body{font-family:'Segoe UI',Arial,sans-serif;margin:0;padding:10mm;text-align:center;color:#141820}
      .name{font-size:22px;font-weight:800;color:#1B3A6B;margin-bottom:6mm;word-break:break-word}
      .sub{font-size:12px;color:#888;margin-bottom:6mm}
      img{width:55mm;height:55mm}
      .hint{font-size:11px;color:#888;margin-top:6mm}
    </style></head><body>
      <div class="name">${loc}</div>
      <div class="sub">${count} delar i lådan</div>
      <img src="${qrUrl}"/>
      <div class="hint">Skanna för att se allt i lådan</div>
    </body></html>`;
    printHtml(html);
  };

  const locationTypeOptions = lists?.locationTypes || [];
  // Distinkta platstyper som faktiskt används just nu — för filterchipsen
  const usedTypes = [...new Set(locations.map(l=>l.locationType).filter(Boolean))].sort((a,b)=>a.localeCompare(b,"sv"));
  // Alla kända fulla platstexter — för snabbval i flytt-panelen och som
  // val när man sätter en "ligger på"-koppling
  const knownLocations = locations.map(l=>l.display).sort((a,b)=>naturalCompare(a,b));

  return (
    <Page>
      <TopBar title="Platser" subtitle="Vad finns var" onBack={pop}/>
      <div style={{padding:"14px 14px 40px"}}>
        <div style={{position:"relative",marginBottom:10}}>
          <span style={{position:"absolute",left:10,top:"50%",transform:"translateY(-50%)",fontSize:13,color:MU,pointerEvents:"none"}}><Icon name="magnifying-glass"/></span>
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Sök plats, t.ex. Låda 3A…"
            style={{width:"100%",padding:"10px 10px 10px 30px",border:`1.5px solid ${BD}`,borderRadius:8,fontSize:13,boxSizing:"border-box",background:WH}}/>
        </div>

        {/* Filtrera på platstyp — t.ex. bara Hisshylla */}
        {usedTypes.length>1&&(
          <div style={{display:"flex",gap:6,overflowX:"auto",paddingBottom:4,marginBottom:14}}>
            <button onClick={()=>setTypeFilter("")} style={{flexShrink:0,padding:"6px 14px",borderRadius:16,border:`1.5px solid ${!typeFilter?BX:BD}`,background:!typeFilter?BX:WH,color:!typeFilter?WH:TM,fontSize:12,fontWeight:600,whiteSpace:"nowrap",cursor:"pointer"}}>Alla typer</button>
            {usedTypes.map(t=>(
              <button key={t} onClick={()=>setTypeFilter(typeFilter===t?"":t)} style={{flexShrink:0,padding:"6px 14px",borderRadius:16,border:`1.5px solid ${typeFilter===t?BX:BD}`,background:typeFilter===t?BX:WH,color:typeFilter===t?WH:TM,fontSize:12,fontWeight:600,whiteSpace:"nowrap",cursor:"pointer"}}>{t}</button>
            ))}
          </div>
        )}

        {/* Genvägar till de två specialsidorna */}
        <div style={{display:"flex",gap:8,marginBottom:14}}>
          <button onClick={()=>push("nolocation")} style={{flex:1,display:"flex",alignItems:"center",gap:8,background:WH,border:`1.5px solid ${AM}40`,borderRadius:10,padding:"10px 12px",cursor:"pointer",textAlign:"left"}}>
            <Icon name="location-crosshairs" style={{color:AM}}/>
            <div>
              <div style={{fontSize:12,fontWeight:700,color:TX}}>Utan plats</div>
              <div style={{fontSize:10,color:MU}}>{noLocationCount} delar</div>
            </div>
          </button>
          <button onClick={()=>push("missingitems")} style={{flex:1,display:"flex",alignItems:"center",gap:8,background:WH,border:`1.5px solid ${R}40`,borderRadius:10,padding:"10px 12px",cursor:"pointer",textAlign:"left"}}>
            <Icon name="triangle-exclamation" style={{color:R}}/>
            <div>
              <div style={{fontSize:12,fontWeight:700,color:TX}}>Försvunna</div>
              <div style={{fontSize:10,color:MU}}>{missingCount} delar</div>
            </div>
          </button>
        </div>

        <div style={{display:"flex",flexDirection:"column",gap:8}}>
          {filtered.map(loc => {
            const locItems = getItems(loc.key);
            const isOpen = expanded === loc.key;
            const parent = loc.parent;
            return (
              <div key={loc.key} style={{background:WH,borderRadius:10,border:`1.5px solid ${isOpen?BX:BD}`,overflow:"hidden"}}>
                <div style={{display:"flex",alignItems:"center",gap:10,padding:"12px 14px"}}>
                  <div onClick={()=>setExpanded(isOpen?null:loc.key)} style={{display:"flex",alignItems:"center",gap:10,flex:1,cursor:"pointer",minWidth:0}}>
                    <i className="fa-solid fa-location-dot" style={{fontSize:14,color:BX,flexShrink:0}}/>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontWeight:700,fontSize:14,color:BX,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{loc.display}</div>
                      <div style={{fontSize:11,color:MU}}>
                        {locItems.length} delar
                        {parent&&<span> · <i className="fa-solid fa-turn-up" style={{fontSize:9,transform:"rotate(90deg)",display:"inline-block"}}/> ligger på <b style={{color:TX}}>{parent}</b></span>}
                      </div>
                    </div>
                  </div>
                  {(isAdmin||can("canAdd"))&&(
                    <button onClick={()=>{setSettingParentFor(loc.key);setParentPick(parent||"");}} title="Ange var den här platsen själv finns (t.ex. vilken hylla en låda står på)" style={{background:"none",border:"none",color:parent?BX:MU,cursor:"pointer",padding:6,flexShrink:0}}>
                      <Icon name="sitemap"/>
                    </button>
                  )}
                  {(isAdmin||can("canAdd"))&&(
                    <button onClick={()=>printBoxLabel(loc.display,locItems.length)} title="Skriv ut QR-etikett för lådan" style={{background:"none",border:"none",color:MU,cursor:"pointer",padding:6,flexShrink:0}}>
                      <Icon name="qrcode"/>
                    </button>
                  )}
                  {(isAdmin||can("canDelete"))&&(
                    <button onClick={()=>setConfirmDeleteLoc(loc)} title="Ta bort platsen" style={{background:"none",border:"none",color:MU,cursor:"pointer",padding:6,flexShrink:0}}>
                      <Icon name="trash"/>
                    </button>
                  )}
                  <i onClick={()=>setExpanded(isOpen?null:loc.key)} className={`fa-solid fa-chevron-${isOpen?"up":"down"}`} style={{fontSize:12,color:MU,cursor:"pointer",flexShrink:0}}/>
                </div>

                {/* Inline panel — koppla den här platsen till en "förälder"-plats */}
                {settingParentFor===loc.key&&(
                  <div style={{padding:"0 14px 14px",background:BG,borderTop:`1px solid ${BD}`}} onClick={e=>e.stopPropagation()}>
                    <div style={{fontSize:11,color:MU,margin:"10px 0 6px"}}>Var finns "{loc.display}" själv? (t.ex. vilken hylla en låda står på)</div>
                    <div style={{display:"flex",gap:8}}>
                      <input value={parentPick} onChange={e=>setParentPick(e.target.value)} placeholder="T.ex. Hylla A3" list="known-locations"
                        style={{flex:1,padding:"8px 10px",border:`1.5px solid ${BD}`,borderRadius:6,fontSize:12}}/>
                      <Btn small variant="ghost" onClick={()=>setSettingParentFor(null)}>Avbryt</Btn>
                      {parent&&<Btn small variant="red" onClick={()=>setParent(loc.key,"")}>Ta bort</Btn>}
                      <Btn small onClick={()=>setParent(loc.key,parentPick.trim())}>Spara</Btn>
                    </div>
                  </div>
                )}

                {isOpen&&(
                  <div style={{borderTop:`1px solid ${BD}`}}>
                    {locItems.map(item=>(
                      <div key={item.id} style={{borderBottom:`1px solid ${BD}`,background:WH}}>
                        <div style={{display:"flex",alignItems:"center",gap:10,padding:"10px 14px"}}>
                          <div onClick={()=>push("detail",{item})} style={{display:"flex",alignItems:"center",gap:10,flex:1,minWidth:0,cursor:"pointer"}}>
                            <span style={{background:BX,color:WH,borderRadius:4,padding:"1px 6px",fontSize:11,fontWeight:800,flexShrink:0}}>#{item.stockNumber}</span>

                            <div style={{flex:1,minWidth:0}}>
                              <div style={{fontWeight:600,fontSize:13,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{item.name}{item.side?` — ${item.side}`:""}</div>
                              {item.oem&&<div style={{fontSize:10,color:MU,fontFamily:"monospace"}}>{item.oem}</div>}
                            </div>
                            <div style={{flexShrink:0,fontFamily:"'Barlow Condensed',sans-serif",fontSize:16,fontWeight:800,color:item.quantity===0?R:GR}}>{item.quantity}</div>
                          </div>
                          {(isAdmin||can("canEdit"))&&!item.missing&&(
                            <button onClick={async()=>{await saveItems(items.map(i=>i.id===item.id?{...i,missing:true,missingSince:Date.now()}:i));toast$(`${item.name} markerad som borttappad`,"success");}} title="Markera som borttappad" style={{background:"none",border:"none",color:MU,cursor:"pointer",padding:6,flexShrink:0}}>
                              <Icon name="triangle-exclamation"/>
                            </button>
                          )}
                          {(isAdmin||can("canEdit"))&&(
                            <button onClick={()=>movingId===item.id?cancelMove():startMove(item)} title="Flytta till annan plats" style={{background:"none",border:"none",color:movingId===item.id?BX:MU,cursor:"pointer",padding:6,flexShrink:0}}>
                              <Icon name="arrows-up-down-left-right"/>
                            </button>
                          )}
                        </div>
                        {/* Inline flytt-panel — ändra plats direkt här, ingen omväg via
                            massredigering eller att skriva ner det på papper */}
                        {movingId===item.id&&(
                          <div style={{padding:"0 14px 14px",background:BG}} onClick={e=>e.stopPropagation()}>
                            <div style={{display:"flex",gap:8,marginBottom:8}}>
                              <select value={moveType} onChange={e=>setMoveType(e.target.value)} style={{flex:1,padding:"8px 10px",border:`1.5px solid ${BD}`,borderRadius:6,fontSize:12,background:WH}}>
                                <option value="">Typ (valfritt)</option>
                                {locationTypeOptions.filter(Boolean).map(t=><option key={t} value={t}>{t}</option>)}
                              </select>
                              <input value={moveLoc} onChange={e=>setMoveLoc(e.target.value)} placeholder="Plats, t.ex. 3A" list="known-locations"
                                style={{flex:1.4,padding:"8px 10px",border:`1.5px solid ${BD}`,borderRadius:6,fontSize:12}}/>
                            </div>
                            <input value={moveParent} onChange={e=>setMoveParent(e.target.value)} placeholder="Var finns den här platsen? (valfritt, t.ex. Hisshylla 2)" list="known-locations"
                              style={{width:"100%",padding:"8px 10px",border:`1.5px solid ${BD}`,borderRadius:6,fontSize:12,marginBottom:8,boxSizing:"border-box"}}/>
                            <div style={{display:"flex",gap:8}}>
                              <Btn small variant="ghost" onClick={cancelMove}>Avbryt</Btn>
                              <Btn small onClick={()=>confirmMove(item)}>Flytta hit</Btn>
                            </div>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          {filtered.length===0&&<div style={{textAlign:"center",color:MU,padding:40}}>Inga platser hittades</div>}
        </div>
      </div>

      <datalist id="known-locations">
        {knownLocations.map(l=><option key={l} value={l}/>)}
      </datalist>

      {confirmDeleteLoc&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.4)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:200,padding:20}} onClick={()=>setConfirmDeleteLoc(null)}>
          <div onClick={e=>e.stopPropagation()} style={{background:WH,borderRadius:14,padding:20,maxWidth:360,width:"100%"}}>
            <div style={{fontWeight:700,fontSize:15,marginBottom:8}}>Ta bort platsen "{confirmDeleteLoc.display}"?</div>
            <div style={{fontSize:13,color:MU,marginBottom:16}}>
              {getItems(confirmDeleteLoc.key).length} delar ligger här just nu. De tas INTE bort — de flyttas till "Delar utan plats", redo att tilldelas en ny plats.
            </div>
            <div style={{display:"flex",gap:8}}>
              <Btn full variant="ghost" onClick={()=>setConfirmDeleteLoc(null)}>Avbryt</Btn>
              <Btn full variant="red" onClick={()=>deleteLocation(confirmDeleteLoc.key,confirmDeleteLoc.display)}>Ta bort plats</Btn>
            </div>
          </div>
        </div>
      )}
    </Page>
  );
}

// ─── Delar utan plats ──────────────────────────────────────────────────────────
function NoLocationPage({ items, saveItems, lists, pop, push, can, isAdmin, toast$ }) {
  const [search, setSearch] = useState("");
  const [movingId, setMovingId] = useState(null);
  const [moveType, setMoveType] = useState("");
  const [moveLoc, setMoveLoc] = useState("");
  const [moveParent, setMoveParent] = useState("");

  const noLoc = items.filter(i => !i.location).filter(i => !search || i.name.toLowerCase().includes(search.toLowerCase()) || (i.stockNumber||"").includes(search));

  const startMove = (item) => { setMovingId(item.id); setMoveType(item.locationType||""); setMoveLoc(""); setMoveParent(""); };
  const cancelMove = () => { setMovingId(null); setMoveType(""); setMoveLoc(""); setMoveParent(""); };
  const confirmMove = async (item) => {
    if (!moveLoc.trim()) { toast$("Ange en plats","error"); return; }
    await saveItems(items.map(i => i.id===item.id ? {...i, locationType:moveType, location:moveLoc, parentLocation:moveParent} : i));
    toast$(`${item.name} tilldelad plats: ${[moveType,moveLoc].filter(Boolean).join(" — ")}`,"success");
    cancelMove();
  };

  const locationTypeOptions = lists?.locationTypes || [];
  const knownLocations = [...new Set(items.map(i=>i.location).filter(Boolean))].sort((a,b)=>naturalCompare(a,b));

  return (
    <Page>
      <TopBar title="Delar utan plats" subtitle={`${noLoc.length} delar saknar en tilldelad plats`} onBack={pop}/>
      <div style={{padding:"14px 14px 40px"}}>
        <div style={{position:"relative",marginBottom:14}}>
          <span style={{position:"absolute",left:10,top:"50%",transform:"translateY(-50%)",fontSize:13,color:MU,pointerEvents:"none"}}><Icon name="magnifying-glass"/></span>
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Sök namn eller lagernummer…"
            style={{width:"100%",padding:"10px 10px 10px 30px",border:`1.5px solid ${BD}`,borderRadius:8,fontSize:13,boxSizing:"border-box",background:WH}}/>
        </div>
        {noLoc.length===0&&<div style={{textAlign:"center",color:MU,padding:40}}><Icon name="circle-check" style={{fontSize:32,marginBottom:10,display:"block",color:GR}}/>Alla delar har en tilldelad plats</div>}
        <div style={{display:"flex",flexDirection:"column",gap:8}}>
          {noLoc.map(item=>(
            <div key={item.id} style={{background:WH,borderRadius:10,border:`1px solid ${AM}40`,overflow:"hidden"}}>
              <div style={{display:"flex",alignItems:"center",gap:10,padding:"12px 14px"}}>
                <div onClick={()=>push("detail",{item})} style={{display:"flex",alignItems:"center",gap:10,flex:1,minWidth:0,cursor:"pointer"}}>
                  <span style={{background:BX,color:WH,borderRadius:4,padding:"1px 6px",fontSize:11,fontWeight:800,flexShrink:0}}>#{item.stockNumber}</span>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontWeight:600,fontSize:13,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{item.name}{item.side?` — ${item.side}`:""}</div>
                    {item.warehouse&&<div style={{fontSize:10,color:MU}}>{item.warehouse}</div>}
                  </div>
                </div>
                {(isAdmin||can("canEdit"))&&(
                  <Btn small variant={movingId===item.id?"blue":"ghost"} onClick={()=>movingId===item.id?cancelMove():startMove(item)}>
                    <Icon name="location-dot"/> Ge plats
                  </Btn>
                )}
              </div>
              {movingId===item.id&&(
                <div style={{padding:"0 14px 14px",background:BG}}>
                  <div style={{display:"flex",gap:8,marginBottom:8}}>
                    <select value={moveType} onChange={e=>setMoveType(e.target.value)} style={{flex:1,padding:"8px 10px",border:`1.5px solid ${BD}`,borderRadius:6,fontSize:12,background:WH}}>
                      <option value="">Typ (valfritt)</option>
                      {locationTypeOptions.filter(Boolean).map(t=><option key={t} value={t}>{t}</option>)}
                    </select>
                    <input value={moveLoc} onChange={e=>setMoveLoc(e.target.value)} placeholder="Plats, t.ex. 3A" list="known-locations-nl" autoFocus
                      style={{flex:1.4,padding:"8px 10px",border:`1.5px solid ${BD}`,borderRadius:6,fontSize:12}}/>
                  </div>
                  <input value={moveParent} onChange={e=>setMoveParent(e.target.value)} placeholder="Var finns den här platsen? (valfritt)" list="known-locations-nl"
                    style={{width:"100%",padding:"8px 10px",border:`1.5px solid ${BD}`,borderRadius:6,fontSize:12,marginBottom:8,boxSizing:"border-box"}}/>
                  <div style={{display:"flex",gap:8}}>
                    <Btn small variant="ghost" onClick={cancelMove}>Avbryt</Btn>
                    <Btn small onClick={()=>confirmMove(item)}>Spara plats</Btn>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
      <datalist id="known-locations-nl">
        {knownLocations.map(l=><option key={l} value={l}/>)}
      </datalist>
    </Page>
  );
}

// ─── Försvunna delar ───────────────────────────────────────────────────────────
function MissingItemsPage({ items, saveItems, pop, push, can, isAdmin, toast$, logActivity, currentUser }) {
  const [search, setSearch] = useState("");
  const missing = items.filter(i => i.missing).filter(i => !search || i.name.toLowerCase().includes(search.toLowerCase()) || (i.stockNumber||"").includes(search));

  const markFound = async (item) => {
    await saveItems(items.map(i => i.id===item.id ? {...i, missing:false, missingSince:null} : i));
    logActivity&&logActivity("found", `${item.name}${item.stockNumber?` (#${item.stockNumber})`:""} markerad som hittad igen`, { user: currentUser?.username });
    toast$(`${item.name} markerad som hittad`,"success");
  };

  return (
    <Page>
      <TopBar title="Försvunna delar" subtitle={`${missing.length} delar markerade som borttappade`} onBack={pop}/>
      <div style={{padding:"14px 14px 40px"}}>
        <div style={{position:"relative",marginBottom:14}}>
          <span style={{position:"absolute",left:10,top:"50%",transform:"translateY(-50%)",fontSize:13,color:MU,pointerEvents:"none"}}><Icon name="magnifying-glass"/></span>
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Sök namn eller lagernummer…"
            style={{width:"100%",padding:"10px 10px 10px 30px",border:`1.5px solid ${BD}`,borderRadius:8,fontSize:13,boxSizing:"border-box",background:WH}}/>
        </div>
        {missing.length===0&&<div style={{textAlign:"center",color:MU,padding:40}}><Icon name="circle-check" style={{fontSize:32,marginBottom:10,display:"block",color:GR}}/>Inga delar markerade som borttappade</div>}
        <div style={{display:"flex",flexDirection:"column",gap:8}}>
          {missing.map(item=>(
            <div key={item.id} style={{background:WH,borderRadius:10,border:`1px solid ${R}40`,padding:"12px 14px"}}>
              <div style={{display:"flex",alignItems:"center",gap:10}}>
                <div onClick={()=>push("detail",{item})} style={{display:"flex",alignItems:"center",gap:10,flex:1,minWidth:0,cursor:"pointer"}}>
                  <Icon name="triangle-exclamation" style={{color:R,flexShrink:0}}/>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontWeight:600,fontSize:13}}>{item.name}{item.side?` — ${item.side}`:""}</div>
                    <div style={{fontSize:11,color:MU,marginTop:2}}>
                      {item.location
                        ? <>Var registrerad på: <b style={{color:TX}}>{[item.locationType,item.location].filter(Boolean).join(" — ")}</b> — men hittas inte där nu</>
                        : "Ingen registrerad plats"}
                    </div>
                    {item.missingSince&&<div style={{fontSize:10,color:MU,marginTop:2}}>Markerad borttappad: {new Date(item.missingSince).toLocaleDateString("sv-SE")}</div>}
                  </div>
                </div>
                {(isAdmin||can("canEdit"))&&(
                  <Btn small variant="ghost" onClick={()=>markFound(item)}><Icon name="check"/> Hittad</Btn>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </Page>
  );
}

// ─── QR Labels Page — generera & visa QR-koder för utskrift ───────────────────
function QrLabelsPage({ items, pop, preSelected }) {
  const [selected, setSelected] = useState(new Set(preSelected||[]));
  const [labelType, setLabelType] = useState("qr_full");
  const [search, setSearch] = useState("");

  const toggle = (id) => setSelected(s => { const n=new Set(s); n.has(id)?n.delete(id):n.add(id); return n; });
  const selectAll = () => setSelected(new Set(filtered.map(i=>i.id)));
  const clearAll = () => setSelected(new Set());

  const filtered = items.filter(i => {
    if (!search) return true;
    const q = search.toLowerCase();
    return [i.name, i.oem, i.stockNumber, i.make, i.location, ...(i.alternativeNumbers||[])].some(f=>f?.toLowerCase().includes(q));
  });

  const qrUrl = (text) => `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(text)}`;
  const barcodeUrl = (text) => `https://barcodeapi.org/api/128/${encodeURIComponent(text)}`;

  const LABEL_TYPES = [
    { k:"a5",        l:"A5 — Stor etikett",  desc:"En per A5-sida: stort artikelnr, stort lagernr, QR" },
    { k:"qr_full",   l:"QR — Fullständig",  desc:"QR-kod + namn + lagernr + artikelnr" },
    { k:"qr_mini",   l:"QR — Mini",          desc:"Liten QR + lagernr" },
    { k:"barcode",   l:"Streckkod",          desc:"Code128 + lagernr + artikelnr" },
    { k:"price_tag", l:"Prislapp",           desc:"Pris + namn + lagernr" },
    { k:"full_card", l:"Komplett kort",      desc:"All info + QR" },
  ];

  const printSelected = () => {
    const toPrint = items.filter(i=>selected.has(i.id));
    if (toPrint.length===0) return;

    let labelHtml = "";
    if (labelType==="a5") {
      labelHtml = toPrint.map(i=>`<div class="a5label">
        <div class="a5-top">
          <div class="a5-name">${i.name}${i.side?" — "+i.side:""}</div>
          ${i.make?`<div class="a5-make">${i.make}${i.model?" "+i.model:""}${i.yearFrom?" ("+i.yearFrom+(i.yearTo?"–"+i.yearTo:"")+")":""}</div>`:""}
        </div>
        <div class="a5-mid">
          <div class="a5-fields">
            <div class="a5-field">
              <div class="a5-flabel">ARTIKELNUMMER</div>
              <div class="a5-art">${i.oem||"—"}</div>
            </div>
            <div class="a5-field">
              <div class="a5-flabel">LAGERNUMMER</div>
              <div class="a5-stock">#${i.stockNumber||"—"}</div>
            </div>
          </div>
          <div class="a5-qr">
            <img src="${qrUrl(i.oem||i.stockNumber||i.id)}"/>
            <div class="a5-qrtext">Skanna</div>
          </div>
        </div>
        <div class="a5-bot">
          ${i.category?`<span class="a5-tag">${i.category}</span>`:""}
          ${i.condition?`<span class="a5-tag">${i.condition}</span>`:""}
          ${i.location?`<span class="a5-tag">📍 ${i.locationType?i.locationType+" ":""}${i.location}</span>`:""}
        </div>
      </div>`).join("");
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>A5-etiketter</title>
      <style>
        @page{size:A5;margin:0}
        *{box-sizing:border-box}
        body{font-family:'Segoe UI',Arial,sans-serif;margin:0;padding:0}
        .a5label{width:148mm;height:210mm;padding:14mm 12mm;page-break-after:always;display:flex;flex-direction:column;color:#141820}
        .a5-top{border-bottom:3px solid #1B3A6B;padding-bottom:6mm;margin-bottom:8mm}
        .a5-name{font-size:30px;font-weight:800;color:#1B3A6B;line-height:1.1}
        .a5-make{font-size:16px;color:#555;margin-top:3mm}
        .a5-mid{flex:1;display:flex;gap:8mm;align-items:flex-start}
        .a5-fields{flex:1;min-width:0}
        .a5-field{margin-bottom:12mm}
        .a5-flabel{font-size:12px;font-weight:700;color:#888;letter-spacing:2px;margin-bottom:2mm}
        .a5-art{font-size:44px;font-weight:900;font-family:'Courier New',monospace;color:#141820;word-break:break-all;line-height:1}
        .a5-stock{font-size:64px;font-weight:900;color:#CC1B2B;line-height:1}
        .a5-qr{text-align:center;flex-shrink:0}
        .a5-qr img{width:44mm;height:44mm}
        .a5-qrtext{font-size:12px;color:#888;margin-top:2mm;letter-spacing:1px}
        .a5-bot{border-top:2px solid #eee;padding-top:5mm;display:flex;gap:4mm;flex-wrap:wrap}
        .a5-tag{background:#EEF2F8;color:#1B3A6B;border-radius:5px;padding:2mm 4mm;font-size:13px;font-weight:600}
      </style></head><body>${labelHtml}
      <script>window.addEventListener('load',function(){setTimeout(function(){window.print();},500);});</script></body></html>`;
      printHtml(html);
      return;
    }
    if (labelType==="qr_full") {
      labelHtml = toPrint.map(i=>`<div class="label"><img src="${qrUrl(i.stockNumber||i.oem)}" style="width:90px;height:90px"/><div class="name">${i.name}${i.side?" — "+i.side:""}</div><div class="row-info"><span class="badge">#${i.stockNumber||"—"}</span></div><div class="art">${i.oem||"—"}</div></div>`).join("");
    } else if (labelType==="qr_mini") {
      labelHtml = toPrint.map(i=>`<div class="label" style="padding:6px"><img src="${qrUrl(i.stockNumber||i.oem)}" style="width:55px;height:55px"/><div style="font-weight:800;font-size:13px;color:#1B3A6B">#${i.stockNumber||"—"}</div><div style="font-size:9px;color:#666;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${i.name}</div></div>`).join("");
    } else if (labelType==="barcode") {
      labelHtml = toPrint.map(i=>`<div class="label"><img src="${barcodeUrl(i.oem||i.stockNumber)}" style="width:100%;height:45px;object-fit:contain"/><div class="name">${i.name}${i.side?" — "+i.side:""}</div><div class="row-info"><span class="badge">#${i.stockNumber||"—"}</span></div><div class="art">${i.oem||"—"}</div></div>`).join("");
    } else if (labelType==="price_tag") {
      labelHtml = toPrint.map(i=>`<div class="label"><div style="font-size:26px;font-weight:900;color:#1B3A6B;line-height:1">${(i.price||0).toLocaleString("sv-SE")} kr</div><div class="name">${i.name}${i.side?" — "+i.side:""}</div><div class="row-info"><span class="badge">#${i.stockNumber||"—"}</span></div><div class="art">${i.oem||"—"}</div>${i.make?`<div style="font-size:9px;color:#888">${i.make}${i.model?" "+i.model:""}</div>`:""}</div>`).join("");
    } else {
      labelHtml = toPrint.map(i=>`<div class="label" style="text-align:left;display:flex;gap:8px;align-items:flex-start"><img src="${qrUrl(i.stockNumber||i.oem)}" style="width:65px;height:65px;flex-shrink:0"/><div style="flex:1;min-width:0"><div style="font-weight:800;font-size:12px;margin-bottom:3px">${i.name}${i.side?" — "+i.side:""}</div><div style="font-size:20px;font-weight:900;color:#1B3A6B;line-height:1;margin-bottom:3px">${(i.price||0).toLocaleString("sv-SE")} kr</div><div><span class="badge">#${i.stockNumber||"—"}</span></div><div style="font-size:9px;color:#666;margin-top:2px">Art: ${i.oem||"—"}</div>${i.make?`<div style="font-size:9px;color:#666">${i.make}${i.model?" "+i.model:""}</div>`:""}</div></div>`).join("");
    }

    const cols = labelType==="qr_mini"?4:labelType==="full_card"?1:3;
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Etiketter</title>
    <style>@page{margin:8mm}body{font-family:sans-serif;margin:0;padding:0}.grid{display:grid;grid-template-columns:repeat(${cols},1fr);gap:6px;padding:6px}.label{border:1px solid #ddd;border-radius:5px;padding:8px;text-align:center;break-inside:avoid;background:#fff}.name{font-weight:700;font-size:10px;margin:4px 0 2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.art{font-size:8px;color:#888;font-family:monospace;margin-top:1px}.badge{background:#1B3A6B;color:#fff;border-radius:3px;padding:1px 5px;font-size:10px;font-weight:800}.row-info{margin:3px 0}</style>
    </head><body><div class="grid">${labelHtml}</div>
    <script>window.addEventListener('load',function(){setTimeout(function(){window.print();},400);});</script></body></html>`;

    printHtml(html);
  };

  return (
    <Page>
      <TopBar title="Etiketter" onBack={pop} subtitle={`${selected.size} valda`}
        right={<Btn small onClick={printSelected} disabled={selected.size===0}><Icon name="print"/> Skriv ut</Btn>}/>
      <div style={{padding:"14px 14px 80px"}}>

        {/* Etikettyp */}
        <div style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,padding:12,marginBottom:14}}>
          <div style={{fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:8}}>Etiketttyp</div>
          <div style={{display:"flex",flexDirection:"column",gap:5}}>
            {LABEL_TYPES.map(t=>(
              <button key={t.k} onClick={()=>setLabelType(t.k)}
                style={{display:"flex",alignItems:"center",gap:10,padding:"9px 12px",borderRadius:8,border:`2px solid ${labelType===t.k?BX:BD}`,background:labelType===t.k?B+"08":WH,cursor:"pointer",textAlign:"left"}}>
                <div style={{width:16,height:16,borderRadius:"50%",border:`2px solid ${labelType===t.k?BX:BD}`,background:labelType===t.k?BX:WH,flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center"}}>
                  {labelType===t.k&&<div style={{width:7,height:7,borderRadius:"50%",background:WH}}/>}
                </div>
                <div>
                  <div style={{fontWeight:700,fontSize:13,color:labelType===t.k?BX:TX}}>{t.l}</div>
                  <div style={{fontSize:11,color:MU}}>{t.desc}</div>
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Sök */}
        <div style={{position:"relative",marginBottom:10}}>
          <span style={{position:"absolute",left:10,top:"50%",transform:"translateY(-50%)",fontSize:13,color:MU,pointerEvents:"none"}}><Icon name="magnifying-glass"/></span>
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Sök namn, lagernr, artikelnr, märke…"
            style={{width:"100%",padding:"9px 9px 9px 30px",border:`1.5px solid ${BD}`,borderRadius:8,fontSize:13,boxSizing:"border-box"}}/>
        </div>

        {/* Välj */}
        <div style={{display:"flex",gap:8,marginBottom:10,alignItems:"center"}}>
          <Btn variant="ghost" small onClick={selectAll}>Markera alla</Btn>
          <Btn variant="ghost" small onClick={clearAll}>Avmarkera</Btn>
          <span style={{marginLeft:"auto",fontSize:12,color:MU}}>{selected.size} av {items.length} valda</span>
        </div>

        <div style={{display:"flex",flexDirection:"column",gap:6}}>
          {filtered.map(item=>(
            <div key={item.id} onClick={()=>toggle(item.id)}
              style={{background:WH,borderRadius:10,border:`2px solid ${selected.has(item.id)?BX:BD}`,padding:"10px 12px",cursor:"pointer",display:"flex",gap:10,alignItems:"center"}}>
              <div style={{flexShrink:0,width:20,height:20,borderRadius:"50%",border:`2px solid ${selected.has(item.id)?BX:BD}`,background:selected.has(item.id)?BX:WH,display:"flex",alignItems:"center",justifyContent:"center"}}>
                {selected.has(item.id)&&<Icon name="check" style={{fontSize:9,color:WH}}/>}
              </div>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontWeight:700,fontSize:13,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{item.name}{item.side?` — ${item.side}`:""}</div>
                <div style={{fontSize:11,color:MU,fontFamily:"monospace"}}>
                  <span style={{background:BX,color:WH,borderRadius:3,padding:"0 4px",fontSize:10,fontWeight:800,marginRight:5}}>#{item.stockNumber}</span>
                  {item.oem||"—"}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </Page>
  );
}


// ─── Receipt Page — PDF-liknande kvitto ───────────────────────────────────────
function ReceiptPage({ sale, receiptRows, payMethod, cashGiven, change, settings, pop }) {
  // receiptRows = multiple rows from checkout; sale = single row from direct sell
  const rows = receiptRows || [sale];
  const co = settings||{};
  const grandTotal = rows.reduce((a,r)=>a+r.total,0);
  const grandExclVat = rows.reduce((a,r)=>a+(r.totalExclVat!=null?r.totalExclVat:Math.round(r.total/1.25)),0);
  const grandVat = grandTotal - grandExclVat;
  const buyer = rows[0]?.buyer || "Okänd";
  const soldBy = rows[0]?.soldBy || "";
  const soldAt = rows[0]?.soldAt || Date.now();
  const receiptId = rows[0]?.receiptId || rows[0]?.id || "";
  const note = rows[0]?.note || "";
  const fmt = ts => new Date(ts).toLocaleDateString("sv-SE",{day:"numeric",month:"long",year:"numeric"})+" "+new Date(ts).toLocaleTimeString("sv-SE",{hour:"2-digit",minute:"2-digit"});

  const payLabel = payMethod==="swish"?"Swish":payMethod==="kort"?"Kortbetalning":"Kontant";

  const printReceipt = () => {
    const totalDisc = rows.reduce((a,r)=>a+(r.discountKr||0)*r.qty,0);
    const rowsHtml = rows.map(r => {
      const sn = r.itemStockNumber ? `#${r.itemStockNumber} — ` : "";
      return `<div style="margin-bottom:10px">
        <div style="font-weight:700;font-size:13px">${sn}${r.itemName}${r.itemSide?" — "+r.itemSide:""}</div>
        ${r.itemOem?`<div style="font-size:10px;color:#888">Art.nr: ${r.itemOem}</div>`:""}
        <div style="display:flex;justify-content:space-between;font-size:12px">
          <span>${r.qty} st x ${r.unitPrice.toLocaleString("sv-SE")} kr</span>
          <span>${r.total.toLocaleString("sv-SE")} kr</span>
        </div>
        ${r.discount>0?`<div style="color:#c77700;font-size:11px">Rabatt ${r.discount}% (-${((r.discountKr||0)*r.qty).toLocaleString("sv-SE")} kr)</div>`:""}
      </div>`;
    }).join('<div style="border-top:1px dashed #ddd;margin:8px 0"></div>');

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Kvitto</title>
      <style>body{font-family:monospace;margin:0;padding:24px;max-width:400px}hr{border:none;border-top:2px dashed #ccc;margin:12px 0}.row{display:flex;justify-content:space-between}</style>
      </head><body>
      <div style="text-align:center;padding-bottom:16px;border-bottom:2px dashed #ccc;margin-bottom:16px">
        <div style="font-weight:800;font-size:20px;letter-spacing:2px">KVITTO</div>
      </div>
      <div style="font-size:11px;color:#555;margin-bottom:12px;line-height:1.7">
        <div>Datum: ${fmt(soldAt)}</div>
        <div>Säljare: ${soldBy}</div>
        ${buyer!=="Okänd"?`<div>Kund: ${buyer}</div>`:""}
        <div>Nr: #${receiptId.slice(-8).toUpperCase()}</div>
      </div>
      <hr/>
      ${rowsHtml}
      <hr/>
      ${totalDisc>0?`<div class="row" style="font-size:13px;color:#c77700;margin-bottom:4px"><span>Total rabatt</span><span>-${totalDisc.toLocaleString("sv-SE")} kr</span></div>`:""}
      <div class="row" style="font-size:22px;font-weight:800;margin:8px 0">
        <span>TOTALT</span><span>${grandTotal.toLocaleString("sv-SE")} kr</span>
      </div>
      <div style="font-size:12px;color:#555;line-height:1.7">
        <div>Betalning: ${payLabel}</div>
        ${payMethod==="kontant"&&cashGiven?`<div>Betalt: ${Number(cashGiven).toLocaleString("sv-SE")} kr &nbsp;·&nbsp; Växel: ${(change||0).toLocaleString("sv-SE")} kr</div>`:""}
      </div>
      ${note?`<div style="font-size:11px;color:#888;margin-top:8px;border-top:1px solid #eee;padding-top:8px">${note}</div>`:""}
      <div style="margin-top:36px;display:flex;gap:24px">
        <div style="flex:1;text-align:center">
          <div style="border-top:1.5px solid #333;padding-top:5px;font-size:11px;color:#555">Säljarens underskrift</div>
          <div style="font-size:10px;color:#999;margin-top:3px">${soldBy}</div>
        </div>
        <div style="flex:1;text-align:center">
          <div style="border-top:1.5px solid #333;padding-top:5px;font-size:11px;color:#555">Kundens underskrift</div>
          <div style="font-size:10px;color:#999;margin-top:3px">${buyer!=="Okänd"?buyer:"&nbsp;"}</div>
        </div>
      </div>
      <div style="text-align:center;font-size:11px;color:#bbb;border-top:2px dashed #ccc;padding-top:14px;margin-top:24px">Tack för ditt köp!</div>
      <script>window.onload=()=>setTimeout(()=>window.print(),300)</script>
      </body></html>`;
    printHtml(html);
  };

  const totalDisc = rows.reduce((a,r)=>a+(r.discountKr||0)*r.qty,0);

  return (
    <Page>
      <TopBar title="Kvitto" onBack={pop} subtitle="Bevis på köp" right={<Btn small onClick={printReceipt}><Icon name="receipt"/> Skriv ut</Btn>}/>
      <div style={{padding:"14px 14px 60px"}}>
        <div style={{background:WH,borderRadius:12,border:`1px solid ${BD}`,padding:20,fontFamily:"monospace"}}>

          <div style={{textAlign:"center",marginBottom:16,paddingBottom:16,borderBottom:`2px dashed ${BD}`}}>
            {co.companyName&&<div style={{fontWeight:800,fontSize:15,marginBottom:4}}>{co.companyName}</div>}
            {co.companyOrg&&<div style={{fontSize:11,color:MU}}>Org: {co.companyOrg}</div>}
            {co.companyPhone&&<div style={{fontSize:11,color:MU}}>Tel: {co.companyPhone}</div>}
            {co.companyAddress&&<div style={{fontSize:11,color:MU}}>{co.companyAddress}</div>}
            {co.companyName&&<div style={{margin:"10px 0",borderTop:`1px dashed ${BD}`}}/>}
            <div style={{fontWeight:800,fontSize:18,letterSpacing:2}}>KVITTO</div>
          </div>

          <div style={{fontSize:12,marginBottom:12,color:TM,lineHeight:1.8}}>
            <div>Datum: {fmt(soldAt)}</div>
            <div>Säljare: {soldBy}</div>
            {buyer!=="Okänd"&&<div>Kund: {buyer}</div>}
            <div style={{color:MU}}>Nr: #{receiptId.slice(-8).toUpperCase()}</div>
          </div>

          <div style={{borderTop:`1px dashed ${BD}`,padding:"12px 0",marginBottom:0}}>
            {rows.map((r,i)=>(
              <div key={r.id}>
                {i>0&&<div style={{height:1,background:`${BD}80`,margin:"8px 0"}}/>}
                <div style={{fontWeight:700,fontSize:13,marginBottom:2}}>{r.itemName}{r.itemSide?` — ${r.itemSide}`:""}</div>
                {r.itemOem&&<div style={{fontSize:10,color:MU,fontFamily:"monospace"}}>Art.nr: {r.itemOem}</div>}
                {(r.make||r.compatible)&&<div style={{fontSize:10,color:MU,marginBottom:4}}>{[r.make,r.model,r.yearFrom&&r.yearTo?r.yearFrom+"-"+r.yearTo:""].filter(Boolean).join(" ")||r.compatible}</div>}
                {r.discount>0&&(
                  <div style={{display:"flex",justifyContent:"space-between",fontSize:11,color:MU,marginBottom:1}}>
                    <span>Pris innan rabatt</span><span style={{textDecoration:"line-through"}}>{(r.unitPrice+(r.discountKr||0)).toLocaleString("sv-SE")} kr/st</span>
                  </div>
                )}
                <div style={{display:"flex",justifyContent:"space-between",fontSize:12}}>
                  <span>{r.qty} st × {r.unitPrice.toLocaleString("sv-SE")} kr</span>
                  <span style={{fontWeight:600}}>{r.total.toLocaleString("sv-SE")} kr</span>
                </div>
                {r.discount>0&&<div style={{display:"flex",justifyContent:"space-between",fontSize:11,color:AM}}><span>Rabatt {r.discount}%</span><span>-{((r.discountKr||0)*r.qty).toLocaleString("sv-SE")} kr</span></div>}
              </div>
            ))}
          </div>

          <div style={{borderTop:`2px dashed ${BD}`,marginTop:12,paddingTop:12}}>
            {totalDisc>0&&(
              <div style={{display:"flex",justifyContent:"space-between",fontSize:13,color:AM,marginBottom:6}}>
                <span>Total rabatt</span><span>-{totalDisc.toLocaleString("sv-SE")} kr</span>
              </div>
            )}
            <div style={{display:"flex",justifyContent:"space-between",fontSize:13,color:TM,marginBottom:3}}>
              <span>Summa exkl. moms</span><span>{grandExclVat.toLocaleString("sv-SE")} kr</span>
            </div>
            <div style={{display:"flex",justifyContent:"space-between",fontSize:13,color:TM,marginBottom:6}}>
              <span>Moms (25%)</span><span>{grandVat.toLocaleString("sv-SE")} kr</span>
            </div>
            <div style={{display:"flex",justifyContent:"space-between",fontSize:20,fontWeight:800,color:BX,marginBottom:8}}>
              <span>TOTALT</span><span>{grandTotal.toLocaleString("sv-SE")} kr</span>
            </div>
            <div style={{fontSize:12,color:TM,lineHeight:1.8}}>
              <div>Betalning: {payLabel}</div>
              {payMethod==="kontant"&&cashGiven>0&&<div>Betalt: {cashGiven.toLocaleString("sv-SE")} kr · Växel: <strong style={{color:GR}}>{(change||0).toLocaleString("sv-SE")} kr</strong></div>}
            </div>
          </div>

          {note&&<div style={{fontSize:12,color:TM,background:BG,borderRadius:6,padding:10,marginTop:12}}>{note}</div>}

          <div style={{textAlign:"center",fontSize:11,color:MU,paddingTop:14,marginTop:14,borderTop:`2px dashed ${BD}`}}>
            Tack för ditt köp!
          </div>
        </div>
      </div>
    </Page>
  );
}


// ─── Import Page — Excel-import av artiklar ───────────────────────────────────
function ImportPage({ items, saveItems, pop, push, toast$, can, isAdmin }) {
  if (!isAdmin && !can("canImport")) return <Page><TopBar title="Importera" onBack={pop}/><div style={{padding:40,textAlign:"center",color:MU}}><i className="fa-solid fa-lock" style={{fontSize:32,marginBottom:12,display:"block"}}/>Du saknar behörighet för import.</div></Page>;
  const [step, setStep] = useState("upload"); // upload | preview | done
  const [parsed, setParsed] = useState([]);
  const [errors, setErrors] = useState([]);
  const [mode, setMode] = useState("add"); // add | replace
  const [importing, setImporting] = useState(false);
  const fileRef = useRef(null);

  // ── Kolumnmappning (Excel-rubrik -> fältnamn) ──────────────────────────────
  const COL_MAP = {
    "namn": "name", "name": "name",
    "lagernummer": "stockNumber", "lagernr": "stockNumber", "stocknumber": "stockNumber",
    "kategori": "category", "category": "category",
    "sida": "side", "side": "side",
    "antal": "quantity", "quantity": "quantity", "qty": "quantity",
    "pris": "price", "price": "price",
    "inköpspris": "costPrice", "inkopspris": "costPrice", "costprice": "costPrice",
    "skick": "condition", "condition": "condition",
    "märke": "make", "marke": "make", "make": "make",
    "modell": "model", "model": "model",
    "årsmodell från": "yearFrom", "yearfrom": "yearFrom",
    "årsmodell till": "yearTo", "yearto": "yearTo",
    "leverantör": "supplier", "supplier": "supplier",
    "hylla": "location", "lagerplats": "location", "location": "location",
    "artikelnummer": "oem", "oem": "oem",
    "beskrivning": "description", "description": "description",
    "notering": "notes", "notes": "notes",
    "regnummer": "regNumber", "regnumber": "regNumber",
    "lager": "warehouse", "warehouse": "warehouse", "ort": "warehouse",
  };

  // ── Ladda ner mall ─────────────────────────────────────────────────────────
  const downloadTemplate = () => {
    const headers = ["Namn","Artikelnummer","Lagernummer","Lagerplats","Lager","Kategori","Sida","Antal","Pris","Inköpspris","Skick","Märke","Modell","Årsmodell från","Årsmodell till","Leverantör","Beskrivning","Notering"];
    const example = ["Bakstötfångare","2048800140","234","A3-07","Halmstad","Stötfångare","Bak","2","3500","1200","Begagnad - Gott skick","Mercedes-Benz","C-klass W204","2007","2014","Leverantör AB","Inkl. parkeringssensorer","Bra skick"];
    const csv = [headers.join(";"), example.join(";")].join("\n");
    const bom = "\uFEFF"; // BOM för svenska tecken i Excel
    const blob = new Blob([bom + csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "lager_mall.csv";
    a.click();
  };

  // ── Parsa uppladdad fil (CSV eller XLSX via SheetJS) ───────────────────────
  const handleFile = async (file) => {
    if (!file) return;
    const ext = file.name.split(".").pop().toLowerCase();

    try {
      let rows = [];

      if (ext === "csv") {
        const text = await file.text();
        const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
        const sep = lines[0].includes(";") ? ";" : ",";
        const headers = lines[0].split(sep).map(h => h.trim().toLowerCase().replace(/['"]/g, ""));
        rows = lines.slice(1).map(line => {
          const vals = line.split(sep).map(v => v.trim().replace(/^["']|["']$/g, ""));
          const obj = {};
          headers.forEach((h, i) => { obj[h] = vals[i] || ""; });
          return obj;
        });
      } else if (ext === "xlsx" || ext === "xls") {
        // Dynamisk import av SheetJS via CDN
        if (!window.XLSX) {
          await new Promise((res, rej) => {
            const s = document.createElement("script");
            s.src = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
            s.onload = res; s.onerror = rej;
            document.head.appendChild(s);
          });
        }
        const buf = await file.arrayBuffer();
        const wb = window.XLSX.read(buf, { type: "array" });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const data = window.XLSX.utils.sheet_to_json(ws, { defval: "" });
        rows = data.map(row => {
          const out = {};
          Object.entries(row).forEach(([k, v]) => { out[k.toLowerCase().trim()] = String(v ?? "").trim(); });
          return out;
        });
      } else {
        toast$("Stöder bara .csv, .xlsx och .xls", "error");
        return;
      }

      // Mappa kolumner → artikelfält
      const errs = [];
      const existingStockNumbers = new Set(items.map(i=>i.stockNumber));
      const usedInBatch = new Set();

      // Hitta minsta fria lagernummer
      const nextFreeStock = (used) => {
        let n = 1;
        while (used.has(String(n))) n++;
        return String(n);
      };

      const mapped = rows.map((row, idx) => {
        const item = { id: genId("imp"), images: [], updatedAt: Date.now() };
        Object.entries(row).forEach(([k, v]) => {
          const field = COL_MAP[k.toLowerCase().trim()];
          if (field) {
            if (["quantity","price","costPrice","yearFrom","yearTo"].includes(field)) {
              item[field] = v === "" ? (field === "quantity" ? 0 : undefined) : Number(String(v).replace(/[^0-9.-]/g,"")) || 0;
            } else {
              item[field] = v;
            }
          }
        });

        // Normalisera märket automatiskt
        if (item.make) item.make = normalizeMake(item.make);

        // Validering — Namn, Artikelnummer och Lagerplats är obligatoriska
        if (!item.name?.trim()) errs.push(`Rad ${idx+2}: Namn saknas`);
        if (!item.oem?.trim()) errs.push(`Rad ${idx+2}: Artikelnummer saknas`);
        if (!item.location?.trim()) errs.push(`Rad ${idx+2}: Lagerplats saknas`);

        // Lagernummer — använd angivet, annars auto-generera minsta fria
        if (!item.stockNumber?.trim()) {
          const free = nextFreeStock(new Set([...existingStockNumbers, ...usedInBatch]));
          item.stockNumber = free;
        } else if (existingStockNumbers.has(item.stockNumber) || usedInBatch.has(item.stockNumber)) {
          errs.push(`Rad ${idx+2}: Lagernummer ${item.stockNumber} används redan — bytt automatiskt`);
          item.stockNumber = nextFreeStock(new Set([...existingStockNumbers, ...usedInBatch]));
        }
        usedInBatch.add(item.stockNumber);

        // Artikelnummer alltid versaler
        if (item.oem) item.oem = item.oem.toUpperCase().trim();

        // SKU genereras automatiskt från artikelnumret — gör att flera rader med
        // samma artikelnummer (t.ex. tre likadana strålkastare) automatiskt grupperas
        // ihop som exemplar av samma del i lagret.
        item.sku = (item.oem||item.name||genId("x")).trim().toLowerCase().replace(/[^a-z0-9]/g,"");

        if (!item.quantity && item.quantity !== 0) item.quantity = 1;
        if (!item.price) item.price = 0;
        if (!item.category) item.category = "Övrigt";
        if (!item.condition) item.condition = "Begagnad - Gott skick";

        return item;
      }).filter(i => i.name?.trim() && i.oem?.trim() && i.location?.trim());

      setErrors(errs);
      setParsed(mapped);
      setStep("preview");
    } catch (e) {
      toast$("Kunde inte läsa filen: " + e.message, "error");
    }
  };

  // ── Genomför import ────────────────────────────────────────────────────────
  const doImport = async () => {
    setImporting(true);
    try {
      let newItems;
      if (mode === "replace") {
        // Nollställ — börja om från 1 med minsta fria nummer
        const usedReplace = new Set();
        const nextFree = (used) => { let n=1; while(used.has(String(n))) n++; return String(n); };
        newItems = parsed.map(p => {
          if (!p.stockNumber?.trim()) {
            p.stockNumber = nextFree(usedReplace);
          }
          usedReplace.add(p.stockNumber);
          return p;
        });
      } else if (mode === "sync") {
        // Synka — uppdatera befintliga (samma lagernummer), lägg till nya
        const existingByStock = {};
        items.forEach(i => { if (i.stockNumber) existingByStock[i.stockNumber] = i; });
        const merged = [...items];
        parsed.forEach(p => {
          const existing = existingByStock[p.stockNumber];
          if (existing) {
            // Uppdatera befintlig — bevara bilder och id
            const idx = merged.findIndex(i => i.id === existing.id);
            if (idx >= 0) merged[idx] = { ...p, id: existing.id, images: existing.images || [] };
          } else {
            merged.push(p);
          }
        });
        newItems = merged;
      } else {
        newItems = [...items, ...parsed];
      }
      await saveItems(newItems);
      toast$(`${parsed.length} artiklar importerade!`, "success");
      setStep("done");
    } catch (e) {
      toast$("Import misslyckades: " + e.message, "error");
    }
    setImporting(false);
  };

  return (
    <Page>
      <TopBar title="Importera" onBack={pop} subtitle="Excel / CSV"/>
      <div style={{padding:"14px 14px 60px"}}>

        {/* Steg 1 — Ladda upp */}
        {step === "upload" && (
          <>
            {/* Mall */}
            <div style={{background:B+"08",border:`1px solid ${B}20`,borderRadius:10,padding:14,marginBottom:14,display:"flex",gap:12,alignItems:"center"}}>
              <Icon name="file-export" style={{color:BX,fontSize:20,flexShrink:0}}/>
              <div style={{flex:1}}>
                <div style={{fontWeight:700,fontSize:13,marginBottom:2}}>Ladda ner mall</div>
                <div style={{fontSize:12,color:MU}}>CSV-fil med alla kolumner färdiga. Öppna i Excel, fyll i och spara.</div>
              </div>
              <Btn small onClick={downloadTemplate}>Ladda ner</Btn>
            </div>

            {/* Upload area */}
            <div
              onClick={() => fileRef.current?.click()}
              onDragOver={e=>{e.preventDefault();e.currentTarget.style.borderColor=BX;}}
              onDragLeave={e=>{e.currentTarget.style.borderColor=BD;}}
              onDrop={e=>{e.preventDefault();e.currentTarget.style.borderColor=BD;handleFile(e.dataTransfer.files[0]);}}
              style={{border:`2px dashed ${BD}`,borderRadius:12,padding:"40px 20px",textAlign:"center",cursor:"pointer",background:WH,marginBottom:14,transition:"border-color .15s"}}>
              <Icon name="file-export" style={{fontSize:36,color:MU,display:"block",margin:"0 auto 12px"}}/>
              <div style={{fontWeight:700,fontSize:14,marginBottom:6}}>Klicka eller dra hit din fil</div>
              <div style={{fontSize:12,color:MU}}>.xlsx, .xls eller .csv</div>
              <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" style={{display:"none"}}
                onChange={e=>handleFile(e.target.files[0])}/>
            </div>

            {/* Kolumnguide */}
            <div style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,overflow:"hidden"}}>
              <div style={{padding:"12px 14px",borderBottom:`1px solid ${BD}`,fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7}}>Kolumner som stöds</div>
              <div style={{padding:14,display:"grid",gridTemplateColumns:"1fr 1fr",gap:"4px 16px"}}>
                {[["Namn","Obligatorisk"],["Artikelnummer","Obligatorisk"],["Lagerplats","Obligatorisk"],["Lagernummer","Auto om tom"],["Kategori",""],["Sida",""],["Antal",""],["Pris",""],["Inköpspris",""],["Skick",""],["Märke",""],["Modell",""],["Årsmodell från",""],["Årsmodell till",""],["Leverantör",""],["Beskrivning",""],["Notering",""]].map(([col,note])=>(
                  <div key={col} style={{fontSize:12,padding:"3px 0",display:"flex",justifyContent:"space-between",gap:4}}>
                    <span style={{fontWeight:600}}>{col}</span>
                    {note&&<span style={{fontSize:10,color:note==="Obligatorisk"?R:MU}}>{note}</span>}
                  </div>
                ))}
              </div>
            </div>
          </>
        )}

        {/* Steg 2 — Förhandsgranska */}
        {step === "preview" && (
          <>
            {/* Fel */}
            {errors.length > 0 && (
              <div style={{background:R+"08",border:`1px solid ${R}30`,borderRadius:10,padding:12,marginBottom:12}}>
                <div style={{fontWeight:700,fontSize:12,color:R,marginBottom:6}}>Varningar ({errors.length})</div>
                {errors.map((e,i)=><div key={i} style={{fontSize:11,color:R,marginBottom:2}}>{e}</div>)}
              </div>
            )}

            {/* Importläge */}
            <div style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,padding:14,marginBottom:12}}>
              <div style={{fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:10}}>Importläge</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8}}>
                {[["add","Lägg till",`Lägger till ${parsed.length} nya artiklar`],["sync","Synka",`Uppdaterar befintliga, lägger till nya — inga dubbletter`],["replace","Ersätt allt",`Tar bort ${items.length} befintliga, lägger in ${parsed.length} nya`]].map(([k,l,desc])=>(
                  <button key={k} onClick={()=>setMode(k)} style={{padding:"12px 10px",borderRadius:8,border:`2px solid ${mode===k?BX:BD}`,background:mode===k?B+"08":WH,textAlign:"left",cursor:"pointer"}}>
                    <div style={{fontWeight:700,fontSize:13,color:mode===k?BX:TX,marginBottom:3}}>{l}</div>
                    <div style={{fontSize:11,color:MU}}>{desc}</div>
                    {k==="replace"&&<div style={{fontSize:10,color:R,marginTop:3,fontWeight:600}}>⚠ Kan inte ångras</div>}
                  </button>
                ))}
              </div>
            </div>

            {/* Förhandsgranskning */}
            <div style={{fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:8}}>{parsed.length} artiklar att importera</div>
            {parsed.slice(0,20).map((item,i)=>(
              <div key={i} style={{background:WH,borderRadius:8,border:`1px solid ${BD}`,padding:"10px 12px",marginBottom:6,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontWeight:600,fontSize:13,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{item.name}{item.side?` — ${item.side}`:""}</div>
                  <div style={{fontSize:11,color:MU}}>{item.sku} · {item.category} · {item.quantity} st</div>
                </div>
                <div style={{textAlign:"right",flexShrink:0,marginLeft:10}}>
                  <div style={{fontWeight:700,color:BX,fontSize:13}}>{(item.price||0).toLocaleString("sv-SE")} kr</div>
                  {item.make&&<div style={{fontSize:11,color:MU}}>{item.make}{item.model?` ${item.model}`:""}</div>}
                </div>
              </div>
            ))}
            {parsed.length > 20 && (
              <div style={{textAlign:"center",padding:"10px",fontSize:12,color:MU}}>... och {parsed.length-20} till</div>
            )}

            <div style={{display:"flex",gap:8,marginTop:14}}>
              <Btn full variant="ghost" onClick={()=>{setStep("upload");setParsed([]);setErrors([]);}}>Avbryt</Btn>
              <Btn full variant="red" onClick={doImport} disabled={importing}>
                {importing ? "Importerar..." : `Importera ${parsed.length} artiklar`}
              </Btn>
            </div>
          </>
        )}

        {/* Steg 3 — Klart */}
        {step === "done" && (
          <div style={{textAlign:"center",padding:"60px 20px"}}>
            <Icon name="check" style={{fontSize:48,color:GR,display:"block",margin:"0 auto 16px"}}/>
            <div style={{fontWeight:800,fontSize:18,marginBottom:8,color:GR}}>Import klar!</div>
            <div style={{fontSize:13,color:MU,marginBottom:24}}>{parsed.length} artiklar har lagts in i lagret.</div>
            <Btn onClick={()=>push("inventory")}>Gå till lagret</Btn>
          </div>
        )}

      </div>
    </Page>
  );
}

// ─── Reports Page ─────────────────────────────────────────────────────────────
function ReportsPage({ sales, items, users, can, isAdmin, push, pop }) {
  const [period, setPeriod] = useState("month");
  const now = Date.now();
  const ms = { today:864e5, week:7*864e5, month:30*864e5, year:365*864e5, all:Infinity };
  const filtered = (sales||[]).filter(s => now - s.soldAt < ms[period]);

  const totalRev   = filtered.reduce((a,s)=>a+s.total,0);
  const totalProfit= filtered.reduce((a,s)=>a+(s.profit||0),0);
  const totalQty   = filtered.reduce((a,s)=>a+s.qty,0);
  const avgSale    = filtered.length ? Math.round(totalRev/filtered.length) : 0;
  const margin     = totalRev>0 ? Math.round(totalProfit/totalRev*100) : 0;

  // Per-dag för minigraf (senaste 14 dagar)
  const days = Array.from({length:14},(_,i)=>{
    const d = new Date(); d.setDate(d.getDate()-13+i);
    const key = d.toLocaleDateString("sv-SE",{day:"numeric",month:"short"});
    const dayStart = new Date(d.getFullYear(),d.getMonth(),d.getDate()).getTime();
    const dayEnd   = dayStart + 864e5;
    const rev = (sales||[]).filter(s=>s.soldAt>=dayStart&&s.soldAt<dayEnd).reduce((a,s)=>a+s.total,0);
    return { key, rev };
  });
  const maxRev = Math.max(...days.map(d=>d.rev), 1);

  // Per säljare
  const bySeller = {};
  filtered.forEach(s=>{ bySeller[s.soldBy]=(bySeller[s.soldBy]||{rev:0,count:0}); bySeller[s.soldBy].rev+=s.total; bySeller[s.soldBy].count++; });
  const sellerList = Object.entries(bySeller).sort((a,b)=>b[1].rev-a[1].rev);

  // Per kategori
  const byCat = {};
  filtered.forEach(s=>{
    const item = items.find(i=>i.id===s.itemId);
    const cat = item?.category || s.itemSnapshot?.category || "Okänd";
    byCat[cat]=(byCat[cat]||0)+s.total;
  });
  const catList = Object.entries(byCat).sort((a,b)=>b[1]-a[1]).slice(0,6);

  // Marginal per kategori — intäkt, vinst och marginal% (kräver inköpspris, som redan finns per försäljning)
  const byCatMargin = {};
  filtered.forEach(s=>{
    const item = items.find(i=>i.id===s.itemId);
    const cat = item?.category || s.itemSnapshot?.category || "Okänd";
    if (!byCatMargin[cat]) byCatMargin[cat] = { rev:0, profit:0, count:0 };
    byCatMargin[cat].rev += s.total;
    byCatMargin[cat].profit += (s.profit||0);
    byCatMargin[cat].count += 1;
  });
  const catMarginList = Object.entries(byCatMargin)
    .map(([cat,v])=>({ cat, ...v, margin: v.rev>0 ? Math.round(v.profit/v.rev*100) : 0 }))
    .sort((a,b)=>b.profit-a.profit);

  // Marginal per del — vilka delar/artiklar som ger mest respektive minst vinst.
  // Grupperas på ARTIKELNUMMER (OEM), inte lagernummer — lagernumret återanvänds
  // över tid så samma fysiska artikeltyp skulle annars räknas som olika rader.
  const byItem = {};
  filtered.forEach(s=>{
    const oem = s.itemOem || s.itemSnapshot?.oem || "";
    const key = oem || s.itemSku || s.itemName; // saknas OEM (äldre försäljningar) — fall tillbaka
    if (!byItem[key]) byItem[key] = { name:s.itemName, oem, rev:0, profit:0, qty:0 };
    byItem[key].rev += s.total;
    byItem[key].profit += (s.profit||0);
    byItem[key].qty += s.qty;
  });
  const itemMarginList = Object.values(byItem).map(v=>({ ...v, margin: v.rev>0 ? Math.round(v.profit/v.rev*100) : 0 }));
  const topProfit = [...itemMarginList].sort((a,b)=>b.profit-a.profit).slice(0,5);
  const lowMargin  = [...itemMarginList].filter(x=>x.rev>0).sort((a,b)=>a.margin-b.margin).slice(0,5);

  // ── Jämförelse: denna månad vs föregående, samt detta år vs föregående ──
  // Beräknas alltid på ALLA försäljningar (oberoende av periodväljaren ovan).
  const sumRange = (start, end) => {
    const inRange = (sales||[]).filter(s => s.soldAt >= start && s.soldAt < end);
    return {
      rev: inRange.reduce((a,s)=>a+s.total,0),
      profit: inRange.reduce((a,s)=>a+(s.profit||0),0),
      count: inRange.length,
    };
  };
  const today = new Date();
  const startOfMonth = (y,m) => new Date(y,m,1).getTime();
  const thisMonthStart = startOfMonth(today.getFullYear(), today.getMonth());
  const nextMonthStart = startOfMonth(today.getFullYear(), today.getMonth()+1);
  const prevMonthStart = startOfMonth(today.getFullYear(), today.getMonth()-1);
  const thisMonth = sumRange(thisMonthStart, nextMonthStart);
  const prevMonth = sumRange(prevMonthStart, thisMonthStart);

  const startOfYear = y => new Date(y,0,1).getTime();
  const thisYearStart = startOfYear(today.getFullYear());
  const nextYearStart = startOfYear(today.getFullYear()+1);
  const prevYearStart = startOfYear(today.getFullYear()-1);
  const thisYear = sumRange(thisYearStart, nextYearStart);
  const prevYear = sumRange(prevYearStart, thisYearStart);

  const pctChange = (cur, prev) => prev>0 ? Math.round((cur-prev)/prev*100) : (cur>0?100:0);

  const exportReport = () => {
    const rows = [["Datum","Artikel","Antal","Pris","Rabatt%","Totalt","Vinst","Säljare","Kund","Betalning"]];
    filtered.forEach(s=>rows.push([
      new Date(s.soldAt).toLocaleDateString("sv-SE"),
      s.itemName+(s.itemSide?` — ${s.itemSide}`:""),
      s.itemSku||"", s.qty, s.unitPrice, s.discount||0, s.total, s.profit||0, s.soldBy, s.buyer||"", s.payMethod||""
    ]));
    const bom="\uFEFF";
    const csv=rows.map(r=>r.join(";")).join("\n");
    const a=document.createElement("a"); a.href=URL.createObjectURL(new Blob([bom+csv],{type:"text/csv;charset=utf-8"}));
    a.download=`rapport_${period}_${new Date().toLocaleDateString("sv-SE").replace(/\//g,"-")}.csv`; a.click();
  };

  const exportPdf = () => {
    const periodLabels = {today:"Idag",week:"Senaste 7 dagarna",month:"Senaste 30 dagarna",year:"Senaste 12 månaderna",all:"Alla tider"};
    const catRows = catMarginList.map(c=>`<tr><td>${c.cat}</td><td style="text-align:right">${c.rev.toLocaleString("sv-SE")} kr</td><td style="text-align:right;color:${c.profit>=0?'#16a34a':'#CC1B2B'}">${c.profit.toLocaleString("sv-SE")} kr</td><td style="text-align:right">${c.margin}%</td></tr>`).join("");
    const topRows = topProfit.map((it,i)=>`<tr><td>${i+1}. ${it.oem?it.oem+" — ":""}${it.name}</td><td style="text-align:right">${it.qty} st</td><td style="text-align:right;color:#16a34a;font-weight:700">${it.profit.toLocaleString("sv-SE")} kr</td></tr>`).join("");
    const lowRows = lowMargin.map((it,i)=>`<tr><td>${it.oem?it.oem+" — ":""}${it.name}</td><td style="text-align:right">${it.qty} st</td><td style="text-align:right">${it.margin}%</td></tr>`).join("");
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Rapport</title>
    <style>
      @page{size:A4;margin:16mm}
      *{box-sizing:border-box}
      body{font-family:'Segoe UI',Arial,sans-serif;color:#141820;margin:0}
      h1{font-size:22px;color:#1B3A6B;margin:0 0 2px}
      .sub{color:#8A90A0;font-size:12px;margin-bottom:18px}
      .kpis{display:flex;gap:10px;margin-bottom:20px}
      .kpi{flex:1;border:1px solid #E2E5EA;border-radius:8px;padding:10px}
      .kpi .l{font-size:9px;font-weight:700;color:#8A90A0;text-transform:uppercase;letter-spacing:.5px}
      .kpi .v{font-size:19px;font-weight:800;color:#1B3A6B}
      h2{font-size:13px;color:#1B3A6B;border-bottom:2px solid #1B3A6B;padding-bottom:4px;margin:22px 0 8px}
      table{width:100%;border-collapse:collapse;font-size:12px}
      td,th{padding:6px 4px;border-bottom:1px solid #eee;text-align:left}
      th{color:#8A90A0;font-size:10px;text-transform:uppercase;font-weight:700}
      .footer{margin-top:30px;font-size:10px;color:#bbb;text-align:center}
    </style></head><body>
      <h1>Lager — Försäljningsrapport</h1>
      <div class="sub">Period: ${periodLabels[period]} · Genererad ${new Date().toLocaleString("sv-SE")}</div>
      <div class="kpis">
        <div class="kpi"><div class="l">Intäkt</div><div class="v">${totalRev.toLocaleString("sv-SE")} kr</div></div>
        <div class="kpi"><div class="l">Vinst</div><div class="v" style="color:${totalProfit>=0?'#16a34a':'#CC1B2B'}">${totalProfit.toLocaleString("sv-SE")} kr</div></div>
        <div class="kpi"><div class="l">Marginal</div><div class="v">${margin}%</div></div>
        <div class="kpi"><div class="l">Affärer</div><div class="v">${filtered.length}</div></div>
      </div>
      <h2>Marginal per kategori</h2>
      <table><tr><th>Kategori</th><th style="text-align:right">Intäkt</th><th style="text-align:right">Vinst</th><th style="text-align:right">Marginal</th></tr>${catRows||'<tr><td colspan="4" style="color:#999">Ingen data</td></tr>'}</table>
      <h2>Mest lönsamma delar</h2>
      <table><tr><th>Del</th><th style="text-align:right">Antal</th><th style="text-align:right">Vinst</th></tr>${topRows||'<tr><td colspan="3" style="color:#999">Ingen data</td></tr>'}</table>
      <h2>Lägst marginal</h2>
      <table><tr><th>Del</th><th style="text-align:right">Antal</th><th style="text-align:right">Marginal</th></tr>${lowRows||'<tr><td colspan="3" style="color:#999">Ingen data</td></tr>'}</table>
      <h2>Jämförelse</h2>
      <table>
        <tr><th></th><th style="text-align:right">Denna period</th><th style="text-align:right">Föregående</th><th style="text-align:right">Förändring</th></tr>
        <tr><td>Denna månad</td><td style="text-align:right">${thisMonth.rev.toLocaleString("sv-SE")} kr</td><td style="text-align:right">${prevMonth.rev.toLocaleString("sv-SE")} kr</td><td style="text-align:right;font-weight:700">${pctChange(thisMonth.rev,prevMonth.rev)>=0?'+':''}${pctChange(thisMonth.rev,prevMonth.rev)}%</td></tr>
        <tr><td>Detta år</td><td style="text-align:right">${thisYear.rev.toLocaleString("sv-SE")} kr</td><td style="text-align:right">${prevYear.rev.toLocaleString("sv-SE")} kr</td><td style="text-align:right;font-weight:700">${pctChange(thisYear.rev,prevYear.rev)>=0?'+':''}${pctChange(thisYear.rev,prevYear.rev)}%</td></tr>
      </table>
      <div class="footer">Lager · Automatiskt genererad rapport · Använd webbläsarens "Spara som PDF" i utskriftsdialogen</div>
      <script>window.addEventListener('load',function(){setTimeout(function(){window.print();},400);});</script>
    </body></html>`;
    printHtml(html);
  };

  const S = ({l,v,c=TX,sub}) => (
    <div style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,padding:14}}>
      <div style={{fontSize:10,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:4}}>{l}</div>
      <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:24,fontWeight:800,color:c,lineHeight:1.1}}>{v}</div>
      {sub&&<div style={{fontSize:11,color:MU,marginTop:2}}>{sub}</div>}
    </div>
  );

  // Jämförelsekort — visar två perioder sida vid sida med förändring i %
  const CompareCard = ({ title, cur, prev, curLabel, prevLabel }) => {
    const revPct = pctChange(cur.rev, prev.rev);
    const profitPct = pctChange(cur.profit, prev.profit);
    const up = revPct >= 0;
    return (
      <div style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,padding:14,marginBottom:14}}>
        <div style={{fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:12}}>{title}</div>
        <div style={{display:"flex",gap:16,alignItems:"center",marginBottom:10}}>
          <div style={{flex:1}}>
            <div style={{fontSize:10,color:MU,marginBottom:2}}>{curLabel}</div>
            <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:22,fontWeight:800,color:BX}}>{cur.rev.toLocaleString("sv-SE")} kr</div>
            <div style={{fontSize:11,color:MU}}>{cur.count} affärer</div>
          </div>
          <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:2,flexShrink:0}}>
            <Icon name={up?"arrow-trend-up":"arrow-trend-down"} style={{color:up?GR:R,fontSize:18}}/>
            <span style={{fontSize:13,fontWeight:800,color:up?GR:R}}>{up?"+":""}{revPct}%</span>
          </div>
          <div style={{flex:1,textAlign:"right"}}>
            <div style={{fontSize:10,color:MU,marginBottom:2}}>{prevLabel}</div>
            <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:22,fontWeight:800,color:MU}}>{prev.rev.toLocaleString("sv-SE")} kr</div>
            <div style={{fontSize:11,color:MU}}>{prev.count} affärer</div>
          </div>
        </div>
        <div style={{display:"flex",justifyContent:"space-between",fontSize:12,paddingTop:10,borderTop:`1px solid ${BD}40`}}>
          <span style={{color:MU}}>Vinst: <strong style={{color:cur.profit>=0?GR:R}}>{cur.profit.toLocaleString("sv-SE")} kr</strong> vs {prev.profit.toLocaleString("sv-SE")} kr</span>
          <span style={{fontWeight:700,color:profitPct>=0?GR:R}}>{profitPct>=0?"+":""}{profitPct}%</span>
        </div>
      </div>
    );
  };

  return (
    <Page>
      <TopBar title="Rapporter" onBack={pop} subtitle="Försäljningsanalys" right={
        <div style={{display:"flex",gap:6}}>
          <Btn small variant="ghost" onClick={exportPdf}><Icon name="file-pdf"/> PDF</Btn>
          <Btn small onClick={exportReport}><Icon name="file-export"/> CSV</Btn>
        </div>
      }/>
      <div style={{padding:"14px 14px 60px"}}>

        {/* Period */}
        <div style={{display:"flex",gap:6,marginBottom:16,overflowX:"auto",paddingBottom:4}}>
          {[["today","Idag"],["week","7 dagar"],["month","30 dagar"],["year","12 mån"],["all","Totalt"]].map(([k,l])=>(
            <button key={k} onClick={()=>setPeriod(k)} style={{flexShrink:0,padding:"7px 14px",borderRadius:20,border:`1.5px solid ${period===k?BX:BD}`,background:period===k?BX:WH,color:period===k?WH:TX,fontWeight:600,fontSize:12,cursor:"pointer"}}>
              {l}
            </button>
          ))}
        </div>

        {/* KPI grid */}
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(160px,1fr))",gap:10,marginBottom:16}}>
          <S l="Intäkt" v={totalRev.toLocaleString("sv-SE")+" kr"} c={BX}/>
          <S l="Vinst" v={totalProfit.toLocaleString("sv-SE")+" kr"} c={totalProfit>=0?GR:R} sub={`${margin}% marginal`}/>
          <S l="Antal affärer" v={filtered.length} c={TX}/>
          <S l="Sålda delar" v={totalQty} sub={`Snitt ${avgSale.toLocaleString("sv-SE")} kr/affär`}/>
        </div>

        {/* Jämförelse månad mot månad, år mot år */}
        <CompareCard title="Denna månad vs föregående" cur={thisMonth} prev={prevMonth}
          curLabel={today.toLocaleDateString("sv-SE",{month:"long"})} prevLabel={new Date(prevMonthStart).toLocaleDateString("sv-SE",{month:"long"})}/>
        <CompareCard title="Detta år vs föregående" cur={thisYear} prev={prevYear}
          curLabel={String(today.getFullYear())} prevLabel={String(today.getFullYear()-1)}/>

        {/* Minigraf — senaste 14 dagar */}
        <div style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,padding:14,marginBottom:14}}>
          <div style={{fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:12}}>Senaste 14 dagarna</div>
          <div style={{display:"flex",alignItems:"flex-end",gap:3,height:60}}>
            {days.map(d=>(
              <div key={d.key} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:2}}>
                <div style={{width:"100%",background:d.rev>0?BX:BD,borderRadius:3,height:d.rev>0?`${Math.max(4,Math.round(d.rev/maxRev*52))}px`:"4px",transition:"height .3s"}}/>
                <div style={{fontSize:8,color:MU,textAlign:"center",writingMode:"vertical-rl",transform:"rotate(180deg)",height:22,overflow:"hidden"}}>{d.key}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Per säljare */}
        {sellerList.length>0&&(
          <div style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,padding:14,marginBottom:14}}>
            <div style={{fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:10}}>Per säljare</div>
            {sellerList.map(([name,{rev,count}],i)=>(
              <div key={name} style={{display:"flex",alignItems:"center",gap:10,marginBottom:8}}>
                <div style={{width:22,height:22,borderRadius:"50%",background:B+"15",color:BX,fontSize:11,fontWeight:800,display:"flex",alignItems:"center",justifyContent:"center"}}>{i+1}</div>
                <span style={{flex:1,fontSize:13,fontWeight:600}}>{name}</span>
                <div style={{textAlign:"right"}}>
                  <div style={{fontSize:13,fontWeight:700,color:BX}}>{rev.toLocaleString("sv-SE")} kr</div>
                  <div style={{fontSize:11,color:MU}}>{count} affärer</div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Marginal per kategori */}
        {catMarginList.length>0&&(
          <div style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,padding:14,marginBottom:14}}>
            <div style={{fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:10}}>Marginal per kategori</div>
            {catMarginList.map(c=>(
              <div key={c.cat} style={{display:"flex",alignItems:"center",gap:10,padding:"8px 0",borderBottom:`1px solid ${BD}40`}}>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:13,fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{c.cat}</div>
                  <div style={{fontSize:11,color:MU}}>{c.count} affärer · {c.rev.toLocaleString("sv-SE")} kr intäkt</div>
                </div>
                <div style={{textAlign:"right",flexShrink:0}}>
                  <div style={{fontSize:14,fontWeight:800,color:c.profit>=0?GR:R}}>{c.profit.toLocaleString("sv-SE")} kr</div>
                  <div style={{fontSize:11,color:MU}}>{c.margin}% marginal</div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Mest lönsamma delar */}
        {topProfit.length>0&&(
          <div style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,padding:14,marginBottom:14}}>
            <div style={{fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:10}}>Mest lönsamma delar</div>
            {topProfit.map((it,i)=>(
              <div key={it.name+i} style={{display:"flex",alignItems:"center",gap:10,padding:"7px 0",borderBottom:`1px solid ${BD}40`}}>
                <div style={{width:20,height:20,borderRadius:"50%",background:GR+"15",color:GR,fontSize:10,fontWeight:800,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>{i+1}</div>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:12,fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{it.oem?`${it.oem} — `:""}{it.name}</div>
                  <div style={{fontSize:10,color:MU}}>{it.qty} sålda</div>
                </div>
                <div style={{fontSize:13,fontWeight:700,color:GR,flexShrink:0}}>{it.profit.toLocaleString("sv-SE")} kr</div>
              </div>
            ))}
          </div>
        )}

        {/* Lägst marginal — värt att se över priset på */}
        {lowMargin.length>0&&(
          <div style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,padding:14,marginBottom:14}}>
            <div style={{fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:10}}>Lägst marginal — värt att se över</div>
            {lowMargin.map((it,i)=>(
              <div key={it.name+i} style={{display:"flex",alignItems:"center",gap:10,padding:"7px 0",borderBottom:`1px solid ${BD}40`}}>
                <div style={{width:20,height:20,borderRadius:"50%",background:AM+"15",color:AM,fontSize:10,fontWeight:800,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}><Icon name="triangle-exclamation" style={{fontSize:9}}/></div>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:12,fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{it.oem?`${it.oem} — `:""}{it.name}</div>
                  <div style={{fontSize:10,color:MU}}>{it.qty} sålda · {it.rev.toLocaleString("sv-SE")} kr intäkt</div>
                </div>
                <div style={{fontSize:13,fontWeight:700,color:it.margin>=0?TX:R,flexShrink:0}}>{it.margin}%</div>
              </div>
            ))}
          </div>
        )}

        {/* Per kategori (intäkt) */}
        {catList.length>0&&(
          <div style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,padding:14,marginBottom:14}}>
            <div style={{fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:10}}>Per kategori</div>
            {catList.map(([cat,rev])=>{
              const pct = Math.round(rev/totalRev*100);
              return (
                <div key={cat} style={{marginBottom:10}}>
                  <div style={{display:"flex",justifyContent:"space-between",fontSize:12,fontWeight:600,marginBottom:4}}>
                    <span>{cat}</span>
                    <span>{rev.toLocaleString("sv-SE")} kr <span style={{color:MU,fontWeight:400}}>({pct}%)</span></span>
                  </div>
                  <div style={{height:6,background:BD,borderRadius:3,overflow:"hidden"}}>
                    <div style={{height:"100%",width:`${pct}%`,background:BX,borderRadius:3,transition:"width .5s"}}/>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {filtered.length===0&&<div style={{textAlign:"center",padding:40,color:MU,fontSize:13}}>Inga försäljningar under vald period.</div>}
      </div>
    </Page>
  );
}

// ─── Activity Log Page ────────────────────────────────────────────────────────
function ActivityLogPage({ activityLog, users, can, isAdmin, currentUser, pop }) {
  if (!isAdmin && !can("canViewActivityLog")) return <Page><TopBar title="Aktivitetslogg" onBack={pop}/><div style={{padding:40,textAlign:"center",color:MU}}><i className="fa-solid fa-lock" style={{fontSize:32,marginBottom:12,display:"block"}}/>Du saknar behörighet.</div></Page>;
  const [filter, setFilter] = useState("all");
  const [userFilter, setUserFilter] = useState("all");
  const [search, setSearch] = useState("");

  const types = {
    sale:    { l:"Försäljning", c:GR, icon:"tag" },
    add:     { l:"Tillagd",      c:BX,  icon:"plus" },
    edit:    { l:"Redigerad",    c:AM, icon:"pen" },
    delete:  { l:"Borttagen",    c:R,  icon:"trash" },
    reserve: { l:"Reserverad",   c:AM, icon:"bookmark" },
    reverse: { l:"Ångrad",       c:MU, icon:"rotate-left" },
    import:  { l:"Import",       c:TM, icon:"file-import" },
  };

  let log = (activityLog||[]);
  if (filter!=="all") log = log.filter(e=>e.type===filter);
  if (userFilter!=="all") log = log.filter(e=>e.user===userFilter);
  if (search.trim()) { const q=search.toLowerCase(); log = log.filter(e=>(e.description||"").toLowerCase().includes(q)||(e.user||"").toLowerCase().includes(q)); }

  const logUsers = ["all", ...new Set((activityLog||[]).map(e=>e.user).filter(Boolean))];
  const fmt = ts => { const d=new Date(ts); return d.toLocaleDateString("sv-SE",{day:"numeric",month:"short"})+" "+d.toLocaleTimeString("sv-SE",{hour:"2-digit",minute:"2-digit"}); };

  // Gruppera per dag för tydlighet
  const byDay = {};
  for (const e of log) {
    const day = new Date(e.ts).toLocaleDateString("sv-SE",{weekday:"long",day:"numeric",month:"long"});
    if (!byDay[day]) byDay[day]=[];
    byDay[day].push(e);
  }

  return (
    <Page>
      <TopBar title="Aktivitetslogg" onBack={pop} subtitle={`${log.length} händelser`}/>
      <div style={{padding:"14px 14px 60px"}}>
        {/* Sök */}
        <div style={{position:"relative",marginBottom:10}}>
          <Icon name="magnifying-glass" style={{position:"absolute",left:12,top:"50%",transform:"translateY(-50%)",color:MU,fontSize:13}}/>
          <input type="text" value={search} onChange={e=>setSearch(e.target.value)} placeholder="Sök i loggen…"
            style={{width:"100%",border:`1.5px solid ${BD}`,borderRadius:8,padding:"9px 12px 9px 34px",fontSize:14,boxSizing:"border-box"}}/>
        </div>

        {/* Typ-filter */}
        <div style={{display:"flex",gap:6,marginBottom:8,overflowX:"auto",paddingBottom:4}}>
          <button onClick={()=>setFilter("all")} style={{flexShrink:0,padding:"6px 14px",borderRadius:20,border:`1.5px solid ${filter==="all"?BX:BD}`,background:filter==="all"?BX:WH,color:filter==="all"?WH:TX,fontWeight:600,fontSize:11,cursor:"pointer"}}>Alla</button>
          {Object.entries(types).map(([k,{l}])=>(
            <button key={k} onClick={()=>setFilter(k)} style={{flexShrink:0,padding:"6px 14px",borderRadius:20,border:`1.5px solid ${filter===k?BX:BD}`,background:filter===k?BX:WH,color:filter===k?WH:TX,fontWeight:600,fontSize:11,cursor:"pointer"}}>{l}</button>
          ))}
        </div>

        {/* Användar-filter (om fler än en användare loggats) */}
        {logUsers.length>2&&(
          <div style={{display:"flex",gap:6,marginBottom:14,overflowX:"auto",paddingBottom:4}}>
            {logUsers.map(u=>(
              <button key={u} onClick={()=>setUserFilter(u)} style={{flexShrink:0,padding:"5px 12px",borderRadius:20,border:`1.5px solid ${userFilter===u?AM:BD}`,background:userFilter===u?AM:WH,color:userFilter===u?WH:TM,fontWeight:600,fontSize:11,cursor:"pointer"}}>{u==="all"?"Alla användare":u}</button>
            ))}
          </div>
        )}

        {log.length===0?(
          <div style={{textAlign:"center",padding:50,color:MU}}>
            <Icon name="clock-rotate-left" style={{fontSize:42,display:"block",margin:"0 auto 14px",color:BD}}/>
            <div style={{fontWeight:700,fontSize:15,marginBottom:6}}>Ingen aktivitet att visa</div>
            <div style={{fontSize:13}}>Försäljningar, ändringar och reservationer dyker upp här.</div>
          </div>
        ):(
          Object.entries(byDay).map(([day,entries])=>(
            <div key={day} style={{marginBottom:18}}>
              <div style={{fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:8}}>{day}</div>
              {entries.map(e=>{
                const t = types[e.type]||{l:e.type,c:MU,icon:"circle"};
                return (
                  <div key={e.id} style={{background:WH,borderRadius:8,border:`1px solid ${BD}`,padding:"10px 12px",marginBottom:6,display:"flex",gap:10,alignItems:"flex-start"}}>
                    <div style={{width:28,height:28,borderRadius:7,background:t.c+"18",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                      <i className={`fa-solid fa-${t.icon}`} style={{color:t.c,fontSize:12}}/>
                    </div>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontSize:13,fontWeight:600,lineHeight:1.35}}>{e.description}</div>
                      {e.user&&<div style={{fontSize:11,color:MU,marginTop:1}}>av {e.user}</div>}
                    </div>
                    <div style={{fontSize:11,color:MU,flexShrink:0,whiteSpace:"nowrap"}}>{new Date(e.ts).toLocaleTimeString("sv-SE",{hour:"2-digit",minute:"2-digit"})}</div>
                  </div>
                );
              })}
            </div>
          ))
        )}
      </div>
    </Page>
  );
}

// ─── Settings Page ────────────────────────────────────────────────────────────
function SettingsPage({ settings, saveSettings, items, sales, users, push, pop, toast$, can, isAdmin, saveItems }) {
  if (!isAdmin && !can("canManageSettings")) return <Page><TopBar title="Inställningar" onBack={pop}/><div style={{padding:40,textAlign:"center",color:MU}}><i className="fa-solid fa-lock" style={{fontSize:32,marginBottom:12,display:"block"}}/>Du saknar behörighet.</div></Page>;
  const [f, setF] = useState(settings||{});
  const [confirmClear, setConfirmClear] = useState(false);
  const U = (k,v) => setF(p=>({...p,[k]:v}));

  const save = async () => { await saveSettings(f); toast$("Inställningar sparade","success"); };

  const clearInventory = async () => {
    await saveItems([]);
    toast$("Lagret nollställt","success");
    setConfirmClear(false);
  };

  return (
    <Page>
      <TopBar title="Inställningar" onBack={pop} subtitle="System & konfiguration" right={<Btn small onClick={save}>Spara</Btn>}/>
      <div style={{padding:"14px 14px 60px",display:"flex",flexDirection:"column",gap:14}}>

        {/* Företagsinfo */}
        <div style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,padding:16}}>
          <div style={{fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:12}}>Företagsinformation (visas på kvitton)</div>
          <div style={{display:"flex",flexDirection:"column",gap:10}}>
            <Inp label="Företagsnamn" value={f.companyName||""} onChange={e=>U("companyName",e.target.value)} placeholder="Mitt Bildelar AB"/>
            <Inp label="Org.nummer" value={f.companyOrg||""} onChange={e=>U("companyOrg",e.target.value)} placeholder="556123-4567"/>
            <Inp label="Telefon" value={f.companyPhone||""} onChange={e=>U("companyPhone",e.target.value)} placeholder="010-123 45 67"/>
            <Inp label="Adress" value={f.companyAddress||""} onChange={e=>U("companyAddress",e.target.value)} placeholder="Gatan 1, 123 45 Stad"/>
          </div>
        </div>

        {/* Prissättning */}
        <div style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,padding:16}}>
          <div style={{fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:12}}>Prissättning</div>
          <div style={{display:"flex",flexDirection:"column",gap:10}}>
            <Inp label="Standardmarginal (%)" type="number" min="0" max="500" value={f.defaultMargin||40} onChange={e=>U("defaultMargin",Number(e.target.value))}/>
            <div style={{fontSize:12,color:MU}}>Används som förslag när du lägger till en ny artikel med inköpspris.</div>
          </div>
        </div>

        {/* Statistik */}
        <div style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,padding:16}}>
          <div style={{fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:12}}>Systeminfo</div>
          {[["Artiklar i lager", items?.length||0],["Försäljningar totalt", sales?.length||0],["Användare", users?.length||0]].map(([l,v])=>(
            <div key={l} style={{display:"flex",justifyContent:"space-between",padding:"8px 0",borderBottom:`1px solid ${BD}50`,fontSize:13}}>
              <span style={{color:MU}}>{l}</span><span style={{fontWeight:700}}>{v}</span>
            </div>
          ))}
        </div>

        {/* Genvägar */}
        <div style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,padding:16}}>
          <div style={{fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:12}}>Hantera</div>
          <div style={{display:"flex",flexDirection:"column",gap:8}}>
            <button onClick={()=>push("suppliers")} style={{display:"flex",alignItems:"center",gap:10,padding:"10px 0",background:"none",border:"none",borderBottom:`1px solid ${BD}50`,cursor:"pointer",textAlign:"left"}}>
              <Icon name="truck" style={{color:BX}}/><span style={{fontSize:13,fontWeight:600}}>Leverantörer</span><Icon name="arrow-up" style={{marginLeft:"auto",color:MU,transform:"rotate(90deg)"}}/>
            </button>
            <button onClick={()=>push("managelists")} style={{display:"flex",alignItems:"center",gap:10,padding:"10px 0",background:"none",border:"none",borderBottom:`1px solid ${BD}50`,cursor:"pointer",textAlign:"left"}}>
              <Icon name="list-check" style={{color:BX}}/><span style={{fontSize:13,fontWeight:600}}>Hantera listor (kategorier, skick m.m.)</span><Icon name="arrow-up" style={{marginLeft:"auto",color:MU,transform:"rotate(90deg)"}}/>
            </button>
            <button onClick={()=>push("menulayout")} style={{display:"flex",alignItems:"center",gap:10,padding:"10px 0",background:"none",border:"none",borderBottom:`1px solid ${BD}50`,cursor:"pointer",textAlign:"left"}}>
              <Icon name="bars-staggered" style={{color:BX}}/><span style={{fontSize:13,fontWeight:600}}>Meny-layout (ordna &amp; dölj)</span><Icon name="arrow-up" style={{marginLeft:"auto",color:MU,transform:"rotate(90deg)"}}/>
            </button>
            <button onClick={()=>push("emailnotify")} style={{display:"flex",alignItems:"center",gap:10,padding:"10px 0",background:"none",border:"none",borderBottom:`1px solid ${BD}50`,cursor:"pointer",textAlign:"left"}}>
              <Icon name="envelope" style={{color:BX}}/><span style={{fontSize:13,fontWeight:600}}>E-postnotiser</span><Icon name="arrow-up" style={{marginLeft:"auto",color:MU,transform:"rotate(90deg)"}}/>
            </button>
            <button onClick={()=>push("kgkdata")} style={{display:"flex",alignItems:"center",gap:10,padding:"10px 0",background:"none",border:"none",borderBottom:`1px solid ${BD}50`,cursor:"pointer",textAlign:"left"}}>
              <Icon name="car" style={{color:BX}}/><span style={{fontSize:13,fontWeight:600}}>KGK Fordonsdata</span><Icon name="arrow-up" style={{marginLeft:"auto",color:MU,transform:"rotate(90deg)"}}/>
            </button>
            <button onClick={()=>push("backup")} style={{display:"flex",alignItems:"center",gap:10,padding:"10px 0",background:"none",border:"none",borderBottom:`1px solid ${BD}50`,cursor:"pointer",textAlign:"left"}}>
              <Icon name="rotate" style={{color:BX}}/> <span style={{fontSize:13,fontWeight:600}}>Backup & Återställning</span><Icon name="arrow-up" style={{marginLeft:"auto",color:MU,transform:"rotate(90deg)"}}/>
            </button>
            <button onClick={()=>push("activitylog")} style={{display:"flex",alignItems:"center",gap:10,padding:"10px 0",background:"none",border:"none",cursor:"pointer",textAlign:"left"}}>
              <Icon name="list" style={{color:BX}}/><span style={{fontSize:13,fontWeight:600}}>Aktivitetslogg</span><Icon name="arrow-up" style={{marginLeft:"auto",color:MU,transform:"rotate(90deg)"}}/>
            </button>
          </div>
        </div>

        {/* Farliga åtgärder */}
        <div style={{background:WH,borderRadius:10,border:`1.5px solid ${R}30`,padding:16}}>
          <div style={{fontSize:11,fontWeight:700,color:R,textTransform:"uppercase",letterSpacing:.7,marginBottom:12}}>Farliga åtgärder</div>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <div>
              <div style={{fontWeight:600,fontSize:13}}>Nollställ lagret</div>
              <div style={{fontSize:11,color:MU,marginTop:2}}>Tar bort alla artiklar — användare och försäljningar påverkas inte</div>
            </div>
            <button onClick={()=>setConfirmClear(true)} style={{background:R,color:WH,border:"none",borderRadius:8,padding:"8px 14px",fontWeight:700,fontSize:13,cursor:"pointer",flexShrink:0,marginLeft:12}}>
              <Icon name="trash"/> Nollställ
            </button>
          </div>
        </div>

      </div>

      {/* Bekräftelsedialog */}
      {confirmClear&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.5)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:300,padding:20}} onClick={()=>setConfirmClear(false)}>
          <div onClick={e=>e.stopPropagation()} style={{background:WH,borderRadius:14,padding:24,maxWidth:340,width:"100%"}}>
            <div style={{fontWeight:800,fontSize:16,marginBottom:8,color:R}}>⚠ Nollställ lagret?</div>
            <div style={{fontSize:13,color:TM,marginBottom:20,lineHeight:1.5}}>
              Detta tar bort <strong>alla {items?.length||0} artiklar</strong> permanent.<br/>
              Användare, försäljningar och inställningar påverkas inte.<br/>
              <strong style={{color:R}}>Kan inte ångras.</strong>
            </div>
            <div style={{display:"flex",gap:8}}>
              <Btn full variant="ghost" onClick={()=>setConfirmClear(false)}>Avbryt</Btn>
              <Btn full variant="red" onClick={clearInventory}>Ja, nollställ lagret</Btn>
            </div>
          </div>
        </div>
      )}

    </Page>
  );
}
function BulkEditPage({ items, saveItems, lists, pop, toast$, can, isAdmin, currentUser, moveToTrash }) {
  if (!isAdmin && !can("canBulkEdit")) return <Page><TopBar title="Massredigering" onBack={pop}/><div style={{padding:40,textAlign:"center",color:MU}}><i className="fa-solid fa-lock" style={{fontSize:32,marginBottom:12,display:"block"}}/>Du saknar behörighet.</div></Page>;
  const [mode, setMode] = useState("edit"); // "edit" | "delete"
  const [selected, setSelected] = useState(new Set());
  const [field, setField] = useState("category");
  const [value, setValue] = useState("");
  const [locType, setLocType] = useState(""); // för placering: vald placeringstyp
  const [search, setSearch] = useState("");
  const [searchScope, setSearchScope] = useState("all"); // "all" | "stock"
  const [confirmBulk, setConfirmBulk] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const toggle = id => setSelected(s => { const n=new Set(s); n.has(id)?n.delete(id):n.add(id); return n; });
  const filtered = items.filter(i => {
    if (!search) return true;
    const q = search.toLowerCase();
    if (searchScope==="stock") {
      // Bara lagernummer — exakt eller delmatchning, samt komma-separerade ("11, 15")
      const nums = q.split(",").map(s=>s.trim()).filter(Boolean);
      const sn = (i.stockNumber||"").toLowerCase();
      return nums.some(n => sn===n || sn.includes(n));
    }
    return [i.name,i.sku,i.oem,i.stockNumber,i.category,i.regNumber,i.location,i.make,i.model,...(i.alternativeNumbers||[])].some(f=>f?.toLowerCase().includes(q));
  });
  const selAll = () => setSelected(new Set(filtered.map(i=>i.id)));

  const FIELDS = [
    {k:"category", l:"Kategori", opts:lists?.categories||CATEGORIES},
    {k:"condition", l:"Skick", opts:lists?.conditions||CONDITIONS},
    {k:"side", l:"Sida", opts:lists?.sides||SIDES},
    {k:"supplier", l:"Leverantör", opts:null},
    {k:"location", l:"Placering", opts:null},
  ];
  const currentField = FIELDS.find(f=>f.k===field);
  const LOCTYPES = lists?.locationTypes||LOCATION_TYPES;

  const apply = async () => {
    if (!value||selected.size===0) return;
    const updated = items.map(i => {
      if (!selected.has(i.id)) return i;
      if (field==="location") return {...i, location:value, locationType:locType||i.locationType, updatedAt:Date.now()};
      return {...i,[field]:value,updatedAt:Date.now()};
    });
    await saveItems(updated);
    toast$(`${selected.size} artiklar uppdaterade`,"success");
    setSelected(new Set()); setConfirmBulk(false); setValue(""); setLocType("");
  };

  const applyDelete = async () => {
    if (selected.size===0) return;
    const toTrash = items.filter(i => selected.has(i.id));
    const remaining = items.filter(i => !selected.has(i.id));
    await saveItems(remaining);
    moveToTrash?.(toTrash, currentUser?.username);
    toast$(`${selected.size} artiklar flyttade till papperskorgen`,"success");
    setSelected(new Set()); setConfirmDelete(false);
  };

  return (
    <Page flush noAnim>
      <TopBar title="Massredigering" onBack={pop} subtitle="Ändra eller ta bort flera artiklar"/>
      <div style={{flex:1,overflowY:"auto",WebkitOverflowScrolling:"touch",padding:"14px 14px 20px"}}>
        {/* Läge: ändra eller ta bort */}
        <div style={{display:"flex",gap:6,background:BG,borderRadius:10,padding:4,marginBottom:14}}>
          <button onClick={()=>{setMode("edit");}} style={{flex:1,padding:"9px",borderRadius:7,border:"none",background:mode==="edit"?WH:"transparent",color:mode==="edit"?BX:MU,fontWeight:700,fontSize:13,boxShadow:mode==="edit"?SH:"none",cursor:"pointer"}}><Icon name="pen"/> Ändra fält</button>
          <button onClick={()=>{setMode("delete");}} style={{flex:1,padding:"9px",borderRadius:7,border:"none",background:mode==="delete"?WH:"transparent",color:mode==="delete"?R:MU,fontWeight:700,fontSize:13,boxShadow:mode==="delete"?SH:"none",cursor:"pointer"}}><Icon name="trash"/> Ta bort</button>
        </div>

        {mode==="edit"&&(
          <div style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,padding:14,marginBottom:14}}>
            <div style={{fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:10}}>Vad ska ändras?</div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8}}>
              {FIELDS.map(f=>(
                <button key={f.k} onClick={()=>{setField(f.k);setValue("");setLocType("");}} style={{padding:"10px 6px",borderRadius:8,border:`2px solid ${field===f.k?BX:BD}`,background:field===f.k?B+"08":WH,fontWeight:field===f.k?700:500,fontSize:12,color:field===f.k?BX:TX,cursor:"pointer"}}>{f.l}</button>
              ))}
            </div>
            <div style={{marginTop:10}}>
              {field==="location" ? (
                <>
                  <Sel label="Placeringstyp (valfritt)" value={locType} onChange={e=>setLocType(e.target.value)} options={LOCTYPES}/>
                  <div style={{marginTop:8}}>
                    <Inp label="Placering" value={value} onChange={e=>setValue(e.target.value)} placeholder="t.ex. A12, Rum 3..."/>
                  </div>
                  <div style={{fontSize:11,color:MU,marginTop:4}}>Lämnar du placeringstyp tom behålls den befintliga typen på varje del.</div>
                </>
              ) : currentField?.opts
                ? <Sel label={`Nytt värde — ${currentField.l}`} value={value} onChange={e=>setValue(e.target.value)} options={["",  ...currentField.opts]}/>
                : <Inp label={`Nytt värde — ${currentField?.l}`} value={value} onChange={e=>setValue(e.target.value)} placeholder="Skriv nytt värde..."/>
              }
            </div>
          </div>
        )}

        {mode==="delete"&&(
          <div style={{background:R+"08",borderRadius:10,border:`1.5px solid ${R}40`,padding:14,marginBottom:14}}>
            <div style={{display:"flex",alignItems:"center",gap:8,color:R,fontWeight:700,fontSize:13,marginBottom:4}}><Icon name="triangle-exclamation"/> Ta bort flera artiklar</div>
            <div style={{fontSize:12,color:TM}}>Markera de artiklar du vill ta bort i listan nedan. Borttagning kan inte ångras — ta gärna en backup först.</div>
          </div>
        )}

        <div style={{display:"flex",gap:6,background:BG,borderRadius:8,padding:3,marginBottom:8}}>
          <button onClick={()=>setSearchScope("all")} style={{flex:1,padding:"7px",borderRadius:6,border:"none",background:searchScope==="all"?WH:"transparent",color:searchScope==="all"?BX:MU,fontWeight:700,fontSize:12,boxShadow:searchScope==="all"?SH:"none",cursor:"pointer"}}>Sök allt</button>
          <button onClick={()=>setSearchScope("stock")} style={{flex:1,padding:"7px",borderRadius:6,border:"none",background:searchScope==="stock"?WH:"transparent",color:searchScope==="stock"?BX:MU,fontWeight:700,fontSize:12,boxShadow:searchScope==="stock"?SH:"none",cursor:"pointer"}}>Bara lagernummer</button>
        </div>
        <div style={{display:"flex",gap:8,marginBottom:10,alignItems:"center"}}>
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder={searchScope==="stock"?"Lagernr (t.ex. 11, 15, 23)":"Sök (namn, lagernr, artikelnr, regnr...)"} style={{flex:1,padding:"9px 12px",border:`1.5px solid ${searchScope==="stock"?BX:BD}`,borderRadius:8,fontSize:13,background:searchScope==="stock"?B+"06":WH}}/>
          <button onClick={selAll} style={{flexShrink:0,padding:"9px 12px",borderRadius:8,border:`1.5px solid ${BD}`,background:WH,fontSize:12,fontWeight:600,cursor:"pointer",color:BX}}>Alla</button>
          <button onClick={()=>setSelected(new Set())} style={{flexShrink:0,padding:"9px 12px",borderRadius:8,border:`1.5px solid ${BD}`,background:WH,fontSize:12,fontWeight:600,cursor:"pointer",color:MU}}>Rensa</button>
        </div>
        <div style={{fontSize:11,color:MU,marginBottom:10}}>Visar {filtered.length} av {items.length} · {selected.size} valda</div>

        {filtered.map(item=>{
          const sel = selected.has(item.id);
          const accent = mode==="delete"?R:BX;
          return (
            <div key={item.id} onClick={()=>toggle(item.id)} style={{background:WH,borderRadius:8,border:`2px solid ${sel?accent:BD}`,padding:"10px 12px",marginBottom:6,display:"flex",gap:10,alignItems:"center",cursor:"pointer"}}>
              <div style={{width:20,height:20,borderRadius:5,border:`2px solid ${sel?accent:BD}`,background:sel?accent:"transparent",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                {sel&&<Icon name="check" style={{fontSize:10,color:WH}}/>}
              </div>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontWeight:600,fontSize:13,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{item.stockNumber?`#${item.stockNumber} `:""}{item.name}{item.side?` — ${item.side}`:""}</div>
                <div style={{fontSize:11,color:MU}}>{mode==="edit"?(field==="location"?[item.locationType,item.location].filter(Boolean).join(" ")||"—":(item[field]||"—")):(item.oem||item.sku)} · {item.sku}</div>
              </div>
              <div style={{fontWeight:700,color:BX,fontSize:13,flexShrink:0}}>{item.price.toLocaleString("sv-SE")} kr</div>
            </div>
          );
        })}
      </div>

      {/* Fast fot */}
      {mode==="edit"&&selected.size>0&&value&&(
        <div style={{flexShrink:0,background:WH,borderTop:`1px solid ${BD}`,padding:"12px 14px",paddingBottom:"max(12px,env(safe-area-inset-bottom))",boxShadow:"0 -4px 20px rgba(0,0,0,.08)"}}>
          <div style={{fontSize:12,color:MU,marginBottom:8}}>{selected.size} artiklar valda → ändra {currentField?.l} till <strong>"{field==="location"?`${locType?locType+" ":""}${value}`:value}"</strong></div>
          <Btn full variant="red" onClick={()=>setConfirmBulk(true)}>Tillämpa på {selected.size} artiklar</Btn>
        </div>
      )}
      {mode==="delete"&&selected.size>0&&(
        <div style={{flexShrink:0,background:WH,borderTop:`1px solid ${BD}`,padding:"12px 14px",paddingBottom:"max(12px,env(safe-area-inset-bottom))",boxShadow:"0 -4px 20px rgba(0,0,0,.08)"}}>
          <div style={{fontSize:12,color:MU,marginBottom:8}}>{selected.size} artiklar markerade för borttagning</div>
          <Btn full variant="red" onClick={()=>setConfirmDelete(true)}><Icon name="trash"/> Ta bort {selected.size} artiklar</Btn>
        </div>
      )}

      {confirmBulk&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.4)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:200,padding:20}} onClick={()=>setConfirmBulk(false)}>
          <div onClick={e=>e.stopPropagation()} style={{background:WH,borderRadius:14,padding:20,maxWidth:320,width:"100%"}}>
            <div style={{fontWeight:700,fontSize:15,marginBottom:8}}>Bekräfta massändring</div>
            <div style={{fontSize:13,color:MU,marginBottom:16}}>Ändrar {currentField?.l} till <strong>"{field==="location"?`${locType?locType+" ":""}${value}`:value}"</strong> på {selected.size} artiklar. Kan inte ångras.</div>
            <div style={{display:"flex",gap:8}}>
              <Btn full variant="ghost" onClick={()=>setConfirmBulk(false)}>Avbryt</Btn>
              <Btn full variant="red" onClick={apply}>Tillämpa</Btn>
            </div>
          </div>
        </div>
      )}

      {confirmDelete&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.4)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:200,padding:20}} onClick={()=>setConfirmDelete(false)}>
          <div onClick={e=>e.stopPropagation()} style={{background:WH,borderRadius:14,padding:20,maxWidth:340,width:"100%"}}>
            <div style={{fontWeight:700,fontSize:15,marginBottom:8,color:R}}>Ta bort {selected.size} artiklar?</div>
            <div style={{fontSize:13,color:MU,marginBottom:16}}>De {selected.size} markerade artiklarna tas bort permanent från lagret. Detta går inte att ångra.</div>
            <div style={{display:"flex",gap:8}}>
              <Btn full variant="ghost" onClick={()=>setConfirmDelete(false)}>Avbryt</Btn>
              <Btn full variant="red" onClick={applyDelete}>Ta bort permanent</Btn>
            </div>
          </div>
        </div>
      )}
    </Page>
  );
}

// ─── Suppliers Page ───────────────────────────────────────────────────────────
// ─── Kundregister ─────────────────────────────────────────────────────────────
function CustomersPage({ customers, saveCustomers, sales, push, pop, toast$, can, isAdmin }) {
  if (!isAdmin && !can("canManageCustomers")) return <Page><TopBar title="Kunder" onBack={pop}/><div style={{padding:40,textAlign:"center",color:MU}}><i className="fa-solid fa-lock" style={{fontSize:32,marginBottom:12,display:"block"}}/>Du saknar behörighet.</div></Page>;
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState(null); // "new" | id | null
  const [f, setF] = useState({name:"",phone:"",email:"",regNumbers:[],notes:""});
  const [regInput, setRegInput] = useState("");
  const [confirmDel, setConfirmDel] = useState(null);
  const [viewing, setViewing] = useState(null); // kund att visa historik för
  const U = (k,v) => setF(p=>({...p,[k]:v}));

  const openNew = () => { setF({name:"",phone:"",email:"",regNumbers:[],notes:""}); setRegInput(""); setEditing("new"); };
  const openEdit = c => { setF({...c, regNumbers:[...(c.regNumbers||[])]}); setRegInput(""); setEditing(c.id); };

  const addRegNumber = () => {
    const r = formatRegNumber(regInput);
    if (!r || r.length<6) return;
    if (f.regNumbers.includes(r)) { setRegInput(""); return; }
    U("regNumbers", [...f.regNumbers, r]);
    setRegInput("");
  };
  const removeRegNumber = r => U("regNumbers", f.regNumbers.filter(x=>x!==r));

  const save = async () => {
    if (!f.name.trim()) { toast$("Namn krävs","error"); return; }
    if (editing==="new") {
      await saveCustomers([{...f,id:genId("cust"),createdAt:Date.now()},...customers]);
    } else {
      await saveCustomers(customers.map(c=>c.id===editing?{...c,...f}:c));
    }
    toast$("Sparad","success"); setEditing(null);
  };
  const del = async id => {
    await saveCustomers(customers.filter(c=>c.id!==id));
    toast$("Borttagen","success"); setConfirmDel(null);
  };

  // Köphistorik — matchar på kundnamn ELLER något av kundens registreringsnummer
  // (nya köp kopplas dessutom direkt via customerId, se Kassan/Sälj)
  const historyFor = c => (sales||[]).filter(s =>
    s.customerId === c.id ||
    (s.buyer && s.buyer.trim().toLowerCase() === c.name.trim().toLowerCase()) ||
    (c.regNumbers||[]).some(r => s.regNumber === r)
  ).sort((a,b)=>b.soldAt-a.soldAt);

  const filtered = customers.filter(c => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return [c.name,c.phone,c.email,...(c.regNumbers||[])].some(v=>v?.toLowerCase().includes(q));
  }).sort((a,b)=>a.name.localeCompare(b.name,"sv"));

  return (
    <Page>
      <TopBar title="Kunder" onBack={pop} subtitle={`${customers.length} sparade`} right={<Btn small onClick={openNew}><Icon name="plus"/> Ny kund</Btn>} />
      <div style={{padding:"14px 14px 40px"}}>
        <div style={{position:"relative",marginBottom:14}}>
          <span style={{position:"absolute",left:10,top:"50%",transform:"translateY(-50%)",fontSize:13,color:MU,pointerEvents:"none"}}><Icon name="magnifying-glass"/></span>
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Sök namn, telefon, e-post, regnr…"
            style={{width:"100%",padding:"10px 10px 10px 32px",border:`1.5px solid ${BD}`,borderRadius:8,fontSize:13,boxSizing:"border-box"}}/>
        </div>

        {filtered.length===0&&<div style={{textAlign:"center",padding:40,color:MU}}>{customers.length===0?"Inga kunder sparade än":"Inga träffar"}</div>}

        <div style={{display:"flex",flexDirection:"column",gap:8}}>
          {filtered.map(c=>{
            const hist = historyFor(c);
            const totalSpent = hist.reduce((a,s)=>a+s.total,0);
            return (
              <div key={c.id} style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,padding:"12px 14px"}}>
                <div style={{display:"flex",alignItems:"flex-start",gap:10}} onClick={()=>setViewing(viewing===c.id?null:c.id)}>
                  <div style={{width:38,height:38,borderRadius:8,background:BX,display:"flex",alignItems:"center",justifyContent:"center",color:WH,fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:16,flexShrink:0,cursor:"pointer"}}>
                    {c.name[0]?.toUpperCase()||"?"}
                  </div>
                  <div style={{flex:1,minWidth:0,cursor:"pointer"}}>
                    <div style={{fontWeight:700,fontSize:14}}>{c.name}</div>
                    <div style={{fontSize:11.5,color:MU,display:"flex",gap:10,flexWrap:"wrap",marginTop:2}}>
                      {c.phone&&<span><i className="fa-solid fa-phone" style={{marginRight:4}}/>{c.phone}</span>}
                      {c.email&&<span><i className="fa-solid fa-envelope" style={{marginRight:4}}/>{c.email}</span>}
                    </div>
                    {c.regNumbers?.length>0&&<div style={{display:"flex",gap:5,flexWrap:"wrap",marginTop:6}}>{c.regNumbers.map(r=><span key={r} style={{background:BG,border:`1px solid ${BD}`,borderRadius:5,padding:"2px 7px",fontSize:11,fontWeight:700,fontFamily:"monospace"}}>{r}</span>)}</div>}
                  </div>
                  <div style={{textAlign:"right",flexShrink:0}}>
                    <div style={{fontSize:12,fontWeight:700,color:hist.length?GR:MU}}>{hist.length} köp</div>
                    {totalSpent>0&&<div style={{fontSize:11,color:MU}}>{totalSpent.toLocaleString("sv-SE")} kr</div>}
                  </div>
                </div>

                {viewing===c.id&&(
                  <div style={{marginTop:12,paddingTop:12,borderTop:`1px solid ${BD}`}}>
                    {c.notes&&<div style={{fontSize:12.5,color:TM,background:BG,borderRadius:7,padding:"8px 10px",marginBottom:10}}>{c.notes}</div>}
                    <div style={{fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:6}}>Köphistorik</div>
                    {hist.length===0&&<div style={{fontSize:12,color:MU}}>Inga registrerade köp än</div>}
                    {hist.slice(0,10).map(s=>(
                      <div key={s.id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"6px 0",borderBottom:`1px solid ${BD}30`,fontSize:12.5}}>
                        <span style={{overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",flex:1}}>{s.itemName}</span>
                        <span style={{color:MU,marginLeft:8,flexShrink:0}}>{new Date(s.soldAt).toLocaleDateString("sv-SE")}</span>
                        <span style={{fontWeight:700,marginLeft:8,flexShrink:0}}>{s.total.toLocaleString("sv-SE")} kr</span>
                      </div>
                    ))}
                    <div style={{display:"flex",gap:8,marginTop:12}} onClick={e=>e.stopPropagation()}>
                      <Btn small variant="ghost" onClick={()=>openEdit(c)}><Icon name="pen"/> Redigera</Btn>
                      <Btn small variant="ghost" onClick={()=>setConfirmDel(c)} style={{color:R}}><Icon name="trash"/></Btn>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {editing&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.4)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:200,padding:20}} onClick={()=>setEditing(null)}>
          <div onClick={e=>e.stopPropagation()} style={{background:WH,borderRadius:14,padding:20,maxWidth:400,width:"100%",maxHeight:"85vh",overflowY:"auto"}}>
            <div style={{fontWeight:700,fontSize:15,marginBottom:14}}>{editing==="new"?"Ny kund":"Redigera kund"}</div>
            <div style={{display:"flex",flexDirection:"column",gap:12}}>
              <Inp label="Namn *" value={f.name} onChange={e=>U("name",e.target.value)} autoFocus/>
              <Inp label="Telefon" value={f.phone} onChange={e=>U("phone",e.target.value)}/>
              <Inp label="E-post" type="email" value={f.email} onChange={e=>U("email",e.target.value)}/>
              <div>
                <label style={{display:"block",fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:4}}>Registreringsnummer (bilar)</label>
                <div style={{display:"flex",gap:6}}>
                  <input value={regInput} onChange={e=>setRegInput(formatRegNumber(e.target.value))} onKeyDown={e=>{if(e.key==="Enter"){e.preventDefault();addRegNumber();}}} placeholder="ABC 123"
                    style={{flex:1,border:`1.5px solid ${BD}`,borderRadius:7,padding:"9px 12px",fontSize:14,fontFamily:"monospace"}}/>
                  <Btn variant="ghost" onClick={addRegNumber}><Icon name="plus"/></Btn>
                </div>
                {f.regNumbers.length>0&&<div style={{display:"flex",gap:6,flexWrap:"wrap",marginTop:8}}>
                  {f.regNumbers.map(r=>(
                    <span key={r} style={{display:"flex",alignItems:"center",gap:5,background:BG,border:`1px solid ${BD}`,borderRadius:14,padding:"3px 6px 3px 10px",fontSize:12,fontWeight:700,fontFamily:"monospace"}}>
                      {r}<button onClick={()=>removeRegNumber(r)} style={{background:"none",border:"none",color:MU,cursor:"pointer",padding:2}}>×</button>
                    </span>
                  ))}
                </div>}
              </div>
              <div>
                <label style={{display:"block",fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:4}}>Notering</label>
                <textarea value={f.notes} onChange={e=>U("notes",e.target.value)} rows={2}
                  style={{width:"100%",border:`1.5px solid ${BD}`,borderRadius:7,padding:"9px 12px",fontSize:13,fontFamily:"inherit",resize:"vertical",boxSizing:"border-box"}}/>
              </div>
            </div>
            <div style={{display:"flex",gap:8,marginTop:18}}>
              <Btn full variant="ghost" onClick={()=>setEditing(null)}>Avbryt</Btn>
              <Btn full onClick={save}>Spara</Btn>
            </div>
          </div>
        </div>
      )}

      {confirmDel&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.4)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:200,padding:20}} onClick={()=>setConfirmDel(null)}>
          <div onClick={e=>e.stopPropagation()} style={{background:WH,borderRadius:14,padding:20,maxWidth:340,width:"100%"}}>
            <div style={{fontWeight:700,fontSize:15,marginBottom:8}}>Ta bort {confirmDel.name}?</div>
            <div style={{fontSize:13,color:MU,marginBottom:16}}>Köphistoriken finns kvar i säljloggen, bara själva kundkortet tas bort. Går inte att ångra.</div>
            <div style={{display:"flex",gap:8}}>
              <Btn full variant="ghost" onClick={()=>setConfirmDel(null)}>Avbryt</Btn>
              <Btn full variant="red" onClick={()=>del(confirmDel.id)}>Ta bort</Btn>
            </div>
          </div>
        </div>
      )}
    </Page>
  );
}

function SuppliersPage({ suppliers, saveSuppliers, items, pop, toast$, can, isAdmin }) {
  if (!isAdmin && !can("canManageSuppliers")) return <Page><TopBar title="Leverantörer" onBack={pop}/><div style={{padding:40,textAlign:"center",color:MU}}><i className="fa-solid fa-lock" style={{fontSize:32,marginBottom:12,display:"block"}}/>Du saknar behörighet.</div></Page>;
  const [editing, setEditing] = useState(null);
  const [f, setF] = useState({name:"",contact:"",phone:"",email:"",notes:""});
  const [confirmDel, setConfirmDel] = useState(null);
  const U = (k,v) => setF(p=>({...p,[k]:v}));

  const openNew = () => { setF({name:"",contact:"",phone:"",email:"",notes:""}); setEditing("new"); };
  const openEdit = sup => { setF({...sup}); setEditing(sup.id); };

  const save = async () => {
    if (!f.name.trim()) { toast$("Namn krävs","error"); return; }
    if (editing==="new") {
      await saveSuppliers([...suppliers,{...f,id:genId("sup"),createdAt:Date.now()}]);
    } else {
      await saveSuppliers(suppliers.map(s=>s.id===editing?{...s,...f}:s));
    }
    toast$("Sparad","success"); setEditing(null);
  };

  const del = async id => {
    await saveSuppliers(suppliers.filter(s=>s.id!==id));
    toast$("Borttagen","success"); setConfirmDel(null);
  };

  // Hur många artiklar per leverantör
  const itemCount = sup => items.filter(i=>(i.supplier||"").toLowerCase()===sup.name.toLowerCase()).length;

  return (
    <Page>
      <TopBar title="Leverantörer" onBack={pop} subtitle="Kontakter & info" right={<Btn small onClick={openNew}><Icon name="plus"/> Ny</Btn>}/>
      <div style={{padding:"14px 14px 60px"}}>
        {suppliers.length===0&&!editing&&(
          <div style={{textAlign:"center",padding:40,color:MU}}>
            <Icon name="truck" style={{fontSize:36,display:"block",margin:"0 auto 12px"}}/>
            Inga leverantörer ännu. Lägg till din första!
          </div>
        )}

        {suppliers.map(sup=>(
          <div key={sup.id} style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,padding:14,marginBottom:8}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
              <div style={{flex:1}}>
                <div style={{fontWeight:700,fontSize:15}}>{sup.name}</div>
                <div style={{fontSize:12,color:MU,marginTop:2}}>{itemCount(sup)} artiklar i lager</div>
                {sup.contact&&<div style={{fontSize:12,color:TM,marginTop:4}}>{sup.contact}</div>}
                {sup.phone&&<div style={{fontSize:12,color:TM}}><Icon name="phone" style={{marginRight:4}}/>{sup.phone}</div>}
                {sup.email&&<div style={{fontSize:12,color:TM}}><Icon name="envelope" style={{marginRight:4}}/>{sup.email}</div>}
                {sup.notes&&<div style={{fontSize:11,color:MU,marginTop:6,fontStyle:"italic"}}>{sup.notes}</div>}
              </div>
              <div style={{display:"flex",gap:6}}>
                <Btn small variant="ghost" onClick={()=>openEdit(sup)}><Icon name="pen"/></Btn>
                <Btn small variant="ghost" onClick={()=>setConfirmDel(sup.id)} style={{color:R}}><Icon name="trash"/></Btn>
              </div>
            </div>
          </div>
        ))}

        {editing&&(
          <div style={{background:WH,borderRadius:10,border:`2px solid ${BX}`,padding:16,marginTop:14}}>
            <div style={{fontWeight:700,fontSize:14,marginBottom:12}}>{editing==="new"?"Ny leverantör":"Redigera leverantör"}</div>
            <div style={{display:"flex",flexDirection:"column",gap:10}}>
              <Inp label="Namn *" value={f.name} onChange={e=>U("name",e.target.value)} placeholder="Leverantör AB"/>
              <Inp label="Kontaktperson" value={f.contact||""} onChange={e=>U("contact",e.target.value)}/>
              <Inp label="Telefon" value={f.phone||""} onChange={e=>U("phone",e.target.value)}/>
              <Inp label="E-post" value={f.email||""} onChange={e=>U("email",e.target.value)}/>
              <div>
                <label style={{display:"block",fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:4}}>Anteckningar</label>
                <textarea value={f.notes||""} onChange={e=>U("notes",e.target.value)} rows={2} style={{width:"100%",border:`1.5px solid ${BD}`,borderRadius:6,padding:"9px 12px",fontSize:13,resize:"none",fontFamily:"inherit"}}/>
              </div>
            </div>
            <div style={{display:"flex",gap:8,marginTop:12}}>
              <Btn full variant="ghost" onClick={()=>setEditing(null)}>Avbryt</Btn>
              <Btn full onClick={save}>Spara</Btn>
            </div>
          </div>
        )}
      </div>

      {confirmDel&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.4)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:200,padding:20}} onClick={()=>setConfirmDel(null)}>
          <div onClick={e=>e.stopPropagation()} style={{background:WH,borderRadius:14,padding:20,maxWidth:320,width:"100%"}}>
            <div style={{fontWeight:700,fontSize:15,marginBottom:8}}>Ta bort leverantör?</div>
            <div style={{fontSize:13,color:MU,marginBottom:16}}>Artiklar kopplade till leverantören påverkas inte.</div>
            <div style={{display:"flex",gap:8}}>
              <Btn full variant="ghost" onClick={()=>setConfirmDel(null)}>Avbryt</Btn>
              <Btn full variant="red" onClick={()=>del(confirmDel)}>Ta bort</Btn>
            </div>
          </div>
        </div>
      )}
    </Page>
  );
}

// ─── Backup Page ──────────────────────────────────────────────────────────────
function BackupPage({ items, sales, users, settings, suppliers, roles, lists, activityLog, favorites, trash, saveItems, saveSales, saveUsers, saveSettings, saveSuppliers, saveRoles, saveLists, saveTrash, setItems, setSales, setSettings, setSuppliers, pop, toast$, can, isAdmin, isFullAdmin, customers, saveCustomers }) {
  if (!isAdmin && !can("canBackup")) return <Page><TopBar title="Backup" onBack={pop}/><div style={{padding:40,textAlign:"center",color:MU}}><i className="fa-solid fa-lock" style={{fontSize:32,marginBottom:12,display:"block"}}/>Du saknar behörighet.</div></Page>;
  const [restoring, setRestoring] = useState(false);
  // Fabriksåterställning — rensar all lager-/sälj-data, men rör INTE
  // användarkonton (så man inte blir utelåst av misstag). Kräver att man
  // skriver en bekräftelsefras för att undvika ett klick-i-onödan-misstag.
  const [resetConfirmText, setResetConfirmText] = useState("");
  const [resetting, setResetting] = useState(false);
  const doFactoryReset = async () => {
    setResetting(true);
    try {
      const r = await fetch(`${API}/factory-reset`, {
        method:"POST", headers: authHeaders({"Content-Type":"application/json"}),
        body: JSON.stringify({ confirm: resetConfirmText.trim() }),
      }).then(r=>r.json());
      if (!r.ok) {
        toast$(r.error||"Kunde inte återställa","error");
      } else {
        setItems([]); setSales([]);
        saveTrash([]); saveCustomers?.([]);
        toast$("Återställt — allt är nu tomt, redo att börja om","success");
        setResetConfirmText("");
      }
    } catch {
      toast$("Kunde inte nå servern","error");
    }
    setResetting(false);
  };
  const fileRef = useRef(null);
  // Generisk molnanslutning för backup (rclone) — fungerar med valfri
  // molntjänst rclone stödjer, inte bara OneDrive.
  const [cloudRemote, setCloudRemote] = useState("");
  const [cloudSaving, setCloudSaving] = useState(false);
  const [cloudTesting, setCloudTesting] = useState(false);
  useEffect(() => { sget("ow:backupcloud").then(v => { if (v?.remote) setCloudRemote(v.remote); }); }, []);
  const saveCloudRemote = async () => {
    setCloudSaving(true);
    await sset("ow:backupcloud", { remote: cloudRemote.trim() });
    setCloudSaving(false);
    toast$("Sparat","success");
  };
  const testCloudRemote = async () => {
    if (!cloudRemote.trim()) { toast$("Fyll i fjärrens namn först","error"); return; }
    setCloudTesting(true);
    try {
      const r = await fetch("/admin/api/backup-cloud/test", { method:"POST", headers: authHeaders({"Content-Type":"application/json"}), body: JSON.stringify({ remote: cloudRemote.trim() }) }).then(r=>r.json());
      toast$(r.ok ? (r.message||"Anslutningen fungerar") : (r.error||"Kunde inte ansluta"), r.ok?"success":"error");
    } catch { toast$("Kunde inte nå servern","error"); }
    setCloudTesting(false);
  };

  const doBackup = async () => {
    // Samla ihop bilderna via snabb endpoint för komplett backup
    const itemsWithImages = [];
    for (const it of items) {
      if (it.hasImages > 0 && (!it.images || it.images.length === 0)) {
        const imgs = await getImages(it.id);
        itemsWithImages.push({ ...it, images: imgs || [] });
      } else {
        itemsWithImages.push(it);
      }
    }
    const data = { version:4, exportedAt:new Date().toISOString(), items: itemsWithImages, sales, users: users.map(u=>({...u,password:undefined})), settings, suppliers, roles, lists, activitylog: activityLog, favorites, trash };
    const json = JSON.stringify(data, null, 2);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([json],{type:"application/json"}));
    a.download = `lager_backup_${new Date().toLocaleDateString("sv-SE").replace(/\//g,"-")}.json`;
    a.click();
    toast$("Backup skapad!","success");
  };

  const doRestore = async (file) => {
    if (!file) return;
    setRestoring(true);
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!data.items || !data.users) throw new Error("Ogiltig backup-fil");

      const allItems = data.items;
      const BATCH = 40;  // små batchar så inget anrop avbryts
      let finalItems = [];

      for (let i = 0; i < allItems.length; i += BATCH) {
        const batch = allItems.slice(i, i + BATCH);
        const isFirst = i === 0;
        const res = await fetch(`${API}/restore`, {
          method: "POST",
          headers: authHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify({
            items: batch,
            first: isFirst,
            // Skicka metadata bara i första batchen
            sales: isFirst ? (data.sales || []) : null,
            users: isFirst ? (data.users || []) : null,
            settings: isFirst ? (data.settings || null) : null,
            suppliers: isFirst ? (data.suppliers || []) : null,
            roles: isFirst ? (data.roles || null) : null,
            lists: isFirst ? (data.lists || null) : null,
            activitylog: isFirst ? (data.activitylog || null) : null,
            favorites: isFirst ? (data.favorites || null) : null,
            trash: isFirst ? (data.trash || null) : null,
          }),
        });
        if (!res.ok) {
          let reason = "";
          try { const err = await res.json(); reason = err.error || ""; } catch {}
          throw new Error(`Del ${i+1}: ${reason || `serverfel ${res.status}`}`);
        }
        const result = await res.json();
        finalItems = result.items;
        // Visa framsteg
        setRestoreProgress(Math.min(100, Math.round(((i + BATCH) / allItems.length) * 100)));
      }

      setItems(finalItems);
      if (data.sales) setSales?.(data.sales);
      if (data.settings) setSettings?.(data.settings);
      if (data.suppliers) setSuppliers?.(data.suppliers);
      // Roller, listor och papperskorg sparas redan av servern som en del
      // av /api/restore (se server.cjs) — inget extra klientanrop behövs
      // här. De gjorde bara dubbelarbete och orsakade "value saknas i
      // body" ibland (t.ex. om fältet saknades i en äldre backup-fil).

      toast$(`Klart! ${finalItems.length} delar återställda — laddar om…`,"success");
      // Ladda om så allt (roller, listor, logg, användare) säkert syns
      setTimeout(()=>window.location.reload(), 1200);
    } catch(e) {
      toast$("Fel: "+e.message,"error");
    }
    setRestoring(false);
    setRestoreProgress(0);
  };
  const [restoreProgress, setRestoreProgress] = useState(0);

  const stats = [
    ["Artiklar",items?.length||0],
    ["Försäljningar",sales?.length||0],
    ["Leverantörer",suppliers?.length||0],
  ];

  return (
    <Page>
      <TopBar title="Backup" onBack={pop} subtitle="Säkerhetskopiera data"/>
      <div style={{padding:"14px 14px 60px"}}>

        {/* Backup */}
        <div style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,padding:16,marginBottom:14}}>
          <div style={{fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:6}}>Skapa backup</div>
          <div style={{fontSize:13,color:TM,marginBottom:12}}>Exporterar all data (artiklar, försäljningar, inställningar, leverantörer) till en JSON-fil. Spara filen på ett säkert ställe.</div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:14}}>
            {stats.map(([l,v])=>(
              <div key={l} style={{background:B+"08",borderRadius:8,padding:"10px",textAlign:"center"}}>
                <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:22,fontWeight:800,color:BX}}>{v}</div>
                <div style={{fontSize:11,color:MU}}>{l}</div>
              </div>
            ))}
          </div>
          <Btn full onClick={doBackup}><Icon name="file-export"/> Ladda ner backup</Btn>
        </div>

        {/* Molnanslutning för automatiska backuper — valfri molntjänst via rclone */}
        <div style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,padding:16,marginBottom:14}}>
          <div style={{fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:6}}>Automatiska backuper till molnet</div>
          <div style={{fontSize:13,color:TM,marginBottom:12}}>
            De automatiska fredagsbackuperna sparas alltid lokalt (i OneDrive-mappen om den finns). Vill du dessutom skicka dem till <b>vilken molntjänst som helst</b> (Google Drive, Dropbox, S3, med mera — inte bara OneDrive) kopplar du in det här.
          </div>
          <div style={{background:BG,borderRadius:8,padding:12,marginBottom:12,fontSize:12,color:TM}}>
            <b>Engångsuppsättning</b> (görs en gång i Terminalen på servern):
            <ol style={{margin:"6px 0 0",paddingLeft:18}}>
              <li>Installera rclone: <code>winget install Rclone.Rclone</code></li>
              <li>Koppla ditt konto: <code>rclone config</code> — öppnar webbläsaren, du loggar in, klart</li>
              <li>Namnge fjärren, t.ex. <code>onedrive</code> eller <code>gdrive</code></li>
            </ol>
          </div>
          <Inp label="Fjärrens namn och mapp" value={cloudRemote} onChange={e=>setCloudRemote(e.target.value)} placeholder="t.ex. onedrive:Lager-backups"/>
          <div style={{display:"flex",gap:8,marginTop:10}}>
            <Btn variant="ghost" onClick={testCloudRemote} disabled={cloudTesting}><Icon name="plug"/> {cloudTesting?"Testar…":"Testa anslutning"}</Btn>
            <Btn onClick={saveCloudRemote} disabled={cloudSaving}><Icon name="check"/> Spara</Btn>
          </div>
        </div>

        {/* Fabriksåterställning — bara för huvudadmin */}
        {isFullAdmin&&(
          <div style={{background:WH,borderRadius:10,border:`1px solid ${R}30`,padding:16}}>
            <div style={{fontSize:11,fontWeight:700,color:R,textTransform:"uppercase",letterSpacing:.7,marginBottom:6}}><Icon name="triangle-exclamation" style={{marginRight:5}}/>Fabriksåterställning</div>
            <div style={{fontSize:13,color:TM,marginBottom:12}}>
              Rensar <b>alla delar, all säljlogg, papperskorgen och kundregistret</b> — allt börjar helt tomt. Användare, inställningar och listor (kategorier, lager-orter osv.) rörs inte, så du blir inte utelåst.
            </div>
            <div style={{background:R+"08",border:`1px solid ${R}20`,borderRadius:8,padding:10,marginBottom:12,fontSize:12,color:R,fontWeight:600}}>
              ⚠ Går inte att ångra. Skapa en backup först om du är osäker.
            </div>
            <label style={{display:"block",fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:4}}>Skriv "NOLLSTÄLL" för att bekräfta</label>
            <input value={resetConfirmText} onChange={e=>setResetConfirmText(e.target.value)} placeholder="NOLLSTÄLL"
              style={{width:"100%",padding:"9px 12px",border:`1.5px solid ${BD}`,borderRadius:7,fontSize:14,marginBottom:10,boxSizing:"border-box"}}/>
            <Btn full variant="red" disabled={resetConfirmText.trim()!=="NOLLSTÄLL"||resetting} onClick={doFactoryReset}>
              {resetting?"Återställer…":"Nollställ allt"}
            </Btn>
          </div>
        )}

        {/* Restore */}
        <div style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,padding:16}}>
          <div style={{fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:6}}>Återställ från backup</div>
          <div style={{background:R+"08",border:`1px solid ${R}20`,borderRadius:8,padding:10,marginBottom:12,fontSize:12,color:R,fontWeight:600}}>
            ⚠ Varning: Återställning skriver över befintlig data. Skapa en backup först.
          </div>
          <div onClick={()=>fileRef.current?.click()} style={{border:`2px dashed ${BD}`,borderRadius:10,padding:"30px 20px",textAlign:"center",cursor:"pointer",background:BG}}>
            <Icon name="rotate" style={{fontSize:28,color:MU,display:"block",margin:"0 auto 8px"}}/>
            <div style={{fontSize:13,fontWeight:600,color:MU}}>{restoring?`Återställer... ${restoreProgress}%`:"Klicka för att välja backup-fil (.json)"}</div>
          </div>
          <input ref={fileRef} type="file" accept=".json" style={{display:"none"}} onChange={e=>doRestore(e.target.files[0])}/>
        </div>

      </div>
    </Page>
  );
}


function DashboardPage({ items, sales, users, can, isAdmin, currentUser, push, pop, toast$, lists }) {
  if (!currentUser || (!isAdmin && !can("canViewDashboard"))) return (
    <Page>
      <TopBar title="Dashboard" onBack={pop} subtitle="Statistik & översikt"/>
      <div style={{padding:40,textAlign:"center"}}>
        <Icon name="chart-line" style={{fontSize:48,color:BD,marginBottom:16}}/>
        <div style={{fontWeight:700,fontSize:16,color:TX,marginBottom:8}}>Inloggning krävs</div>
        <div style={{fontSize:13,color:MU,marginBottom:20}}>Du måste vara inloggad för att se statistik.</div>
        <Btn onClick={()=>push("login")}>Logga in</Btn>
      </div>
    </Page>
  );

  // Lager-väljare — filtrerar HELA dashboarden (alla grafer/siffror nedan
  // härleds från allSales, så allt uppdateras automatiskt när man byter).
  const [whFilter, setWhFilter] = useState("");
  const WHS = lists?.warehouses||WAREHOUSES;
  const allSales = (sales||[]).filter(s => !whFilter || s.itemSnapshot?.warehouse === whFilter);
  const itemsInScope = whFilter ? items.filter(i=>i.warehouse===whFilter) : items;
  const now = Date.now();
  const salesMonth = allSales.filter(s=>now-s.soldAt<30*864e5);
  const salesWeek  = allSales.filter(s=>now-s.soldAt<7*864e5);
  const totalVal   = itemsInScope.reduce((s,i)=>s+(i.price||0)*(i.quantity||0),0);
  const totalQty   = itemsInScope.reduce((s,i)=>s+(i.quantity||0),0);
  const revMonth   = salesMonth.reduce((a,s)=>a+s.total,0);
  const profMonth  = salesMonth.reduce((a,s)=>a+(s.profit||0),0);
  const revWeek    = salesWeek.reduce((a,s)=>a+s.total,0);

  // Jämförelse mellan lagren (visas bara i "Alla lager"-läget) — omsättning
  // senaste 30 dagarna per lager, för en snabb koll på hur de presterar.
  const warehouseComparison = WHS.map(w => {
    const wSales = (sales||[]).filter(s => s.itemSnapshot?.warehouse===w && now-s.soldAt<30*864e5);
    return { name:w, rev: wSales.reduce((a,s)=>a+s.total,0), profit: wSales.reduce((a,s)=>a+(s.profit||0),0), count: wSales.length };
  });

  const sellerRev = {};
  salesMonth.forEach(s=>{ sellerRev[s.soldBy]=(sellerRev[s.soldBy]||0)+s.total; });
  const topSellers = Object.entries(sellerRev).sort((a,b)=>b[1]-a[1]).slice(0,5);

  const itemCount = {};
  allSales.forEach(s=>{ itemCount[s.itemName]=(itemCount[s.itemName]||0)+s.qty; });
  const topItems = Object.entries(itemCount).sort((a,b)=>b[1]-a[1]).slice(0,5);

  // ── Grafdata: intäkt/vinst per dag, senaste 30 dagarna ──
  const dailyData = [];
  for (let i = 29; i >= 0; i--) {
    const dayStart = now - i*864e5;
    const d = new Date(dayStart);
    d.setHours(0,0,0,0);
    const dayEnd = d.getTime() + 864e5;
    const daySales = allSales.filter(s => s.soldAt >= d.getTime() && s.soldAt < dayEnd);
    dailyData.push({
      date: d.toLocaleDateString("sv-SE",{day:"numeric",month:"short"}),
      Intäkt: daySales.reduce((a,s)=>a+s.total,0),
      Vinst: daySales.reduce((a,s)=>a+(s.profit||0),0),
    });
  }

  // ── Grafdata: försäljning per kategori, senaste 30 dagarna ──
  const catRev = {};
  salesMonth.forEach(s => {
    const cat = s.itemSnapshot?.category || "Övrigt";
    catRev[cat] = (catRev[cat]||0) + s.total;
  });
  const catData = Object.entries(catRev).sort((a,b)=>b[1]-a[1]).slice(0,7).map(([name,value])=>({name,value}));
  const PIE_COLORS = [BX, R, GR, AM, "#8B5CF6", "#EC4899", "#14B8A6"];

  const ChartTooltip = ({ active, payload, label }) => {
    if (!active || !payload?.length) return null;
    return (
      <div style={{background:WH,border:`1px solid ${BD}`,borderRadius:8,padding:"8px 12px",boxShadow:SH2,fontSize:12}}>
        <div style={{fontWeight:700,marginBottom:4}}>{label}</div>
        {payload.map(p => (
          <div key={p.name} style={{color:p.color,fontWeight:600}}>{p.name}: {p.value.toLocaleString("sv-SE")} kr</div>
        ))}
      </div>
    );
  };

  const fmt = ts => new Date(ts).toLocaleDateString("sv-SE",{day:"numeric",month:"short"})+" "+new Date(ts).toLocaleTimeString("sv-SE",{hour:"2-digit",minute:"2-digit"});

  const StatCard = ({label,value,color,icon,sub})=>(
    <div style={{background:WH,borderRadius:12,padding:"14px",border:`1px solid ${BD}`,boxShadow:SH}}>
      <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:6}}>
        <div style={{width:26,height:26,borderRadius:7,background:color+"18",display:"flex",alignItems:"center",justifyContent:"center"}}>
          <Icon name={icon} style={{fontSize:12,color}}/>
        </div>
        <span style={{fontSize:10,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7}}>{label}</span>
      </div>
      <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:26,fontWeight:800,color,lineHeight:1.1}}>{value}</div>
      {sub&&<div style={{fontSize:11,color:MU,marginTop:3}}>{sub}</div>}
    </div>
  );

  const Section = ({title,action,onAction})=>(
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8,marginTop:18}}>
      <div style={{fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7}}>{title}</div>
      {action&&<button onClick={onAction} style={{background:"none",border:"none",color:BX,fontSize:12,fontWeight:600,cursor:"pointer"}}>{action}</button>}
    </div>
  );

  return (
    <Page>
      <TopBar title="Dashboard" onBack={pop} subtitle="Statistik & översikt"/>
      <div style={{padding:"14px 14px 40px"}}>

        {/* Lager-väljare — filtrerar hela sidan */}
        {WHS.length>1&&(
          <div style={{display:"flex",gap:6,overflowX:"auto",paddingBottom:10}}>
            <button onClick={()=>setWhFilter("")} style={{flexShrink:0,padding:"6px 14px",borderRadius:16,border:`1.5px solid ${!whFilter?BX:BD}`,background:!whFilter?BX:WH,color:!whFilter?WH:TM,fontSize:12,fontWeight:600,whiteSpace:"nowrap",cursor:"pointer"}}>Alla lager</button>
            {WHS.map(w=>(
              <button key={w} onClick={()=>setWhFilter(whFilter===w?"":w)} style={{flexShrink:0,padding:"6px 14px",borderRadius:16,border:`1.5px solid ${whFilter===w?AM:BD}`,background:whFilter===w?AM:WH,color:whFilter===w?WH:TM,fontSize:12,fontWeight:600,whiteSpace:"nowrap",cursor:"pointer"}}><i className="fa-solid fa-industry" style={{fontSize:10,marginRight:5}}/>{w}</button>
            ))}
          </div>
        )}

        {/* Jämförelse mellan lagren — bara i "Alla lager"-läget */}
        {!whFilter&&WHS.length>1&&(
          <>
            <Section title="Lagren jämfört — 30 dagar"/>
            <div style={{display:"grid",gridTemplateColumns:`repeat(${WHS.length},1fr)`,gap:8,marginBottom:6}}>
              {warehouseComparison.map(w=>(
                <div key={w.name} onClick={()=>setWhFilter(w.name)} style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,padding:14,cursor:"pointer",boxShadow:SH}}>
                  <div style={{fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.6,marginBottom:6}}><i className="fa-solid fa-industry" style={{marginRight:5,color:AM}}/>{w.name}</div>
                  <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:24,fontWeight:800,color:BX,lineHeight:1}}>{w.rev.toLocaleString("sv-SE")} kr</div>
                  <div style={{fontSize:11,color:MU,marginTop:4}}>{w.count} sälj · {w.profit.toLocaleString("sv-SE")} kr vinst</div>
                </div>
              ))}
            </div>
          </>
        )}

        {/* Snabbåtgärder */}
        <Section title="Snabbåtgärder"/>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:6}}>
          {[
            {icon:"qrcode",    label:"Skanna",      route:"scan",        show:isAdmin||can("canScan")},
            {icon:"qrcode",    label:"Etiketter", route:"qrlabels",   show:isAdmin},
            {icon:"location-dot",label:"Platser",    route:"locationview", show:(isAdmin||can("canView"))},
            {icon:"file-export",label:"Importera",  route:"import",      show:isAdmin||can("canAdd")},
            {icon:"chart-line",label:"Rapporter",   route:"reports",     show:isAdmin||can("canViewReports")},
            {icon:"chart-line",label:"Säljlogg",    route:"saleslog",    show:isAdmin||can("canViewLog")},
            {icon:"bookmark",  label:"Reservationer", route:"reservations", show:isAdmin||can("canViewReservations")},
            {icon:"clock-rotate-left",label:"Aktivitetslogg", route:"activitylog", show:isAdmin||can("canViewActivityLog")},
            {icon:"pen",       label:"Massredigera", route:"bulkedit",   show:isAdmin},
            {icon:"truck",     label:"Leverantörer", route:"suppliers",  show:isAdmin},
            {icon:"address-book", label:"Kunder",       route:"customers",  show:isAdmin||can("canManageCustomers")},
            {icon:"rotate",    label:"Backup",       route:"backup",     show:isAdmin},
          ].filter(a=>a.show).map(a=>(
            <button key={a.route} onClick={()=>push(a.route)} style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,padding:"14px 8px",display:"flex",flexDirection:"column",alignItems:"center",gap:6,cursor:"pointer"}}>
              <Icon name={a.icon} style={{fontSize:18,color:BX}}/>
              <span style={{fontSize:11,fontWeight:600,color:TX,textAlign:"center"}}>{a.label}</span>
            </button>
          ))}
        </div>

        {/* Lager */}
        <Section title="Lager"/>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
          <StatCard label="Artiklar"       value={items.length}  color={BX}  icon="list"/>
          <StatCard label="Tot. kvantitet" value={totalQty}      color={BX}  icon="tag"/>
          <StatCard label="Lagervärde"     value={totalVal.toLocaleString("sv-SE")+" kr"} color={GR} icon="file-export"/>
        </div>

        {/* Försäljning */}
        {(isAdmin||can("canViewLog"))&&<>
          <Section title="Försäljning — 30 dagar" action="Visa logg" onAction={()=>push("saleslog")}/>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
            <StatCard label="Intäkt"    value={revMonth.toLocaleString("sv-SE")+" kr"} color={BX}  icon="chart-line"/>
            <StatCard label="Vinst"     value={profMonth.toLocaleString("sv-SE")+" kr"} color={profMonth>=0?GR:R} icon="tag"/>
            <StatCard label="Affärer"   value={salesMonth.length} color={TM} icon="pen"/>
            <StatCard label="Denna vecka" value={revWeek.toLocaleString("sv-SE")+" kr"} color={BX} icon="chart-line"/>
          </div>

          {/* Intäkt & vinst — senaste 30 dagarna */}
          <Section title="Intäkt & vinst — senaste 30 dagarna"/>
          <div style={{background:WH,borderRadius:12,border:`1px solid ${BD}`,padding:"16px 8px 8px",boxShadow:SH}}>
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={dailyData} margin={{top:5,right:12,left:-16,bottom:0}}>
                <defs>
                  <linearGradient id="gradRev" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={BX} stopOpacity={0.35}/>
                    <stop offset="95%" stopColor={BX} stopOpacity={0.02}/>
                  </linearGradient>
                  <linearGradient id="gradProfit" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={GR} stopOpacity={0.35}/>
                    <stop offset="95%" stopColor={GR} stopOpacity={0.02}/>
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke={BD} vertical={false}/>
                <XAxis dataKey="date" tick={{fontSize:10,fill:MU}} axisLine={{stroke:BD}} tickLine={false} interval={4}/>
                <YAxis tick={{fontSize:10,fill:MU}} axisLine={false} tickLine={false} width={44} tickFormatter={v=>v>=1000?`${Math.round(v/1000)}k`:v}/>
                <Tooltip content={<ChartTooltip/>}/>
                <Area type="monotone" dataKey="Intäkt" stroke={BX} strokeWidth={2.5} fill="url(#gradRev)"/>
                <Area type="monotone" dataKey="Vinst" stroke={GR} strokeWidth={2.5} fill="url(#gradProfit)"/>
              </AreaChart>
            </ResponsiveContainer>
            <div style={{display:"flex",gap:16,justifyContent:"center",paddingBottom:10,paddingTop:2}}>
              <div style={{display:"flex",alignItems:"center",gap:6,fontSize:12,color:TM}}><div style={{width:10,height:10,borderRadius:3,background:BX}}/>Intäkt</div>
              <div style={{display:"flex",alignItems:"center",gap:6,fontSize:12,color:TM}}><div style={{width:10,height:10,borderRadius:3,background:GR}}/>Vinst</div>
            </div>
          </div>

          {/* Försäljning per kategori */}
          {catData.length>0&&<>
            <Section title="Försäljning per kategori — 30 dagar"/>
            <div style={{background:WH,borderRadius:12,border:`1px solid ${BD}`,padding:16,boxShadow:SH,display:"flex",alignItems:"center",gap:12}}>
              <ResponsiveContainer width="42%" height={160}>
                <PieChart>
                  <Pie data={catData} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={38} outerRadius={62} paddingAngle={2}>
                    {catData.map((entry,i)=><Cell key={entry.name} fill={PIE_COLORS[i%PIE_COLORS.length]}/>)}
                  </Pie>
                  <Tooltip formatter={(v)=>v.toLocaleString("sv-SE")+" kr"}/>
                </PieChart>
              </ResponsiveContainer>
              <div style={{flex:1,display:"flex",flexDirection:"column",gap:6,minWidth:0}}>
                {catData.map((c,i)=>(
                  <div key={c.name} style={{display:"flex",alignItems:"center",gap:7,fontSize:12}}>
                    <div style={{width:9,height:9,borderRadius:3,background:PIE_COLORS[i%PIE_COLORS.length],flexShrink:0}}/>
                    <span style={{flex:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",color:TX}}>{c.name}</span>
                    <span style={{fontWeight:700,color:TM,flexShrink:0}}>{c.value.toLocaleString("sv-SE")} kr</span>
                  </div>
                ))}
              </div>
            </div>
          </>}

          {/* Toppsäljare */}
          {topSellers.length>0&&<>
            <Section title="Toppsäljare (30 dagar)"/>
            <div style={{background:WH,borderRadius:12,border:`1px solid ${BD}`,overflow:"hidden"}}>
              {topSellers.map(([name,rev],i)=>(
                <div key={name} style={{display:"flex",alignItems:"center",gap:10,padding:"11px 14px",borderBottom:i<topSellers.length-1?`1px solid ${BD}50`:"none"}}>
                  <div style={{width:22,height:22,borderRadius:"50%",background:[BX,GR,AM,MU,MU][i]+"20",color:[BX,GR,AM,MU,MU][i],fontSize:11,fontWeight:800,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>{i+1}</div>
                  <span style={{flex:1,fontSize:13,fontWeight:600}}>{name}</span>
                  <span style={{fontSize:13,fontWeight:700,color:[BX,GR,AM,MU,MU][i]}}>{rev.toLocaleString("sv-SE")} kr</span>
                </div>
              ))}
            </div>
          </>}

          {/* Mest sålda */}
          {topItems.length>0&&<>
            <Section title="Mest sålda artiklar"/>
            <div style={{background:WH,borderRadius:12,border:`1px solid ${BD}`,overflow:"hidden"}}>
              {topItems.map(([name,qty],i)=>(
                <div key={name} style={{display:"flex",alignItems:"center",gap:10,padding:"11px 14px",borderBottom:i<topItems.length-1?`1px solid ${BD}50`:"none"}}>
                  <div style={{width:22,height:22,borderRadius:"50%",background:B+"15",color:BX,fontSize:11,fontWeight:800,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>{i+1}</div>
                  <span style={{flex:1,fontSize:13}}>{name}</span>
                  <span style={{fontSize:12,color:MU,fontWeight:600}}>{qty} st</span>
                </div>
              ))}
            </div>
          </>}

          {/* Senaste försäljningar */}
          {allSales.length>0&&<>
            <Section title="Senaste försäljningar" action="Alla" onAction={()=>push("saleslog")}/>
            <div style={{background:WH,borderRadius:12,border:`1px solid ${BD}`,overflow:"hidden"}}>
              {allSales.slice(0,6).map((s,i)=>(
                <div key={s.id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"11px 14px",borderBottom:i<Math.min(allSales.length,6)-1?`1px solid ${BD}50`:"none"}}>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontSize:13,fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{s.itemName}{s.itemSide?` — ${s.itemSide}`:""}</div>
                    <div style={{fontSize:11,color:MU}}>{s.soldBy}{s.buyer!=="Okänd"?` → ${s.buyer}`:""} · {fmt(s.soldAt)}</div>
                  </div>
                  <div style={{textAlign:"right",flexShrink:0,marginLeft:12}}>
                    <div style={{fontWeight:700,color:BX,fontSize:14}}>{s.total.toLocaleString("sv-SE")} kr</div>
                    <div style={{fontSize:11,color:s.profit>=0?GR:R}}>{s.profit>=0?"+":""}{(s.profit||0).toLocaleString("sv-SE")} kr</div>
                  </div>
                </div>
              ))}
            </div>
          </>}

          {allSales.length===0&&salesMonth.length===0&&(
            <div style={{textAlign:"center",padding:"30px 20px",color:MU,fontSize:13}}>
              <Icon name="chart-line" style={{fontSize:32,marginBottom:10,display:"block",margin:"0 auto 10px"}}/>
              Inga försäljningar ännu — börja sälja för att se statistik här.
            </div>
          )}
        </>}

      </div>
    </Page>
  );
}

// ─── Status helpers ───────────────────────────────────────────────────────────
const sc = q => q===0?R:GR;
const cc = c => c==="Ny"?GR:c?.includes("Gott")?BX:c?.includes("spricka")?AM:MU;

// ─── Login Page ───────────────────────────────────────────────────────────────
function LoginPage({ users, saveUsers, setSession, push, pop, replace, toast$, logActivity }) {
  const [u, setU] = useState(""); const [p, setP] = useState("");
  const [loading, setLoading] = useState(false);
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState("");
  const [remember, setRemember] = useState(true);

  // Elektron-appen kan komma ihåg inloggningsuppgifter säkert (krypterat av
  // operativsystemet — se electron-main.js). Fylls i automatiskt om sparat.
  useEffect(() => {
    if (window.electronAPI?.getSavedCredentials) {
      window.electronAPI.getSavedCredentials().then(creds => {
        if (creds?.username) { setU(creds.username); setP(creds.password||""); }
      }).catch(()=>{});
    }
  }, []);

  const login = async () => {
    if (!u.trim() || !p) { setError("Fyll i användarnamn och lösenord"); return; }
    setLoading(true);
    setError("");
    try {
      const r = await fetch(`${API}/login`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: u.trim(), password: p }),
      }).then(r => r.json());

      if (!r.ok) {
        setError(r.error || "Fel inloggningsuppgifter");
        setLoading(false);
        fetch("/admin/api/notify",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({type:"failed_login",username:u})}).catch(()=>{});
        return;
      }

      saveSession(r.user.id, r.token);
      setCurrentToken(r.token);
      setSession(r.user.id);
      setCurrentUsername(r.user.username);

      // Uppdatera den lokala users-listan med den färska (lösenordsfria) posten
      if (Array.isArray(users)) {
        const next = users.some(x=>x.id===r.user.id)
          ? users.map(x=>x.id===r.user.id?{...x,...r.user}:x)
          : [...users, r.user];
        saveUsers?.(next);
      }

      // Kom ihåg uppgifter i Elektron-appen (krypterat av OS, se electron-main.js)
      if (window.electronAPI?.saveCredentials) {
        if (remember) window.electronAPI.saveCredentials({ username: u.trim(), password: p }).catch(()=>{});
        else window.electronAPI.clearCredentials?.().catch(()=>{});
      }

      reportEvent("login", `${r.user.username} loggade in`);
      logActivity&&logActivity("login", `${r.user.username} loggade in`, { user: r.user.username });
      // replace (inte pop) — fungerar oavsett om inloggningen är stackens
      // första/enda sida (normalfallet nu, ingen gästvy längre) eller
      // pushad ovanpå något annat (t.ex. om sessionen gick ut mitt i).
      replace("inventory");
      toast$(`Välkommen, ${r.user.username}!`,"success");
    } catch (e) {
      setError("Kunde inte nå servern");
    }
    setLoading(false);
  };

  return (
    <Page>
      <TopBar title="Logga in" onBack={pop} />
      <div style={{maxWidth:380,margin:"48px auto",padding:"0 20px"}}>
        <div style={{background:WH,borderRadius:16,padding:32,boxShadow:SH2,border:`1px solid ${BD}`}}>
          <div style={{display:"flex",flexDirection:"column",alignItems:"center",marginBottom:26}}>
            <div style={{display:"flex",gap:4,marginBottom:14}}>
              <div style={{width:9,height:44,background:R,borderRadius:5}}/><div style={{width:9,height:44,background:BX,borderRadius:5}}/>
            </div>
            <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:26,fontWeight:800,color:TX,letterSpacing:.3}}>Lager</div>
            <div style={{fontSize:12.5,color:MU,marginTop:2}}>Logga in för att fortsätta</div>
          </div>

          <div style={{display:"flex",flexDirection:"column",gap:14}} onKeyDown={e=>{if(e.key==="Enter")login();}}>
            <Inp label="Användarnamn" value={u} onChange={e=>{setU(e.target.value);setError("");}} placeholder="Ditt användarnamn" autoFocus/>
            <div>
              <label style={{display:"block",fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:4}}>Lösenord</label>
              <div style={{position:"relative"}}>
                <input type={showPw?"text":"password"} value={p} onChange={e=>{setP(e.target.value);setError("");}} placeholder="••••••••"
                  style={{width:"100%",border:`1.5px solid ${error?R:BD}`,borderRadius:7,padding:"9px 40px 9px 12px",fontSize:14,boxSizing:"border-box"}}/>
                <button type="button" onClick={()=>setShowPw(v=>!v)} style={{position:"absolute",right:8,top:"50%",transform:"translateY(-50%)",background:"none",border:"none",color:MU,cursor:"pointer",padding:6}}>
                  <i className={`fa-solid fa-${showPw?"eye-slash":"eye"}`}/>
                </button>
              </div>
            </div>

            {error&&(
              <div style={{background:"rgba(204,27,43,.08)",border:`1px solid ${R}30`,borderRadius:7,padding:"8px 12px",fontSize:12.5,color:R,fontWeight:600,display:"flex",alignItems:"center",gap:7}}>
                <i className="fa-solid fa-triangle-exclamation"/>{error}
              </div>
            )}

            {window.electronAPI&&(
              <label style={{display:"flex",alignItems:"center",gap:8,fontSize:12.5,color:TM,cursor:"pointer"}}>
                <input type="checkbox" checked={remember} onChange={e=>setRemember(e.target.checked)} style={{width:15,height:15}}/>
                Kom ihåg mig på den här datorn
              </label>
            )}

            <Btn full onClick={login} disabled={loading} style={{marginTop:4,padding:"12px"}}>
              {loading?<><Icon name="spinner"/> Loggar in…</>:"Logga in"}
            </Btn>
          </div>
        </div>
      </div>
    </Page>
  );
}

// ─── Virtuoso grid layout — responsiv kortgrid (definieras utanför komponenten
// så den inte återskapas vid varje render) ────────────────────────────────────
const gridComponents = {
  List: forwardRef(({ style, children, ...props }, ref) => (
    <div ref={ref} {...props} style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(300px,1fr))", gap:10, ...style }}>
      {children}
    </div>
  )),
  Item: ({ children, ...props }) => (
    <div {...props} style={{ minWidth:0 }}>{children}</div>
  ),
};

// ─── Inventory Page ───────────────────────────────────────────────────────────
function InventoryPage({ items, sales, can, currentUser, isAdmin, session, setSession, push, replace, toast$, saveItems, viewMode, setViewMode, filters, applyFilters, search, setSearch, sortPref, setSortPref, cart, addToCart, settings, moveToTrash, lists, canManageItem, loaded }) {
  const [showSort, setShowSort] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const setFilters = applyFilters;
  const sortBy = sortPref.by, sortDir = sortPref.dir;
  const setSortBy = (v) => setSortPref(p=>({...p,by:v}));
  const setSortDir = (v) => setSortPref(p=>({...p,dir:v}));

  if (!loaded) return <Page><TopBar title="Lager" /><div style={{padding:60,textAlign:"center"}}><div style={{width:32,height:32,margin:"0 auto",border:`3px solid ${BD}`,borderTopColor:BX,borderRadius:"50%",animation:"spin .8s linear infinite"}}/></div></Page>;
  if (!can("canView")) return <Page><TopBar title="Lager" /><div style={{padding:40,textAlign:"center",color:R,fontWeight:600}}>Åtkomst nekad.</div></Page>;

  // Hjälpare: tolka kommaseparerade nummer ("11, 15, 23") till en lista
  const parseList = (str) => (str||"").split(",").map(s=>s.trim().toLowerCase()).filter(Boolean);
  const stockNumList = parseList(filters.stockNums);
  const artNumList = parseList(filters.artNums);

  const activeCount = [filters.cats.length,filters.conds.length,filters.sides.length,filters.make,filters.brandGroup,filters.locationType,filters.model,filters.yearMin,filters.yearMax,filters.priceMin,filters.priceMax,filters.low,filters.supplier,filters.stockNums,filters.artNums,filters.reserved,filters.noImage,filters.warehouse].filter(Boolean).length;

  let filtered = items.filter(i => {
    const q = search.toLowerCase();
    const m = !q || [i.name,i.sku,i.category,i.oem,i.compatible,i.side,i.supplier,i.location,i.make,i.model,i.regNumber,i.stockNumber,getBrandGroup(i.make),i.warehouse,...(i.alternativeNumbers||[])].some(f=>f?.toLowerCase().includes(q));
    if (!m) return false;
    // Lagernummer-filter: exakt match mot någon i listan
    if (stockNumList.length && !stockNumList.includes((i.stockNumber||"").toLowerCase())) return false;
    // Artikelnummer-filter: exakt match mot någon i listan
    if (artNumList.length && !artNumList.includes((i.oem||"").toLowerCase())) return false;
    if (filters.reserved && !(i.reservations?.length>0)) return false;
    if (filters.noImage && (i.hasImages>0 || i.images?.length>0 || i.thumb)) return false;
    if (filters.cats.length && !filters.cats.includes(i.category)) return false;
    if (filters.conds.length && !filters.conds.includes(i.condition)) return false;
    if (filters.sides.length && !filters.sides.includes(i.side)) return false;
    if (filters.make && !i.make?.toLowerCase().includes(filters.make.toLowerCase())) return false;
    if (filters.brandGroup && getBrandGroup(i.make) !== filters.brandGroup) return false;
    if (filters.locationType && i.locationType !== filters.locationType) return false;
    if (filters.warehouse && i.warehouse !== filters.warehouse) return false;
    if (filters.model && !i.model?.toLowerCase().includes(filters.model.toLowerCase())) return false;
    if (filters.yearMin && Number(i.yearFrom)<Number(filters.yearMin)) return false;
    if (filters.yearMax && Number(i.yearTo||i.yearFrom)>Number(filters.yearMax)) return false;
    if (filters.priceMin && i.price<Number(filters.priceMin)) return false;
    if (filters.priceMax && i.price>Number(filters.priceMax)) return false;
    if (filters.low && i.quantity>3) return false;
    if (filters.supplier && !i.supplier?.toLowerCase().includes(filters.supplier.toLowerCase())) return false;
    return true;
  });
  // Smartare sortering: numeriska fält jämförs som tal, tomma värden hamnar alltid sist,
  // textfält jämförs naturligt (case-insensitive, å/ä/ö-medvetet via localeCompare).
  const NUMERIC_SORT_KEYS = new Set(["price","quantity","updatedAt","costPrice","stockNumber"]);
  filtered = [...filtered].sort((a,b) => {
    let va = sortBy === "brandGroup" ? getBrandGroup(a.make) : a[sortBy];
    let vb = sortBy === "brandGroup" ? getBrandGroup(b.make) : b[sortBy];
    const aEmpty = va===undefined||va===null||va==="";
    const bEmpty = vb===undefined||vb===null||vb==="";
    if (aEmpty && bEmpty) return 0;
    if (aEmpty) return 1;   // tomma värden alltid sist, oavsett riktning
    if (bEmpty) return -1;

    let cmp;
    if (NUMERIC_SORT_KEYS.has(sortBy)) {
      cmp = Number(va) - Number(vb);
    } else {
      cmp = String(va).localeCompare(String(vb), "sv", { sensitivity:"base", numeric:true });
    }
    return sortDir==="asc" ? cmp : -cmp;
  });

  const totalVal = items.reduce((s,i)=>s+i.quantity*i.price,0);
  const lowCount = items.filter(i=>i.quantity<=3).length;

  const [confirmDel, setConfirmDel] = useState(null); // id to confirm
  const del = async id => { setConfirmDel(id); };
  const confirmDelAction = async () => {
    const item = items.find(i=>i.id===confirmDel);
    const updated = await softDeleteOneItem(confirmDel);
    if (updated) saveItems(updated);
    else await saveItems(items.filter(i=>i.id!==confirmDel));
    if (item) moveToTrash?.(item, currentUser?.username);
    toast$("Flyttad till papperskorgen","success"); setConfirmDel(null);
  };

  const exportCSV = () => {
    const hdr=["Artikelnummer","Namn","Sida","Kategori","OEM","Märke","Modell","Årsmodell","Reg.nr","Skick","Antal","Pris","Inköpspris","Leverantör","Placering"];
    const rows=filtered.map(i=>[i.sku,i.name,i.side,i.category,i.oem,i.make,i.model,`${i.yearFrom||""}-${i.yearTo||""}`,i.regNumber,i.condition,i.quantity,i.price,i.costPrice,i.supplier,i.location]);
    const csv=[hdr,...rows].map(r=>r.map(c=>`"${c??""}`).join(",")).join("\n");
    const a=document.createElement("a"); a.href=URL.createObjectURL(new Blob([csv],{type:"text/csv"})); a.download="lager_export.csv"; a.click();
    toast$("CSV exporterad","success");
  };

  const cartCount = cart.reduce((a,r)=>a+r.qty, 0);

  const [menuOpen, setMenuOpen] = useState(false);

  const right = (
    <>
      {!currentUser && <Btn small onClick={()=>push("login")}>Logga in</Btn>}
      {currentUser && <>
        <button onClick={()=>window.location.reload()} title="Ladda om" style={{background:"none",border:"none",color:MU,fontSize:17,display:"flex",alignItems:"center",padding:"2px 6px",cursor:"pointer"}}>
          <Icon name="rotate-right"/>
        </button>
        {(can("canUseCheckout")||isAdmin) && (
          <button onClick={()=>push("checkout")} style={{position:"relative",background:"none",border:"none",color:BX,fontSize:20,display:"flex",alignItems:"center",padding:"2px 6px"}}>
            <Icon name="cart-shopping"/>
            {cartCount>0 && <span style={{position:"absolute",top:-5,right:-2,background:R,color:WH,borderRadius:"50%",width:17,height:17,fontSize:9,fontWeight:800,display:"flex",alignItems:"center",justifyContent:"center"}}>{cartCount}</span>}
          </button>
        )}
        <button onClick={()=>setMenuOpen(true)} className="mobile-only" style={{background:"none",border:"none",color:TX,fontSize:20,display:"flex",alignItems:"center",padding:"2px 4px"}}>
          <Icon name="grip"/>
        </button>
      </>}
    </>
  );

  return (
    <Page>
      <TopBar title="Lager" right={right} />

      {/* Slide-up menu overlay */}
      {menuOpen && (
        <div style={{position:"fixed",inset:0,zIndex:200}} onClick={()=>setMenuOpen(false)}>
          <div style={{position:"absolute",bottom:0,left:0,right:0,background:WH,borderRadius:"20px 20px 0 0",paddingTop:"max(12px,calc(env(safe-area-inset-top) + 12px))",paddingBottom:"max(24px,env(safe-area-inset-bottom))",boxShadow:"0 -4px 30px rgba(0,0,0,.15)",maxHeight:"calc(90vh - env(safe-area-inset-top))",overflowY:"auto"}} onClick={e=>e.stopPropagation()}>
            {/* Handle */}
            <div style={{width:36,height:4,background:BD,borderRadius:2,margin:"0 auto 16px"}}/>
            {/* User info */}
            <div style={{display:"flex",alignItems:"center",gap:12,padding:"0 20px 16px",borderBottom:`1px solid ${BD}`,marginBottom:8}}>
              <div style={{width:40,height:40,borderRadius:10,background:isAdmin?R:BX,display:"flex",alignItems:"center",justifyContent:"center",color:WH,fontWeight:800,fontSize:16}}>
                {currentUser.username[0].toUpperCase()}
              </div>
              <div>
                <div style={{fontWeight:700,fontSize:15}}>{currentUser.username}</div>
                <div style={{fontSize:12,color:MU}}>{isAdmin?"Administratör":"Användare"}</div>
              </div>
            </div>
            {/* Menu items */}
            {(() => {
              let mItems = [
              {icon:"house",         label:"Lager",          route:"inventory",   show:true},
              {icon:"cart-shopping", label:"Kassa",          route:"checkout",    show:isAdmin||can("canUseCheckout")},
              {icon:"chart-line",    label:"Dashboard",      route:"dashboard",   show:isAdmin||can("canViewDashboard")},
              {icon:"chart-line",    label:"Rapporter",      route:"reports",     show:isAdmin||can("canViewReports")},
              {icon:"list",          label:"Säljlogg",       route:"saleslog",    show:isAdmin||can("canViewLog")},
              {icon:"bookmark",      label:"Reservationer",  route:"reservations",show:isAdmin||can("canViewReservations")},
              {icon:"clock-rotate-left", label:"Aktivitetslogg", route:"activitylog", show:isAdmin||can("canViewActivityLog")},
              {icon:"qrcode",        label:"Skanna",         route:"scan",        show:isAdmin||can("canScan")},
              {icon:"file-import",   label:"Importera",      route:"import",      show:isAdmin||can("canImport")},
              {icon:"layer-group",   label:"Massredigera",   route:"bulkedit",    show:isAdmin||can("canBulkEdit")},
              {icon:"qrcode",        label:"Etiketter",       route:"qrlabels",    show:isAdmin},
              {icon:"location-dot",   label:"Platser",         route:"locationview", show:(isAdmin||can("canView"))},
              {icon:"truck",         label:"Leverantörer",   route:"suppliers",   show:isAdmin||can("canManageSuppliers")},
              {icon:"address-book",  label:"Kunder",         route:"customers",   show:isAdmin||can("canManageCustomers")},
              {icon:"users",         label:"Användare",      route:"users",       show:isAdmin||can("canManageUsers")},
              {icon:"rotate",        label:"Backup",         route:"backup",      show:isAdmin||can("canBackup")},
              {icon:"trash-can",     label:"Papperskorg",    route:"trash",       show:isAdmin||can("canManageTrash")},
              {icon:"sliders",       label:"Inställningar",  route:"settings",    show:isAdmin||can("canManageSettings")},
              ].filter(m=>m.show);
              const layout = settings?.menuLayout || {};
              const hidden = new Set(layout.hidden || []);
              const order = layout.order || [];
              mItems = mItems.filter(m => m.route==="inventory" || m.route==="settings" || !hidden.has(m.route));
              if (order.length) { const idx=r=>{const p=order.indexOf(r);return p===-1?999:p;}; mItems=[...mItems].sort((a,b)=>idx(a.route)-idx(b.route)); }
              return mItems;
            })().map(m=>(
              <button key={m.route} onClick={()=>{setMenuOpen(false); if(m.route!=="inventory") push(m.route);}}
                style={{width:"100%",display:"flex",alignItems:"center",gap:14,padding:"12px 20px",background:"none",border:"none",cursor:"pointer",textAlign:"left",borderRadius:0}}>
                <div style={{width:36,height:36,borderRadius:9,background:B+"10",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                  <Icon name={m.icon} style={{fontSize:15,color:BX}}/>
                </div>
                <span style={{fontSize:14,fontWeight:500,color:TX}}>{m.label}</span>
              </button>
            ))}
            {/* Profil + Logout */}
            <div style={{borderTop:`1px solid ${BD}`,margin:"8px 0 0"}}/>
            <button onClick={()=>{setMenuOpen(false);push("profile");}} style={{width:"100%",display:"flex",alignItems:"center",gap:14,padding:"12px 20px",background:"none",border:"none",cursor:"pointer",textAlign:"left"}}>
              <div style={{width:36,height:36,borderRadius:9,background:B+"10",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                <Icon name="user-gear" style={{fontSize:15,color:BX}}/>
              </div>
              <span style={{fontSize:14,fontWeight:500,color:TX}}>Min profil</span>
            </button>
            <button onClick={()=>{setMenuOpen(false);doLogout();setSession(null);toast$("Utloggad");replace("login");}} style={{width:"100%",display:"flex",alignItems:"center",gap:14,padding:"12px 20px",background:"none",border:"none",cursor:"pointer",color:R}}>
              <div style={{width:36,height:36,borderRadius:9,background:R+"10",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                <Icon name="right-from-bracket" style={{fontSize:15,color:R}}/>
              </div>
              <span style={{fontSize:14,fontWeight:500}}>Logga ut</span>
            </button>
          </div>
        </div>
      )}

      <div style={{padding:"clamp(14px,2vw,28px)",paddingBottom:80}}>
        {!currentUser && (
          <div style={{background:NOTEBG,border:`1px solid ${AM}40`,borderRadius:8,padding:"10px 14px",marginBottom:14,display:"flex",alignItems:"center",gap:10}}>
            <span style={{fontSize:13,color:AM,fontWeight:600}}>Gästläge — Skrivskyddad</span>
            <button onClick={()=>push("login")} style={{marginLeft:"auto",background:AM,color:WH,border:"none",borderRadius:5,padding:"5px 14px",fontSize:12,fontWeight:700}}>Logga in</button>
          </div>
        )}

        {/* Search + toolbar — sök alltid på rad 1, knappar på rad 2 */}
        <div style={{display:"flex",flexDirection:"column",gap:6,marginBottom:8}}>
          {/* Rad 1 — sökfält */}
          <div style={{position:"relative"}}>
            <span style={{position:"absolute",left:10,top:"50%",transform:"translateY(-50%)",fontSize:14,color:MU,pointerEvents:"none"}}><Icon name="magnifying-glass"/></span>
            <input id="main-search-input" value={search} onChange={e=>setSearch(e.target.value)} placeholder="Sök namn, OEM, lagernr… (tryck / för att söka)"
              style={{width:"100%",padding:"10px 10px 10px 32px",border:`1.5px solid ${BD}`,borderRadius:8,fontSize:13,color:TX,background:WH,boxShadow:SH,boxSizing:"border-box"}} />
          </div>
          {/* Snabbväxlare — visa bara ett lager (ort) i taget */}
          {(lists?.warehouses||WAREHOUSES).length>1&&(
            <div style={{display:"flex",gap:6,overflowX:"auto",paddingBottom:2}}>
              <button onClick={()=>applyFilters({...filters,warehouse:""})} style={{flexShrink:0,padding:"5px 12px",borderRadius:16,border:`1.5px solid ${!filters.warehouse?BX:BD}`,background:!filters.warehouse?BX:WH,color:!filters.warehouse?WH:TM,fontSize:12,fontWeight:600,whiteSpace:"nowrap",cursor:"pointer"}}>Alla lager</button>
              {(lists?.warehouses||WAREHOUSES).map(w=>(
                <button key={w} onClick={()=>applyFilters({...filters,warehouse:filters.warehouse===w?"":w})} style={{flexShrink:0,padding:"5px 12px",borderRadius:16,border:`1.5px solid ${filters.warehouse===w?AM:BD}`,background:filters.warehouse===w?AM:WH,color:filters.warehouse===w?WH:TM,fontSize:12,fontWeight:600,whiteSpace:"nowrap",cursor:"pointer"}}><i className="fa-solid fa-industry" style={{fontSize:10,marginRight:5}}/>{w}</button>
              ))}
            </div>
          )}
          {/* Rad 2 — knappar */}
          <div style={{display:"flex",gap:6}}>
            {(can("canScan")||isAdmin)&&(
              <button onClick={()=>push("scan")} style={{flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center",padding:"9px 12px",borderRadius:8,border:`1.5px solid ${BD}`,background:WH,color:TM,boxShadow:SH}}>
                <Icon name="qrcode"/>
              </button>
            )}
            <button onClick={()=>push("filter",{filters,setFilters:applyFilters,items})}
              style={{flexShrink:0,display:"flex",alignItems:"center",gap:5,padding:"9px 12px",borderRadius:8,border:`1.5px solid ${activeCount>0?BX:BD}`,background:activeCount>0?BX:WH,color:activeCount>0?WH:TM,fontWeight:600,fontSize:13,boxShadow:SH}}>
              <Icon name="sliders"/>
              {activeCount>0&&<span style={{fontSize:11,fontWeight:700,background:"rgba(255,255,255,.25)",borderRadius:10,padding:"1px 6px"}}>{activeCount}</span>}
            </button>
            <button onClick={()=>setShowSort(s=>!s)}
              style={{flexShrink:0,display:"flex",alignItems:"center",gap:5,padding:"9px 12px",borderRadius:8,border:`1.5px solid ${sortBy!=="stockNumber"?BX:BD}`,background:sortBy!=="stockNumber"?B+"10":WH,color:sortBy!=="stockNumber"?BX:TM,fontWeight:600,fontSize:13,boxShadow:SH}}>
              {sortDir==="asc"?<Icon name="arrow-up-short-wide"/>:<Icon name="arrow-down-wide-short"/>}
            </button>
            <div style={{display:"flex",gap:5}}>
              <button onClick={()=>setViewMode("cards")} style={{padding:"8px 10px",borderRadius:8,border:`1.5px solid ${viewMode==="cards"?BX:BD}`,background:viewMode==="cards"?B+"10":WH,color:viewMode==="cards"?BX:MU,boxShadow:SH}}>
                <Icon name="table-cells-large"/>
              </button>
              <button onClick={()=>setViewMode("list")} style={{padding:"8px 10px",borderRadius:8,border:`1.5px solid ${viewMode==="list"?BX:BD}`,background:viewMode==="list"?B+"10":WH,color:viewMode==="list"?BX:MU,boxShadow:SH}}>
                <Icon name="list"/>
              </button>
            </div>
            {can("canAdd") && <button onClick={()=>push("edit",{item:null})} style={{marginLeft:"auto",flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center",padding:"9px 13px",borderRadius:8,border:"none",background:BX,color:WH,fontSize:16,boxShadow:SH}}><Icon name="plus"/></button>}
          </div>
        </div>

        {/* Aktiva filter som taggar med ✕ + Rensa allt */}
        {(activeCount>0 || search) && (
          <div style={{display:"flex",gap:6,flexWrap:"wrap",alignItems:"center",marginBottom:10}}>
            {search&&<FilterTag label={`Sök: ${search}`} onRemove={()=>setSearch("")}/>}
            {filters.stockNums&&<FilterTag label={`Lagernr: ${filters.stockNums}`} onRemove={()=>setFilters({...filters,stockNums:""})}/>}
            {filters.artNums&&<FilterTag label={`Artikelnr: ${filters.artNums}`} onRemove={()=>setFilters({...filters,artNums:""})}/>}
            {filters.low&&<FilterTag label="Lågt lager" onRemove={()=>setFilters({...filters,low:false})}/>}
            {filters.reserved&&<FilterTag label="Reserverade" onRemove={()=>setFilters({...filters,reserved:false})}/>}
            {filters.noImage&&<FilterTag label="Utan bild" onRemove={()=>setFilters({...filters,noImage:false})}/>}
            {filters.cats.map(c=><FilterTag key={c} label={c} onRemove={()=>setFilters({...filters,cats:filters.cats.filter(x=>x!==c)})}/>)}
            {filters.conds.map(c=><FilterTag key={c} label={c} onRemove={()=>setFilters({...filters,conds:filters.conds.filter(x=>x!==c)})}/>)}
            {filters.sides.map(s=><FilterTag key={s} label={s} onRemove={()=>setFilters({...filters,sides:filters.sides.filter(x=>x!==s)})}/>)}
            {filters.make&&<FilterTag label={filters.make} onRemove={()=>setFilters({...filters,make:""})}/>}
            {filters.brandGroup&&<FilterTag label={filters.brandGroup} onRemove={()=>setFilters({...filters,brandGroup:""})}/>}
            {filters.locationType&&<FilterTag label={filters.locationType} onRemove={()=>setFilters({...filters,locationType:""})}/>}
            {filters.warehouse&&<FilterTag label={filters.warehouse} onRemove={()=>setFilters({...filters,warehouse:""})}/>}
            {filters.model&&<FilterTag label={filters.model} onRemove={()=>setFilters({...filters,model:""})}/>}
            {filters.supplier&&<FilterTag label={filters.supplier} onRemove={()=>setFilters({...filters,supplier:""})}/>}
            {(filters.yearMin||filters.yearMax)&&<FilterTag label={`År ${filters.yearMin||"…"}-${filters.yearMax||"…"}`} onRemove={()=>setFilters({...filters,yearMin:"",yearMax:""})}/>}
            {(filters.priceMin||filters.priceMax)&&<FilterTag label={`Pris ${filters.priceMin||"…"}-${filters.priceMax||"…"}`} onRemove={()=>setFilters({...filters,priceMin:"",priceMax:""})}/>}
            <button onClick={()=>{ setSearch(""); setFilters({ cats:[], conds:[], sides:[], make:"", brandGroup:"", locationType:"", model:"", yearMin:"", yearMax:"", priceMin:"", priceMax:"", low:false, supplier:"", stockNums:"", artNums:"", reserved:false, noImage:false }); }}
              style={{display:"flex",alignItems:"center",gap:5,padding:"5px 11px",borderRadius:16,border:`1.5px solid ${R}40`,background:R+"08",color:R,fontSize:12,fontWeight:700,cursor:"pointer"}}>
              <i className="fa-solid fa-xmark"/> Rensa allt
            </button>
          </div>
        )}

        {/* Sort sheet */}
        {showSort && (
          <div style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,boxShadow:SH2,marginBottom:8,overflow:"hidden"}}>
            {[
              {k:"stockNumber", dir:"asc",  l:"Lagernummer stigande", sub:"", icon:"arrow-up-1-9"},
              {k:"stockNumber", dir:"desc", l:"Lagernummer fallande",  sub:"", icon:"arrow-down-9-1"},
              {k:"price",       dir:"asc",  l:"Pris stigande",         sub:"", icon:"arrow-up-1-9"},
              {k:"price",       dir:"desc", l:"Pris fallande",         sub:"", icon:"arrow-down-9-1"},
            ].map(({k,dir,l,sub,icon})=>{
              const active = sortBy===k && sortDir===dir;
              return (
                <button key={k+dir} onClick={()=>{ setSortBy(k); setSortDir(dir); setShowSort(false); }}
                  style={{width:"100%",display:"flex",alignItems:"center",gap:12,padding:"13px 14px",background:active?BX:WH,border:"none",borderBottom:`1px solid ${BD}`,color:active?WH:TX,cursor:"pointer",textAlign:"left"}}>
                  <Icon name={icon} style={{fontSize:16,flexShrink:0,color:active?WH:BX}}/>
                  <div>
                    <div style={{fontWeight:700,fontSize:13}}>{l}</div>
                    <div style={{fontSize:11,color:active?"rgba(255,255,255,.7)":MU}}>{sub}</div>
                  </div>
                  {active&&<Icon name="check" style={{marginLeft:"auto",fontSize:14}}/>}
                </button>
              );
            })}
          </div>
        )}

        <div style={{fontSize:12,color:MU,marginBottom:10,display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
          <span>Visar <strong style={{color:TX}}>{filtered.length}</strong> av {items.length} delar</span>
          {can("canExport") && <button onClick={exportCSV} style={{background:"none",border:"none",color:BX,fontSize:12,cursor:"pointer",fontWeight:600,display:"flex",alignItems:"center",gap:4,marginLeft:"auto"}}><Icon name="file-export"/> CSV</button>}
          {(isAdmin||can("canImport")) && <button onClick={()=>push("import")} style={{background:"none",border:"none",color:BX,fontSize:12,cursor:"pointer",fontWeight:600,display:"flex",alignItems:"center",gap:4,marginLeft:can("canExport")?"0":"auto"}}><Icon name="file-export"/> Importera</button>}
        </div>

        {/* Cards — virtualiserad: bara synliga kort renderas (snabbt även med 1000+ delar) */}
        {viewMode==="cards" && (() => {
          // Group items by SKU — same SKU = variants of same part
          const groups = [];
          const seen = {};
          filtered.forEach(item => {
            const key = item.sku?.trim().toLowerCase() || item.id;
            if (!seen[key]) { seen[key] = []; groups.push(seen[key]); }
            seen[key].push(item);
          });
          if (filtered.length===0) return <div style={{textAlign:"center",padding:48,color:MU}}>Inga delar hittades</div>;
          return (
            <VirtuosoGrid
              data={groups}
              style={{ height: "calc(100vh - 230px)" }}
              components={gridComponents}
              computeItemKey={(_, group) => group.length===1 ? group[0].id : group[0].sku}
              overscan={600}
              itemContent={(_, group) => {
                if (group.length === 1) {
                  const item = group[0];
                  return (
                    <ItemCard item={item} can={can} isAdmin={isAdmin} canManageItem={canManageItem}
                      onDetail={()=>push("detail",{item})}
                      onEdit={()=>push("edit",{item})}
                      onSell={()=>push("sell",{item, maxQty: Math.max(0,(item.quantity||0)-(item.reservations?.length||0))})}
                      onAddToCart={()=>{ addToCart(item); toast$(`${item.name} tillagd i korgen`,"success"); }}
                      onDelete={()=>del(item.id)}
                      onReserve={()=>push("detail",{item, openReserve:true})}
                    />
                  );
                }
                return (
                  <GroupCard group={group} can={can}
                    onOpen={()=>push("variants",{sku:group[0].sku})}
                    onAddToCart={(item)=>{ addToCart(item); toast$(`${item.name} #${item.stockNumber||""} tillagd i korgen`,"success"); }}
                  />
                );
              }}
            />
          );
        })()}

        {/* List */}
        {viewMode==="list" && (
          <div style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,boxShadow:SH,overflow:"auto"}}>
            <table style={{width:"100%",borderCollapse:"collapse",minWidth:700}}>
              <thead>
                <tr style={{borderBottom:`2px solid ${BD}`}}>
                  {[["","",44],["name","Namn"],["oem","Art.nr",90],["category","Kat.",90],["condition","Skick",120],["quantity","Ant.",55],["price","Pris",85],["location","Placering",65],["","",100]].map(([col,lab,w],i)=>(
                    <th key={i} onClick={()=>col&&(sortBy===col?setSortDir(d=>d==="asc"?"desc":"asc"):(setSortBy(col),setSortDir("asc")))}
                      style={{textAlign:"left",padding:"8px 10px",fontSize:10,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.8,cursor:col?"pointer":"default",whiteSpace:"nowrap",width:w||"auto"}}>
                      {lab}{col&&sortBy===col?(sortDir==="asc"?" ^":" ↓"):""}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.length===0 && <tr><td colSpan={9} style={{padding:40,textAlign:"center",color:MU}}>Inga delar hittades</td></tr>}
                {(() => {
                  const groups2 = [];
                  const seen2 = {};
                  filtered.forEach(item => {
                    const key = item.sku?.trim().toLowerCase() || item.id;
                    if (!seen2[key]) { seen2[key]=[]; groups2.push({key,items:seen2[key]}); }
                    seen2[key].push(item);
                  });
                  return groups2.map(({key,items:g}) => {
                    if(g.length===1) {
                      const item=g[0];
                      return <ListRow key={item.id} item={item} can={can} isAdmin={isAdmin} canManageItem={canManageItem}
                        onDetail={()=>push("detail",{item})}
                        onEdit={()=>push("edit",{item})}
                        onSell={()=>push("sell",{item})}
                        onAddToCart={()=>{ addToCart(item); toast$(`${item.name} tillagd i korgen`,"success"); }}
                        onDelete={()=>del(item.id)}/>;
                    }
                    // Group row
                    const base=g[0];
                    return <tr key={key} onClick={()=>push("variants",{sku:base.sku})} style={{cursor:"pointer",background:B+"04",borderBottom:`1px solid ${BD}`}}>
                      <td style={{padding:"6px 10px"}}><div style={{display:"flex",gap:3}}>{g.slice(0,3).map(i=>(i.thumb||i.images?.[0])?<img key={i.id} src={i.thumb||i.images[0]} style={{width:24,height:24,borderRadius:4,objectFit:"cover"}} alt=""/>:<div key={i.id} style={{width:24,height:24,borderRadius:4,background:BG,border:`1px solid ${BD}`,display:"flex",alignItems:"center",justifyContent:"center"}}><i className="fa-solid fa-wrench" style={{fontSize:10,color:MU}}/></div>)}</div></td>
                      <td style={{padding:"7px 10px"}}><div style={{fontWeight:600,fontSize:13}}>{base.name}{base.side?` — ${base.side}`:""}</div><div style={{fontSize:10,color:BX,fontWeight:700}}><i className="fa-solid fa-layer-group"/> {g.length} exemplar</div></td>
                      <td style={{padding:"7px 10px",fontSize:12,color:MU}}>{base.sku}</td>
                      <td style={{padding:"7px 10px"}}><Badge label={base.category} color={BX} small/></td>
                      <td style={{padding:"7px 10px",fontSize:11,color:MU}}>{[...new Set(g.map(i=>i.condition?.split(" - ")[0]))].join(", ")}</td>
                      <td style={{padding:"7px 10px",fontWeight:700,color:GR}}>{g.reduce((a,i)=>a+i.quantity,0)} st</td>
                      <td style={{padding:"7px 10px",fontWeight:700,color:BX,fontSize:12,whiteSpace:"nowrap"}}>
                        {(() => { const p=g.map(i=>i.price).filter(Boolean); const mn=Math.min(...p),mx=Math.max(...p); return mn===mx?`${mn.toLocaleString("sv-SE")} kr`:`${mn.toLocaleString("sv-SE")}–${mx.toLocaleString("sv-SE")}`; })()}
                      </td>
                      <td colSpan={2} style={{padding:"7px 10px",fontSize:11,color:BX,fontWeight:600}}>Välj exemplar →</td>
                    </tr>;
                  });
                })()}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {/* Inline delete confirm */}
      {confirmDel && (
        <div style={{position:"absolute",inset:0,background:"rgba(0,0,0,.45)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:50,padding:24}}>
          <div style={{background:WH,borderRadius:12,padding:24,width:"100%",maxWidth:320,boxShadow:SH2}}>
            <div style={{fontWeight:700,fontSize:16,marginBottom:8}}>Ta bort del?</div>
            <div style={{fontSize:13,color:MU,marginBottom:20}}>Detta kan inte ångras.</div>
            <div style={{display:"flex",gap:10}}>
              <Btn variant="ghost" full onClick={()=>setConfirmDel(null)}>Avbryt</Btn>
              <Btn variant="red" full onClick={confirmDelAction}>Ta bort</Btn>
            </div>
          </div>
        </div>
      )}
    </Page>
  );
}

// ─── Group Card — shown when multiple items share same SKU ────────────────────
const GroupCard = React.memo(function GroupCard({ group, can, onOpen }) {
  const best = [...group].sort((a,b) => {
    const s = i => i.condition==="Ny"?4:i.condition?.includes("Gott")?3:i.condition?.includes("spricka")?2:1;
    return s(b)-s(a);
  })[0];
  const totalQty = group.reduce((a,i)=>a+i.quantity,0);
  const prices = group.map(i=>i.price).filter(Boolean);
  const minP = Math.min(...prices); const maxP = Math.max(...prices);
  const brandGroup = getBrandGroup(best.make);
  const location = [best.locationType, best.location].filter(Boolean).join(" ");

  return (
    <div onClick={onOpen} style={{background:WH,borderRadius:12,border:`1px solid ${BD}`,boxShadow:SH,padding:12,cursor:"pointer",display:"flex",flexDirection:"column",gap:8,height:188,boxSizing:"border-box",overflow:"hidden"}}>

      {/* Topp: bild + (lagernr-badges, namn, artikelnummer) */}
      <div style={{display:"flex",gap:11,alignItems:"flex-start"}}>
        <div style={{flexShrink:0,width:62,height:62,borderRadius:9,overflow:"hidden",background:BG,border:`1px solid ${BD}`,display:"flex",alignItems:"center",justifyContent:"center"}}>
          {(() => {
            const src = best.thumb || best.images?.[0] || (best.hasImages>0 ? `/api/img/${best.id}?v=${best.updatedAt||0}` : null);
            return src ? <img src={src} alt="" loading="lazy" decoding="async" width={62} height={62} style={{width:"100%",height:"100%",objectFit:"cover"}}/> : <i className="fa-solid fa-wrench" style={{color:MU,fontSize:18}}/>;
          })()}
        </div>
        <div style={{flex:1,minWidth:0}}>
          <div style={{display:"flex",gap:4,marginBottom:3,flexWrap:"wrap"}}>
            {group.map(item=>(
              <span key={item.id} style={{background:BX,color:WH,borderRadius:5,padding:"2px 7px",fontSize:12,fontWeight:800,letterSpacing:.3}}>#{item.stockNumber||"?"}</span>
            ))}
          </div>
          <div style={{fontWeight:700,fontSize:14,lineHeight:1.25,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{best.name}{best.side?` — ${best.side}`:""}</div>
          {best.oem&&<div style={{fontSize:15,fontWeight:800,color:TX,fontFamily:"monospace",letterSpacing:.3,marginTop:2,wordBreak:"break-all",lineHeight:1.15}}>{best.oem}</div>}
        </div>
      </div>

      {/* Placering — stor och tydlig */}
      {(location||best.warehouse)&&(
        <div style={{display:"flex",alignItems:"center",gap:6,background:B+"0A",borderRadius:7,padding:"6px 10px",flexWrap:"wrap"}}>
          <i className="fa-solid fa-location-dot" style={{fontSize:14,color:BX}}/>
          {location&&<span style={{fontSize:15,fontWeight:800,color:BX}}>{location}</span>}
          {best.warehouse&&<span style={{marginLeft:"auto",background:AM+"18",color:AM,borderRadius:12,padding:"2px 9px",fontSize:11,fontWeight:700}}>{best.warehouse}</span>}
        </div>
      )}

      {/* Botten: pris + antal + exemplar-länk */}
      <div style={{display:"flex",alignItems:"flex-end",gap:8,marginTop:"auto"}}>
        <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:20,fontWeight:800,color:BX,lineHeight:1}}>
          {prices.length===0?"—":minP===maxP?`${minP.toLocaleString("sv-SE")} kr`:`${minP.toLocaleString("sv-SE")}–${maxP.toLocaleString("sv-SE")} kr`}
        </div>
        <div style={{textAlign:"right",lineHeight:1,marginLeft:"auto"}}>
          <span style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:22,fontWeight:800,color:totalQty===0?R:GR}}>{totalQty}</span>
          <span style={{fontSize:10,color:MU,marginLeft:2}}>st</span>
        </div>
        <div style={{fontSize:11,color:BX,fontWeight:700,display:"flex",alignItems:"center",gap:3,whiteSpace:"nowrap"}}>
          {group.length} ex <i className="fa-solid fa-chevron-right" style={{fontSize:10}}/>
        </div>
      </div>
    </div>
  );
});

// ─── Variants Page — choose between physical copies of same part ───────────────
function VariantsPage({ sku, items, sales, can, isAdmin, push, pop, addToCart, toast$, saveItems, currentUser, moveToTrash, canManageItem }) {
  const group = items.filter(i => i.sku?.trim().toLowerCase() === sku?.trim().toLowerCase());
  const [selected, setSelected] = useState(null);
  const [confirmDel, setConfirmDel] = useState(null);

  const del = async (id) => {
    const item = items.find(i=>i.id===id);
    const updated = await softDeleteOneItem(id);
    if (updated) saveItems(updated);
    else await saveItems(items.filter(i=>i.id!==id));
    if (item) moveToTrash?.(item, currentUser?.username);
    toast$("Flyttad till papperskorgen","success");
    setConfirmDel(null);
    if(group.length<=1) pop();
  };

  const condColor = c => c?.includes("Gott")?GR:c?.includes("Ny")?BX:c?.includes("spricka")?AM:MU;

  if (!group.length) return <Page><TopBar title="Exemplar" onBack={pop}/><div style={{padding:40,textAlign:"center",color:MU}}>Inga delar hittades.</div></Page>;

  const base = group[0];

  return (
    <Page>
      <TopBar
        title={base.name+(base.side?` — ${base.side}`:"")}
        subtitle={`${group.length} exemplar`}
        onBack={pop}
        right={(isAdmin||can("canAdd"))&&<Btn small onClick={()=>push("edit",{item:{...base,id:undefined,stockNumber:"",images:[]}})}><i className="fa-solid fa-plus"/> Nytt exemplar</Btn>}
      />
      <div style={{padding:"14px 14px 60px"}}>

        {/* Shared info — spec-rad med små versaler och tydliga värden */}
        <div style={{background:WH,border:`1px solid ${BD}`,borderRadius:10,padding:"12px 16px",marginBottom:18,display:"flex",gap:22,flexWrap:"wrap"}}>
          {[
            ["Märke", base.make&&base.model?`${base.make} ${base.model}`:base.make],
            ["Art.nr", base.oem],
            ["Kategori", base.category],
            ["Årsmodell", (base.yearFrom||base.yearTo)?`${base.yearFrom||""}${base.yearTo?"–"+base.yearTo:""}`:null],
          ].filter(([,v])=>v).map(([label,val])=>(
            <div key={label}>
              <div style={{fontSize:9.5,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.8,marginBottom:2}}>{label}</div>
              <div style={{fontSize:13,fontWeight:700,color:TX,fontFamily:label==="Art.nr"?"monospace":"inherit"}}>{val}</div>
            </div>
          ))}
        </div>

        {/* Exemplar — kort med tydlig hierarki och accentkant för valt läge */}
        <div style={{display:"flex",flexDirection:"column",gap:10}}>
          {group.map(item=>{
            const isSel = selected?.id===item.id;
            const cc = condColor(item.condition);
            return (
              <div key={item.id} onClick={()=>setSelected(isSel?null:item)}
                style={{background:WH,borderRadius:12,border:`1px solid ${isSel?BX:BD}`,borderLeft:`4px solid ${isSel?BX:BD}`,boxShadow:isSel?`0 4px 16px ${B}18`:SH,cursor:"pointer",overflow:"hidden",transition:"border-color .15s,box-shadow .15s,transform .1s"}}>

                <div style={{display:"flex",gap:14,padding:"14px 16px",alignItems:"center"}}>
                  {/* Bild */}
                  <div style={{flexShrink:0,width:72,height:72,borderRadius:10,overflow:"hidden",background:BG,border:`1px solid ${BD}`,display:"flex",alignItems:"center",justifyContent:"center",position:"relative"}}>
                    {(item.thumb||item.images?.[0])
                      ? <img src={item.thumb||item.images[0]} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}}/>
                      : <i className="fa-solid fa-image" style={{fontSize:22,color:BD}}/>
                    }
                    {(item.hasImages||item.images?.length)>1&&<div style={{position:"absolute",bottom:3,right:3,background:"rgba(0,0,0,.65)",color:WH,borderRadius:4,padding:"1px 5px",fontSize:8.5,fontWeight:700}}>{item.hasImages||item.images.length}<i className="fa-solid fa-image" style={{marginLeft:3}}/></div>}
                  </div>

                  {/* Info */}
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:6}}>
                      <span style={{background:BX,color:WH,borderRadius:6,padding:"2px 9px",fontSize:12,fontWeight:800,letterSpacing:.4,fontFamily:"monospace"}}>#{item.stockNumber||"?"}</span>
                      <span style={{background:cc+"18",color:cc,borderRadius:20,padding:"2px 10px",fontSize:10.5,fontWeight:700}}>{item.condition?.split(" - ")[1]||item.condition}</span>
                    </div>
                    <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:24,fontWeight:800,color:TX,lineHeight:1,marginBottom:8}}>{item.price.toLocaleString("sv-SE")} kr</div>
                    <div style={{display:"flex",gap:18,flexWrap:"wrap"}}>
                      {item.location&&(
                        <div>
                          <div style={{fontSize:9,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.6}}>Placering</div>
                          <div style={{fontSize:12.5,fontWeight:700,color:TX}}>{item.location}</div>
                        </div>
                      )}
                      <div>
                        <div style={{fontSize:9,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.6}}>Antal</div>
                        <div style={{fontSize:12.5,fontWeight:700,color:item.quantity===0?R:GR}}>{item.quantity} st</div>
                      </div>
                      {item.regNumber&&(
                        <div>
                          <div style={{fontSize:9,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.6}}>Reg</div>
                          <div style={{fontSize:12.5,fontWeight:700,color:TX,fontFamily:"monospace"}}>{item.regNumber}</div>
                        </div>
                      )}
                    </div>
                    {item.notes&&<div style={{fontSize:11.5,color:TM,marginTop:8,display:"flex",alignItems:"center",gap:5,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}><i className="fa-solid fa-note-sticky" style={{color:AM,flexShrink:0,fontSize:10}}/>{item.notes}</div>}
                  </div>

                  {/* Valindikator */}
                  <div style={{flexShrink:0,width:22,height:22,borderRadius:6,border:`2px solid ${isSel?BX:BD}`,background:isSel?BX:"transparent",display:"flex",alignItems:"center",justifyContent:"center",transition:"background .1s"}}>
                    {isSel&&<i className="fa-solid fa-check" style={{fontSize:11,color:WH}}/>}
                  </div>
                </div>

                {/* Åtgärdsknappar — visas när kortet är valt */}
                {isSel&&(
                  <div style={{display:"flex",gap:8,padding:"0 16px 14px"}} onClick={e=>e.stopPropagation()}>
                    <Btn variant="ghost" onClick={()=>push("detail",{item})}><i className="fa-solid fa-circle-info"/> Detaljer</Btn>
                    {(can("canSell")||isAdmin)&&item.quantity>0&&canManageItem(item)&&(
                      <Btn variant="red" onClick={()=>push("sell",{item})}><i className="fa-solid fa-tag"/> Sälj</Btn>
                    )}
                    {(can("canUseCheckout")||isAdmin)&&item.quantity>0&&canManageItem(item)&&(
                      <Btn variant="ghost" onClick={()=>{addToCart(item);toast$(`#${item.stockNumber} tillagd i korgen`,"success");setSelected(null);}}><i className="fa-solid fa-cart-shopping"/></Btn>
                    )}
                    {can("canEdit")&&canManageItem(item)&&<Btn variant="ghost" onClick={()=>push("edit",{item})}><i className="fa-solid fa-pen"/></Btn>}
                    {(can("canDelete")||isAdmin)&&canManageItem(item)&&<Btn variant="ghost" onClick={()=>setConfirmDel(item.id)} style={{color:R}}><i className="fa-solid fa-trash"/></Btn>}
                    {!canManageItem(item)&&<div style={{fontSize:11,color:AM,fontWeight:600,display:"flex",alignItems:"center",gap:5}}><Icon name="triangle-exclamation"/> Delen tillhör {item.warehouse} — du kan bara reservera den</div>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {confirmDel&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.4)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:200,padding:20}} onClick={()=>setConfirmDel(null)}>
          <div onClick={e=>e.stopPropagation()} style={{background:WH,borderRadius:14,padding:20,maxWidth:320,width:"100%"}}>
            <div style={{fontWeight:700,fontSize:15,marginBottom:8}}>Ta bort exemplar?</div>
            <div style={{fontSize:13,color:MU,marginBottom:16}}>Detta tar bara bort detta specifika exemplar — inte de andra.</div>
            <div style={{display:"flex",gap:8}}>
              <Btn full variant="ghost" onClick={()=>setConfirmDel(null)}>Avbryt</Btn>
              <Btn full variant="red" onClick={()=>del(confirmDel)}>Ta bort</Btn>
            </div>
          </div>
        </div>
      )}
    </Page>
  );
}


// ─── Item Card ────────────────────────────────────────────────────────────────
const ItemCard = React.memo(function ItemCard({ item, can, isAdmin, onDetail, onEdit, onSell, onAddToCart, onDelete, onReserve, canManageItem }) {
  const location = [item.locationType, item.location].filter(Boolean).join(" ");
  const imgSrc = item.thumb || item.images?.[0] || (item.hasImages>0 ? `/api/img/${item.id}?v=${item.updatedAt||0}` : null);
  const freeQtyCard = Math.max(0, (item.quantity||0) - (item.reservations?.length||0));
  return (
    <div onClick={onDetail} style={{background:WH,borderRadius:12,border:`1px solid ${BD}`,boxShadow:SH,padding:12,cursor:"pointer",display:"flex",flexDirection:"column",gap:8,height:188,boxSizing:"border-box",overflow:"hidden",position:"relative"}}>

      {/* Topp: bild + (lagernr, namn, artikelnummer) */}
      <div style={{display:"flex",gap:11,alignItems:"flex-start"}}>
        <div style={{flexShrink:0,width:62,height:62,borderRadius:9,overflow:"hidden",background:BG,border:`1px solid ${BD}`,display:"flex",alignItems:"center",justifyContent:"center"}}>
          {imgSrc?<img src={imgSrc} alt="" loading="lazy" decoding="async" width={62} height={62} style={{width:"100%",height:"100%",objectFit:"cover"}}/>:<Icon name="wrench" style={{color:MU,fontSize:18}}/>}
        </div>
        <div style={{flex:1,minWidth:0}}>
          <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:3,flexWrap:"wrap"}}>
            {item.stockNumber&&<span style={{background:BX,color:WH,borderRadius:5,padding:"2px 8px",fontSize:13,fontWeight:800,letterSpacing:.3}}>#{item.stockNumber}</span>}
            {item.reservations?.length>0&&<span style={{background:AM,color:WH,borderRadius:5,padding:"2px 7px",fontSize:10,fontWeight:800,display:"flex",alignItems:"center",gap:3}}><i className="fa-solid fa-bookmark" style={{fontSize:9}}/>{item.reservations.length} res</span>}
          </div>
          <div style={{fontWeight:700,fontSize:14,lineHeight:1.25,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{item.name}{item.side?` — ${item.side}`:""}</div>
          {item.oem&&<div style={{fontSize:15,fontWeight:800,color:TX,fontFamily:"monospace",letterSpacing:.3,marginTop:2,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",lineHeight:1.15}}>{item.oem}</div>}
        </div>
      </div>

      {/* Placering — stor och tydlig */}
      {(location||item.warehouse)&&(
        <div style={{display:"flex",alignItems:"center",gap:6,background:B+"0A",borderRadius:7,padding:"6px 10px",flexWrap:"wrap"}}>
          <i className="fa-solid fa-location-dot" style={{fontSize:14,color:BX}}/>
          {location&&<span style={{fontSize:15,fontWeight:800,color:BX}}>{location}</span>}
          {item.warehouse&&<span style={{marginLeft:"auto",background:AM+"18",color:AM,borderRadius:12,padding:"2px 9px",fontSize:11,fontWeight:700}}>{item.warehouse}</span>}
        </div>
      )}

      {/* Notering — om den finns (en rad) */}
      {item.notes&&(
        <div style={{background:NOTEBG,border:`1px solid ${AM}35`,borderRadius:7,padding:"5px 9px",fontSize:11.5,color:TM,lineHeight:1.4,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
          <i className="fa-solid fa-note-sticky" style={{color:AM,marginRight:5}}/>{item.notes}
        </div>
      )}

      {/* Botten: pris + antal + knappar */}
      <div style={{display:"flex",alignItems:"flex-end",gap:8,marginTop:"auto"}} onClick={e=>e.stopPropagation()}>
        <div>
          <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:20,fontWeight:800,color:BX,lineHeight:1}}>{(item.price||0).toLocaleString("sv-SE")} kr</div>
        </div>
        <div style={{textAlign:"right",lineHeight:1,marginLeft:"auto"}}>
          <span style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:22,fontWeight:800,color:item.quantity===0?R:GR}}>{item.quantity}</span>
          <span style={{fontSize:10,color:MU,marginLeft:2}}>st</span>
        </div>
        <div style={{display:"flex",gap:4}}>
          {(can("canUseCheckout")||isAdmin)&&freeQtyCard>0&&canManageItem?.(item)&&<Btn variant="blue" small onClick={onAddToCart}><Icon name="cart-shopping"/></Btn>}
          {(can("canSell")||isAdmin)&&freeQtyCard>0&&canManageItem?.(item)&&<Btn variant="ghost" small onClick={onSell}><Icon name="tag"/></Btn>}
          {onReserve&&(can("canAddReservations")||isAdmin)&&freeQtyCard>0&&<Btn variant="ghost" small onClick={onReserve} style={{color:AM}}><Icon name="bookmark"/></Btn>}
          {can("canEdit")&&canManageItem?.(item)&&<Btn variant="ghost" small onClick={onEdit}><Icon name="pen"/></Btn>}
        </div>
      </div>
    </div>
  );
});

// ─── List Row ─────────────────────────────────────────────────────────────────
function ListRow({ item, can, isAdmin, onDetail, onEdit, onSell, onAddToCart, onDelete, canManageItem }) {
  const [bg, setBg] = useState("transparent");
  return (
    <tr style={{borderBottom:`1px solid ${BD}50`,cursor:"pointer",background:bg}} onMouseEnter={()=>setBg(BG)} onMouseLeave={()=>setBg("transparent")} onClick={onDetail}>
      <td style={{padding:"7px 10px"}}><div style={{width:36,height:36,borderRadius:6,overflow:"hidden",background:BG,border:`1px solid ${BD}`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:16}}>{(item.thumb||item.images?.[0])?<img src={item.thumb||item.images[0]} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}}/>:<Icon name="wrench" style={{color:MU}}/>}</div></td>
      <td style={{padding:"7px 10px"}}><div style={{fontWeight:600,fontSize:13}}>{item.stockNumber&&<span style={{background:BX,color:WH,borderRadius:4,padding:"1px 6px",fontSize:10,fontWeight:800,marginRight:5}}>#{item.stockNumber}</span>}{item.name}{item.side&&<span style={{color:MU,fontWeight:400}}> — {item.side}</span>}</div>{item.oem&&<div style={{fontSize:11,color:MU}}>Art.nr: {item.oem}</div>}</td>
      <td style={{padding:"7px 10px",fontSize:11,color:MU}}>{item.sku}</td>
      <td style={{padding:"7px 10px"}}><Badge label={item.category} color={BX} small /></td>
      <td style={{padding:"7px 10px"}}><Badge label={item.condition} color={cc(item.condition)} small /></td>
      <td style={{padding:"7px 10px"}}><span style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:20,fontWeight:800,color:sc(item.quantity)}}>{item.quantity}</span></td>
      <td style={{padding:"7px 10px",fontWeight:600,fontSize:13}}>{item.price.toLocaleString("sv-SE")} kr</td>
      <td style={{padding:"7px 10px",fontSize:11,color:MU}}>{item.location}</td>
      <td style={{padding:"7px 10px"}} onClick={e=>e.stopPropagation()}>
        <div style={{display:"flex",gap:4}}>
          {(can("canUseCheckout")||isAdmin)&&item.quantity>0&&canManageItem?.(item)&&<Btn variant="blue" small onClick={onAddToCart}><Icon name="cart-shopping"/></Btn>}
          {(can("canSell")||isAdmin)&&item.quantity>0&&canManageItem?.(item)&&<Btn variant="ghost" small onClick={onSell}><Icon name="tag"/></Btn>}
          {can("canEdit")&&canManageItem?.(item)&&<Btn variant="ghost" small onClick={onEdit}><Icon name="pen"/></Btn>}
          {can("canDelete")&&canManageItem?.(item)&&<Btn variant="ghost" small onClick={onDelete} style={{color:R}}><Icon name="trash"/></Btn>}
        </div>
      </td>
    </tr>
  );
}

// ─── Detail Page ──────────────────────────────────────────────────────────────
// ─── Reservations Page — alla reservationer, grupperade per regnummer ─────────
function ReservationsPage({ items, saveItems, can, isAdmin, currentUser, push, pop, toast$, addToCart, setCart, cart }) {
  const [confirmUnreserve, setConfirmUnreserve] = useState(null);
  const [confirmRemoveAll, setConfirmRemoveAll] = useState(null); // {reg, list}
  const [expanded, setExpanded] = useState(new Set());
  const toggleExpand = reg => setExpanded(s => { const n=new Set(s); n.has(reg)?n.delete(reg):n.add(reg); return n; });
  const [search, setSearch] = useState("");
  const [showSort, setShowSort] = useState(false);
  const [sortBy, setSortBy] = useState("reg"); // reg | customer | recent | count | value
  const [sortDir, setSortDir] = useState("asc");
  const [quickFilter, setQuickFilter] = useState("all"); // all | recent | many
  // Ny reservation (flera delar → ett regnummer)
  const [showNew, setShowNew] = useState(false);
  const [newForm, setNewForm] = useState({ regNumber:"", customer:"", note:"" });
  const [pickSearch, setPickSearch] = useState("");
  const [picked, setPicked] = useState(new Set());
  const [pickSort, setPickSort] = useState("stockNumber"); // stockNumber | name | price | category
  const [pickSortDir, setPickSortDir] = useState("asc");
  const [pickShowSort, setPickShowSort] = useState(false);
  const [pickShowFilter, setPickShowFilter] = useState(false);
  const [pickFilters, setPickFilters] = useState({ cats:[], conds:[], sides:[], make:"", model:"", supplier:"", locationType:"", priceMin:"", priceMax:"" });
  const [scanError, setScanError] = useState(null);
  const [scanning, setScanning] = useState(false);
  const scanFileRef = useRef(null);
  const scanVideoRef = useRef(null);
  const scanReaderRef = useRef(null);
  const isMobile = useIsMobile();
  const canAdd = isAdmin || can("canAddReservations");
  useEffect(() => () => { if (scanReaderRef.current) { try { scanReaderRef.current.reset(); } catch {} } }, []);

  if (!isAdmin && !can("canViewReservations")) return <Page><TopBar title="Reservationer" onBack={pop}/><div style={{padding:40,textAlign:"center",color:MU}}><i className="fa-solid fa-lock" style={{fontSize:32,marginBottom:12,display:"block"}}/>Du saknar behörighet.</div></Page>;

  const togglePick = id => setPicked(s => { const n=new Set(s); n.has(id)?n.delete(id):n.add(id); return n; });

  // ── QR-skanning: live-video (fungerar i Electron/HTTPS) + foto som reserv ──
  const loadZXing = () => new Promise((resolve, reject) => {
    if (window.ZXing) { resolve(window.ZXing); return; }
    const s = document.createElement("script");
    s.src = "https://unpkg.com/@zxing/library@0.19.1/umd/index.min.js";
    s.onload = () => resolve(window.ZXing); s.onerror = reject;
    document.head.appendChild(s);
  });
  const stopScan = () => {
    if (scanReaderRef.current) { try { scanReaderRef.current.reset(); } catch {} scanReaderRef.current = null; }
    setScanning(false);
  };
  const startScan = async () => {
    setScanError(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setScanError("Live-kamera stöds inte här — använd 'Ta foto' istället.");
      return;
    }
    try {
      const ZXing = await loadZXing();
      const hints = new Map(); hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
      const reader = new ZXing.BrowserMultiFormatReader(hints);
      scanReaderRef.current = reader;
      setScanning(true);
      // Välj bakre kameran om möjligt
      let deviceId = null;
      try {
        const devices = await ZXing.BrowserMultiFormatReader.listVideoInputDevices();
        const back = devices.find(d => /back|rear|environment|bak/i.test(d.label));
        deviceId = (back || devices[devices.length-1])?.deviceId || null;
      } catch {}
      await reader.decodeFromVideoDevice(deviceId, scanVideoRef.current, (result) => {
        if (result) { handleScan(result.getText()); }
      });
    } catch (err) {
      let msg = "Kunde inte starta kameran.";
      if (err?.name === "NotAllowedError") msg = "Kameraåtkomst nekades.";
      else if (err?.name === "NotFoundError") msg = "Ingen kamera hittades.";
      else if (err?.name === "NotReadableError") msg = "Kameran används av en annan app.";
      setScanError(msg); setScanning(false);
    }
  };
  const decodePhoto = async (file) => {
    if (!file) return;
    setScanError(null);
    try {
      const ZXing = await loadZXing();
      const url = URL.createObjectURL(file);
      const reader = new ZXing.BrowserMultiFormatReader();
      try {
        const result = await reader.decodeFromImageUrl(url);
        handleScan(result.getText());
      } catch (e) {
        toast$("Ingen QR-kod hittades i bilden — försök igen","error");
      } finally {
        URL.revokeObjectURL(url); try { reader.reset(); } catch {}
      }
    } catch (e) { setScanError("Kunde inte läsa QR-koden."); }
  };
  const handleScan = (code) => {
    const c = (code||"").trim();
    const match = items.find(i => i.oem===c || i.stockNumber===c || i.sku===c || i.id===c || i.alternativeNumbers?.includes(c));
    if (!match) { toast$(`Ingen del matchade: ${c}`,"error"); return; }
    const free = (match.quantity||0) - ((match.reservations&&match.reservations.length)||0);
    if (free <= 0) { toast$(`${match.name} har inga lediga exemplar`,"error"); return; }
    if (picked.has(match.id)) { return; } // redan vald — ignorera tyst (live scannar ofta samma)
    setPicked(s => new Set(s).add(match.id));
    toast$(`La till: ${match.name}${match.stockNumber?` (#${match.stockNumber})`:""}`,"success");
  };

  // Delar som går att reservera (har minst ett ledigt exemplar)
  const pf = pickFilters;
  const pfActive = pf.cats.length+pf.conds.length+pf.sides.length + (pf.make?1:0)+(pf.model?1:0)+(pf.supplier?1:0)+(pf.locationType?1:0)+(pf.priceMin!==""?1:0)+(pf.priceMax!==""?1:0);
  let pickable = items.filter(i => {
    const free = (i.quantity||0) - ((i.reservations&&i.reservations.length)||0);
    if (free <= 0) return false;
    if (pf.cats.length && !pf.cats.includes(i.category)) return false;
    if (pf.conds.length && !pf.conds.includes(i.condition)) return false;
    if (pf.sides.length && !pf.sides.includes(i.side)) return false;
    if (pf.make && i.make!==pf.make) return false;
    if (pf.model && i.model!==pf.model) return false;
    if (pf.supplier && i.supplier!==pf.supplier) return false;
    if (pf.locationType && i.locationType!==pf.locationType) return false;
    if (pf.priceMin!=="" && (i.price||0)<Number(pf.priceMin)) return false;
    if (pf.priceMax!=="" && (i.price||0)>Number(pf.priceMax)) return false;
    if (!pickSearch.trim()) return true;
    const q = pickSearch.trim().toLowerCase();
    return [i.name,i.sku,i.oem,i.stockNumber,i.category,i.side,i.location,i.regNumber,i.make,i.model,...(i.alternativeNumbers||[])].some(f=>f?.toLowerCase().includes(q));
  });
  // Sortering av valbara delar
  const PICK_NUMERIC = new Set(["price","stockNumber","quantity"]);
  pickable = [...pickable].sort((a,b) => {
    let va = a[pickSort], vb = b[pickSort];
    const aE = va===undefined||va===null||va==="", bE = vb===undefined||vb===null||vb==="";
    if (aE && bE) return 0; if (aE) return 1; if (bE) return -1;
    let cmp = PICK_NUMERIC.has(pickSort) ? Number(va)-Number(vb) : String(va).localeCompare(String(vb),"sv",{sensitivity:"base",numeric:true});
    return pickSortDir==="asc" ? cmp : -cmp;
  });
  // Alternativ för filterväljare (bland delar med lediga exemplar)
  const freeItems = items.filter(i=>((i.quantity||0)-((i.reservations&&i.reservations.length)||0))>0);
  const pickCats = [...new Set(freeItems.map(i=>i.category).filter(Boolean))].sort();
  const pickConds = [...new Set(freeItems.map(i=>i.condition).filter(Boolean))].sort();
  const pickSides = [...new Set(freeItems.map(i=>i.side).filter(Boolean))].sort();
  const pickMakes = [...new Set(freeItems.map(i=>i.make).filter(Boolean))].sort();
  const pickModels = [...new Set(freeItems.map(i=>i.model).filter(Boolean))].sort();
  const pickSuppliers = [...new Set(freeItems.map(i=>i.supplier).filter(Boolean))].sort();
  const pickLocTypes = [...new Set(freeItems.map(i=>i.locationType).filter(Boolean))].sort();
  const togglePF = (key,val) => setPickFilters(p=>({...p,[key]:p[key].includes(val)?p[key].filter(x=>x!==val):[...p[key],val]}));
  const clearPF = () => setPickFilters({ cats:[], conds:[], sides:[], make:"", model:"", supplier:"", locationType:"", priceMin:"", priceMax:"" });

  const saveMultiReservation = async () => {
    if (!newForm.regNumber.trim() && !newForm.customer.trim()) { toast$("Ange antingen registreringsnummer eller kund (minst ett)","error"); return; }
    if (picked.size===0) { toast$("Välj minst en del","error"); return; }
    const reg = newForm.regNumber.trim().toUpperCase();
    const cust = newForm.customer.trim();
    const note = newForm.note.trim();
    const by = currentUser?.username || "Okänd";
    // Lägg till en reservation på varje vald del
    let working = items;
    for (const id of picked) {
      const it = working.find(i=>i.id===id);
      if (!it) continue;
      const newRes = { id: genId("res"), regNumber:reg, customer:cust, note, by, ts:Date.now() };
      const updated = { ...it, reservations:[...(it.reservations||[]), newRes], updatedAt:Date.now() };
      const res = await saveOneItem(updated);
      if (res) working = res;
      else working = working.map(i=>i.id===id?updated:i);
    }
    await saveItems(working);
    toast$(`${picked.size} delar reserverade till ${reg}`,"success");

    // Mejla utvalda personer för varje lager (utöver eget) som fick delar reserverade
    for (const id of picked) {
      const it = working.find(i=>i.id===id);
      if (it?.warehouse && currentUser?.homeWarehouse && it.warehouse !== currentUser.homeWarehouse) {
        fetch("/admin/api/notify-warehouse-reservation", {
          method:"POST", headers: authHeaders({"Content-Type":"application/json"}),
          body: JSON.stringify({
            warehouse: it.warehouse, itemName: it.name, stockNumber: it.stockNumber,
            oem: it.oem, location: [it.locationType,it.location].filter(Boolean).join(" — "),
            customer: cust, regNumber: reg, reservedBy: currentUser?.username,
          }),
        }).catch(()=>{});
      }
    }

    stopScan();
    setShowNew(false); setPicked(new Set()); setNewForm({ regNumber:"", customer:"", note:"" }); setPickSearch("");
  };

  const removeReservation = async (item, resId) => {
    const updated = { ...item, reservations: (item.reservations||[]).filter(r=>r.id!==resId), updatedAt:Date.now() };
    const res = await saveOneItem(updated);
    if (res) saveItems(res); else await saveItems(items.map(i=>i.id===item.id?updated:i));
    setConfirmUnreserve(null);
    toast$("Reservation borttagen","success");
  };

  // Sälj direkt från reservationssidan — tar bort reservationen och öppnar säljflödet
  const sellFromRes = async (r) => {
    const item = r.item;
    const remaining = (item.reservations||[]).filter(x=>x.id!==r.id);
    const updated = { ...item, reservations: remaining, updatedAt:Date.now() };
    const res = await saveOneItem(updated);
    if (res) saveItems(res); else await saveItems(items.map(i=>i.id===item.id?updated:i));
    push("sell", { item:updated, maxQty:1, presetBuyer: r.customer || r.regNumber });
  };

  // Lägg alla en bils reserverade delar i kassan på en gång.
  // Reservationerna tas INTE bort nu — de rensas först när köpet slutförs i kassan.
  const sellAllFromRes = async (reg, list) => {
    // Bygg raderna och sätt hela kassan på en gång (synkront) så att
    // kassasidan har innehållet direkt när vi navigerar dit.
    const meUser = currentUser?.username || "Okänd";
    const newRows = list.map(r => ({
      item: r.item, qty: 1, unitPrice: r.item.price,
      priceMode: "incl", discountMode: "pct", discountPct: 0, discountKr: 0,
      regNumber: r.regNumber, customer: r.customer, reservationId: r.id,
      key: r.item.id + "-" + r.id,
    }));
    setCart?.(prev => {
      const existingIds = new Set((prev||[]).map(x=>x.item.id));
      const toAdd = newRows.filter(x=>!existingIds.has(x.item.id));
      return [...(prev||[]), ...toAdd];
    });
    // Försök låsa delarna (bästa-försök, blockerar inte navigeringen)
    list.forEach(r => { try { lockAcquire(r.item.id, meUser, "cart"); } catch {} });
    toast$(`${list.length} delar för ${reg} lades i kassan`,"success");
    push("checkout");
  };

  // Ta bort en hel bils reservationer på en gång
  const removeWholeReservation = async (reg, list) => {
    let working = items;
    for (const r of list) {
      const it = working.find(i=>i.id===r.item.id);
      if (!it) continue;
      const remaining = (it.reservations||[]).filter(x=>x.id!==r.id);
      const updated = { ...it, reservations: remaining, updatedAt:Date.now() };
      const res = await saveOneItem(updated);
      working = res || working.map(i=>i.id===it.id?updated:i);
    }
    await saveItems(working);
    setConfirmRemoveAll(null);
    toast$(`Reservationen för ${reg} borttagen`,"success");
  };

  // Bygg en lista: en post per reservation, med tillhörande artikel
  const allRes = [];
  for (const it of items) {
    for (const r of (it.reservations||[])) {
      allRes.push({ ...r, item: it });
    }
  }
  // Gruppera per regnummer
  const groups = {};
  for (const r of allRes) {
    const key = r.regNumber || "—";
    if (!groups[key]) groups[key] = [];
    groups[key].push(r);
  }
  // Filtrera på sök (regnummer eller kund)
  let groupKeys = Object.keys(groups);
  if (search.trim()) {
    const q = search.trim().toLowerCase();
    groupKeys = groupKeys.filter(k =>
      k.toLowerCase().includes(q) || groups[k].some(r => (r.customer||"").toLowerCase().includes(q) || (r.item?.name||"").toLowerCase().includes(q) || (r.item?.oem||"").toLowerCase().includes(q) || (r.item?.stockNumber||"").toLowerCase().includes(q))
    );
  }
  // Snabbfilter
  const now = Date.now();
  if (quickFilter==="recent") {
    groupKeys = groupKeys.filter(k => groups[k].some(r => (now - (r.ts||0)) < 7*864e5)); // senaste 7 dagar
  } else if (quickFilter==="many") {
    groupKeys = groupKeys.filter(k => groups[k].length >= 2); // flera delar
  }
  // Sortering
  const groupVal = (k) => {
    const list = groups[k];
    switch (sortBy) {
      case "customer": return (list.find(r=>r.customer)?.customer || "").toLowerCase();
      case "recent": return Math.max(...list.map(r=>r.ts||0));
      case "count": return list.length;
      case "value": return list.reduce((a,r)=>a+(r.item?.price||0),0);
      default: return k.toLowerCase(); // reg
    }
  };
  const NUMERIC = new Set(["recent","count","value"]);
  groupKeys = groupKeys.sort((a,b) => {
    const va = groupVal(a), vb = groupVal(b);
    let cmp;
    if (NUMERIC.has(sortBy)) cmp = Number(va) - Number(vb);
    else cmp = String(va).localeCompare(String(vb), "sv", { sensitivity:"base", numeric:true });
    return sortDir==="asc" ? cmp : -cmp;
  });

  return (
    <Page>
      <TopBar title="Reservationer" onBack={pop} subtitle={`${allRes.length} reservationer · ${groupKeys.length} bilar`}
        right={canAdd?<Btn small onClick={()=>setShowNew(true)}><Icon name="plus"/> Ny</Btn>:null} />
      <div style={{padding:"14px 14px 40px"}}>
        <div style={{marginBottom:10}}>
          <div style={{display:"flex",gap:8,alignItems:"center"}}>
            <div style={{position:"relative",flex:1}}>
              <Icon name="magnifying-glass" style={{position:"absolute",left:12,top:"50%",transform:"translateY(-50%)",color:MU,fontSize:13}}/>
              <input type="text" value={search} onChange={e=>setSearch(e.target.value)} placeholder="Sök regnr, kund, del…"
                style={{width:"100%",border:`1.5px solid ${BD}`,borderRadius:8,padding:"10px 12px 10px 34px",fontSize:14,boxSizing:"border-box"}}/>
            </div>
            <button onClick={()=>setShowSort(v=>!v)} style={{flexShrink:0,display:"flex",alignItems:"center",gap:6,padding:"10px 14px",borderRadius:8,border:`1.5px solid ${showSort?BX:BD}`,background:showSort?B+"08":WH,color:BX,fontWeight:600,fontSize:13,cursor:"pointer"}}>
              <Icon name="arrow-up-wide-short"/> Sortera
            </button>
          </div>
        </div>

        {/* Sorteringspanel */}
        {showSort&&(
          <div style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,boxShadow:SH2,marginBottom:10,overflow:"hidden"}}>
            {[
              {k:"reg",dir:"asc",l:"Regnummer A–Ö",icon:"arrow-down-a-z"},
              {k:"reg",dir:"desc",l:"Regnummer Ö–A",icon:"arrow-up-a-z"},
              {k:"customer",dir:"asc",l:"Kund A–Ö",icon:"user"},
              {k:"recent",dir:"desc",l:"Senast reserverad",icon:"clock"},
              {k:"count",dir:"desc",l:"Flest delar först",icon:"layer-group"},
              {k:"value",dir:"desc",l:"Högst värde först",icon:"tag"},
            ].map(o=>{
              const active = sortBy===o.k && sortDir===o.dir;
              return (
                <button key={o.k+o.dir} onClick={()=>{setSortBy(o.k);setSortDir(o.dir);setShowSort(false);}}
                  style={{width:"100%",display:"flex",alignItems:"center",gap:10,padding:"11px 14px",background:active?B+"08":"transparent",border:"none",borderBottom:`1px solid ${BD}40`,cursor:"pointer",textAlign:"left"}}>
                  <i className={`fa-solid fa-${o.icon}`} style={{color:active?BX:MU,fontSize:13,width:16}}/>
                  <span style={{fontSize:13,fontWeight:active?700:500,color:active?BX:TX,flex:1}}>{o.l}</span>
                  {active&&<Icon name="check" style={{color:BX,fontSize:12}}/>}
                </button>
              );
            })}
          </div>
        )}

        {/* Snabbfilter */}
        <div style={{display:"flex",gap:6,marginBottom:14,flexWrap:"wrap"}}>
          {[
            {k:"all",l:"Alla"},
            {k:"recent",l:"Senaste 7 dagar"},
            {k:"many",l:"Flera delar"},
          ].map(qf=>(
            <button key={qf.k} onClick={()=>setQuickFilter(qf.k)}
              style={{padding:"6px 13px",borderRadius:16,border:`1.5px solid ${quickFilter===qf.k?BX:BD}`,background:quickFilter===qf.k?BX:WH,color:quickFilter===qf.k?WH:TM,fontSize:12,fontWeight:600,cursor:"pointer"}}>
              {qf.l}
            </button>
          ))}
        </div>

        {allRes.length===0?(
          <div style={{textAlign:"center",padding:50,color:MU}}>
            <Icon name="bookmark" style={{fontSize:42,display:"block",margin:"0 auto 14px",color:BD}}/>
            <div style={{fontWeight:700,fontSize:15,marginBottom:6}}>Inga reservationer än</div>
            <div style={{fontSize:13}}>Reservera delar från en dels detaljsida eller direkt på korten.</div>
          </div>
        ):groupKeys.length===0?(
          <div style={{textAlign:"center",padding:40,color:MU}}>Inga träffar på "{search}"</div>
        ):(
          <div style={{display:"flex",flexDirection:"column",gap:14}}>
            {groupKeys.map(reg=>{
              const list = groups[reg];
              const customer = list.find(r=>r.customer)?.customer;
              const total = list.reduce((a,r)=>a+(r.item?.price||0),0);
              const canSell = isAdmin || can("canSell");
              const canEditRes = isAdmin || can("canEditReservations");
              const isOpen = expanded.has(reg);
              return (
                <div key={reg} style={{background:WH,borderRadius:12,border:`1.5px solid ${AM}40`,overflow:"hidden"}}>
                  {/* Bil-header (klickbar dropdown) */}
                  <div onClick={()=>toggleExpand(reg)} style={{background:AM+"1A",padding:"10px 14px",display:"flex",alignItems:"center",gap:10,cursor:"pointer",borderBottom:isOpen?`1px solid ${AM}25`:"none"}}>
                    <Icon name={isOpen?"chevron-down":"chevron-right"} style={{color:AM,fontSize:13,flexShrink:0}}/>
                    <span style={{background:AM,color:WH,borderRadius:6,padding:"3px 11px",fontSize:16,fontWeight:800,letterSpacing:1,fontFamily:"monospace"}}>{reg}</span>
                    {customer&&<span style={{fontSize:13,fontWeight:700,color:TX,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{customer}</span>}
                    <div style={{marginLeft:"auto",textAlign:"right",flexShrink:0}}>
                      <div style={{fontSize:16,fontWeight:800,color:BX,fontFamily:"'Barlow Condensed',sans-serif",lineHeight:1}}>{total.toLocaleString("sv-SE")} kr</div>
                      <div style={{fontSize:10,color:AM,fontWeight:700}}>{list.length} {list.length===1?"del":"delar"}</div>
                    </div>
                  </div>

                  {isOpen&&(<>
                    {/* Åtgärdsknappar för hela bilen — kompakta */}
                    {(canSell||canEditRes)&&(
                      <div style={{display:"flex",gap:8,padding:"10px 14px 4px"}}>
                        {canSell&&<button onClick={()=>sellAllFromRes(reg, list)} style={{flex:1,display:"flex",alignItems:"center",justifyContent:"center",gap:6,background:R,color:WH,border:"none",borderRadius:7,padding:"7px",fontSize:12,fontWeight:700,cursor:"pointer"}}><Icon name="cart-shopping"/> Sälj alla i kassan</button>}
                        {canEditRes&&<button onClick={()=>setConfirmRemoveAll({reg, list})} title="Ta bort hela reservationen" style={{display:"flex",alignItems:"center",justifyContent:"center",gap:6,background:WH,color:R,border:`1.5px solid ${R}40`,borderRadius:7,padding:"7px 12px",fontSize:12,fontWeight:700,cursor:"pointer"}}><Icon name="trash"/>{!isMobile&&" Ta bort alla"}</button>}
                      </div>
                    )}
                    {/* Kompakta rader */}
                    <div style={{padding:"4px 0 4px"}}>
                      {list.map(r=>(
                        <div key={r.id} style={{display:"flex",alignItems:"center",gap:8,padding:"9px 14px",borderBottom:`1px solid ${BD}30`}}>
                          <div onClick={()=>push("detail",{item:r.item})} style={{flex:1,minWidth:0,cursor:"pointer"}}>
                            <div style={{display:"flex",alignItems:"center",gap:6}}>
                              {r.item.stockNumber&&<span style={{background:BX,color:WH,borderRadius:4,padding:"1px 6px",fontSize:10,fontWeight:800,flexShrink:0}}>#{r.item.stockNumber}</span>}
                              <span style={{fontWeight:600,fontSize:13,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{r.item.name}{r.item.side?` — ${r.item.side}`:""}</span>
                            </div>
                            <div style={{fontSize:10.5,color:MU,marginTop:2,display:"flex",gap:8,flexWrap:"wrap"}}>
                              {r.item.oem&&<span style={{fontFamily:"monospace"}}>{r.item.oem}</span>}
                              {r.item.category&&<span>{r.item.category}</span>}
                              {(r.item.locationType||r.item.location)&&<span><i className="fa-solid fa-location-dot" style={{fontSize:9,marginRight:2}}/>{[r.item.locationType,r.item.location].filter(Boolean).join(" ")}</span>}
                            </div>
                          </div>
                          <span style={{fontWeight:800,fontSize:14,color:BX,flexShrink:0,fontFamily:"'Barlow Condensed',sans-serif"}}>{(r.item.price||0).toLocaleString("sv-SE")} kr</span>
                          {canSell&&<button onClick={()=>sellFromRes(r)} title="Sälj" style={{flexShrink:0,display:"flex",alignItems:"center",gap:4,background:R,color:WH,border:"none",borderRadius:6,padding:"6px 10px",fontSize:12,fontWeight:700,cursor:"pointer"}}><Icon name="tag"/>{!isMobile&&" Sälj"}</button>}
                          {canEditRes&&<button onClick={()=>setConfirmUnreserve({item:r.item, res:r})} title="Ta bort reservation" style={{flexShrink:0,background:"none",border:"none",color:R,cursor:"pointer",padding:"6px 8px",fontSize:14}}><Icon name="xmark"/></button>}
                        </div>
                      ))}
                    </div>
                  </>)}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {confirmUnreserve&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.4)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:200,padding:20}} onClick={()=>setConfirmUnreserve(null)}>
          <div onClick={e=>e.stopPropagation()} style={{background:WH,borderRadius:14,padding:20,maxWidth:340,width:"100%"}}>
            <div style={{fontWeight:700,fontSize:15,marginBottom:8}}>Ta bort reservation?</div>
            <div style={{fontSize:13,color:MU,marginBottom:16}}>Reservationen av <strong style={{color:TX}}>{confirmUnreserve.item.name}</strong> för <strong style={{color:TX}}>{confirmUnreserve.res.regNumber}</strong> tas bort.</div>
            <div style={{display:"flex",gap:8}}>
              <Btn full variant="ghost" onClick={()=>setConfirmUnreserve(null)}>Avbryt</Btn>
              <Btn full variant="red" onClick={()=>removeReservation(confirmUnreserve.item, confirmUnreserve.res.id)}>Ta bort</Btn>
            </div>
          </div>
        </div>
      )}

      {confirmRemoveAll&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.4)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:200,padding:20}} onClick={()=>setConfirmRemoveAll(null)}>
          <div onClick={e=>e.stopPropagation()} style={{background:WH,borderRadius:14,padding:20,maxWidth:340,width:"100%"}}>
            <div style={{fontWeight:700,fontSize:15,marginBottom:8,color:R}}>Ta bort hela reservationen?</div>
            <div style={{fontSize:13,color:MU,marginBottom:16}}>Alla <strong style={{color:TX}}>{confirmRemoveAll.list.length} delar</strong> som är reserverade till <strong style={{color:TX}}>{confirmRemoveAll.reg}</strong> av-reserveras. Delarna finns kvar i lagret.</div>
            <div style={{display:"flex",gap:8}}>
              <Btn full variant="ghost" onClick={()=>setConfirmRemoveAll(null)}>Avbryt</Btn>
              <Btn full variant="red" onClick={()=>removeWholeReservation(confirmRemoveAll.reg, confirmRemoveAll.list)}>Ta bort alla</Btn>
            </div>
          </div>
        </div>
      )}

      {/* Ny reservation — flera delar till ett regnummer */}
      {showNew&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.5)",display:"flex",flexDirection:"column",zIndex:300}}>
          <div className="topbar-safe" style={{background:WH,borderBottom:`1px solid ${BD}`,padding:"12px 14px",display:"flex",alignItems:"center",gap:10,flexShrink:0}}>
            <button onClick={()=>{stopScan();setShowNew(false);setPicked(new Set());}} style={{background:"none",border:"none",fontSize:20,color:MU,cursor:"pointer",padding:4}}><i className="fa-solid fa-xmark"/></button>
            <div style={{fontWeight:800,fontSize:16,flex:1}}>Ny reservation</div>
            <span style={{fontSize:13,color:picked.size?BX:MU,fontWeight:700}}>{picked.size} valda</span>
          </div>

          <div style={{flex:1,overflowY:"auto",WebkitOverflowScrolling:"touch",padding:14,background:BG}}>
            <div style={{background:AM+"16",border:`1px solid ${AM}30`,borderRadius:10,padding:14,marginBottom:14}}>
              <div style={{display:"flex",gap:10,marginBottom:10}}>
                <div style={{flex:1}}>
                  <label style={{fontSize:10,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7}}>Regnummer</label>
                  <input value={newForm.regNumber} onChange={e=>setNewForm(f=>({...f,regNumber:formatRegNumber(e.target.value)}))} placeholder="ABC 123" autoFocus
                    style={{width:"100%",border:`1.5px solid ${BD}`,borderRadius:7,padding:"10px 12px",fontSize:15,fontWeight:700,letterSpacing:1,marginTop:4,fontFamily:"monospace",boxSizing:"border-box"}}/>
                </div>
                <div style={{flex:1.4}}>
                  <label style={{fontSize:10,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7}}>Kund</label>
                  <input value={newForm.customer} onChange={e=>setNewForm(f=>({...f,customer:e.target.value}))} placeholder="Namn eller företag"
                    style={{width:"100%",border:`1.5px solid ${BD}`,borderRadius:7,padding:"10px 12px",fontSize:14,marginTop:4,boxSizing:"border-box"}}/>
                </div>
              </div>
              <div style={{fontSize:10.5,color:MU,marginTop:-4,marginBottom:4}}>Ange regnummer eller kund — minst ett av dem.</div>
              <input value={newForm.note} onChange={e=>setNewForm(f=>({...f,note:e.target.value}))} placeholder="Notering (valfritt) — gäller alla valda delar"
                style={{width:"100%",border:`1.5px solid ${BD}`,borderRadius:7,padding:"9px 12px",fontSize:13,boxSizing:"border-box"}}/>
            </div>

            <div style={{display:"flex",gap:8,marginBottom:10}}>
              <div style={{position:"relative",flex:1}}>
                <Icon name="magnifying-glass" style={{position:"absolute",left:12,top:"50%",transform:"translateY(-50%)",color:MU,fontSize:13}}/>
                <input value={pickSearch} onChange={e=>setPickSearch(e.target.value)} placeholder="Sök delar att reservera…"
                  style={{width:"100%",border:`1.5px solid ${BD}`,borderRadius:8,padding:"10px 12px 10px 34px",fontSize:14,boxSizing:"border-box"}}/>
              </div>
              <input ref={scanFileRef} type="file" accept="image/*" capture="environment" style={{display:"none"}} onChange={e=>{decodePhoto(e.target.files[0]); e.target.value="";}}/>
              <button onClick={()=>{ if(scanning) stopScan(); else startScan(); }} style={{flexShrink:0,display:"flex",alignItems:"center",gap:6,padding:"10px 14px",borderRadius:8,border:`1.5px solid ${scanning?R:BX}`,background:scanning?R:BX,color:WH,fontWeight:600,fontSize:13,cursor:"pointer"}}>
                <Icon name={scanning?"xmark":"qrcode"}/> {scanning?"Stäng":"Skanna"}
              </button>
            </div>

            {/* Live-kameravy */}
            {scanning&&(
              <div style={{background:"#000",borderRadius:10,overflow:"hidden",marginBottom:10,position:"relative"}}>
                <video ref={scanVideoRef} style={{width:"100%",maxHeight:280,objectFit:"cover",display:"block"}} muted playsInline autoPlay/>
                <div style={{position:"absolute",top:"50%",left:"50%",transform:"translate(-50%,-50%)",width:"55%",aspectRatio:"1",border:`3px solid ${WH}`,borderRadius:12,boxShadow:"0 0 0 2000px rgba(0,0,0,.35)"}}/>
                <div style={{position:"absolute",bottom:8,left:0,right:0,textAlign:"center",color:WH,fontSize:12,fontWeight:600}}>Rikta kameran mot QR-koden</div>
              </div>
            )}
            {scanError&&(
              <div style={{background:R+"10",border:`1px solid ${R}40`,borderRadius:8,padding:"9px 12px",fontSize:12,color:R,marginBottom:10}}>
                {scanError}
                <button onClick={()=>scanFileRef.current?.click()} style={{display:"block",marginTop:6,background:"none",border:"none",color:BX,fontWeight:700,fontSize:12,textDecoration:"underline",cursor:"pointer",padding:0}}>Ta foto istället</button>
              </div>
            )}

            {/* Sortera + Filtrera */}
            <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:8}}>
              <button onClick={()=>{setPickShowSort(v=>!v);setPickShowFilter(false);}} style={{display:"flex",alignItems:"center",gap:6,padding:"8px 12px",borderRadius:8,border:`1.5px solid ${pickShowSort?BX:BD}`,background:pickShowSort?B+"08":WH,color:BX,fontWeight:600,fontSize:12,cursor:"pointer",flexShrink:0}}>
                <Icon name="arrow-up-wide-short"/> Sortera
              </button>
              <button onClick={()=>{setPickShowFilter(v=>!v);setPickShowSort(false);}} style={{display:"flex",alignItems:"center",gap:6,padding:"8px 12px",borderRadius:8,border:`1.5px solid ${pfActive?BX:BD}`,background:pfActive?BX:(pickShowFilter?B+"08":WH),color:pfActive?WH:BX,fontWeight:600,fontSize:12,cursor:"pointer",flexShrink:0}}>
                <Icon name="filter"/> Filter{pfActive?` (${pfActive})`:""}
              </button>
              <div style={{fontSize:11,color:MU,marginLeft:"auto"}}>{pickable.length} delar · {picked.size} valda</div>
            </div>

            {pickShowSort&&(
              <div style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,boxShadow:SH2,marginBottom:8,overflow:"hidden"}}>
                {[
                  {k:"stockNumber",dir:"asc",l:"Lagernummer stigande",icon:"arrow-down-1-9"},
                  {k:"stockNumber",dir:"desc",l:"Lagernummer fallande",icon:"arrow-up-9-1"},
                  {k:"name",dir:"asc",l:"Namn A–Ö",icon:"arrow-down-a-z"},
                  {k:"price",dir:"desc",l:"Högst pris först",icon:"tag"},
                  {k:"price",dir:"asc",l:"Lägst pris först",icon:"tag"},
                  {k:"category",dir:"asc",l:"Kategori A–Ö",icon:"layer-group"},
                ].map(o=>{
                  const active = pickSort===o.k && pickSortDir===o.dir;
                  return (
                    <button key={o.k+o.dir} onClick={()=>{setPickSort(o.k);setPickSortDir(o.dir);setPickShowSort(false);}}
                      style={{width:"100%",display:"flex",alignItems:"center",gap:10,padding:"10px 14px",background:active?B+"08":"transparent",border:"none",borderBottom:`1px solid ${BD}40`,cursor:"pointer",textAlign:"left"}}>
                      <i className={`fa-solid fa-${o.icon}`} style={{color:active?BX:MU,fontSize:12,width:16}}/>
                      <span style={{fontSize:13,fontWeight:active?700:500,color:active?BX:TX,flex:1}}>{o.l}</span>
                      {active&&<Icon name="check" style={{color:BX,fontSize:12}}/>}
                    </button>
                  );
                })}
              </div>
            )}

            {/* Filterpanel — samma fält som lagrets filter */}
            {pickShowFilter&&(
              <div style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,boxShadow:SH2,marginBottom:8,padding:"12px 14px"}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                  <span style={{fontSize:12,fontWeight:700,color:BX}}>Filtrera delar</span>
                  {pfActive>0&&<button onClick={clearPF} style={{background:"none",border:"none",color:R,fontWeight:600,fontSize:12,cursor:"pointer"}}>Rensa filter</button>}
                </div>
                {pickCats.length>0&&(<>
                  <div style={{fontSize:10,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,margin:"8px 0 5px"}}>Kategori</div>
                  <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>{pickCats.map(c=><button key={c} onClick={()=>togglePF("cats",c)} style={{padding:"5px 11px",borderRadius:14,border:`1.5px solid ${pf.cats.includes(c)?BX:BD}`,background:pf.cats.includes(c)?BX:WH,color:pf.cats.includes(c)?WH:TM,fontSize:11,fontWeight:600,cursor:"pointer"}}>{c}</button>)}</div>
                </>)}
                {pickConds.length>0&&(<>
                  <div style={{fontSize:10,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,margin:"10px 0 5px"}}>Skick</div>
                  <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>{pickConds.map(c=><button key={c} onClick={()=>togglePF("conds",c)} style={{padding:"5px 11px",borderRadius:14,border:`1.5px solid ${pf.conds.includes(c)?BX:BD}`,background:pf.conds.includes(c)?BX:WH,color:pf.conds.includes(c)?WH:TM,fontSize:11,fontWeight:600,cursor:"pointer"}}>{c}</button>)}</div>
                </>)}
                {pickSides.length>0&&(<>
                  <div style={{fontSize:10,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,margin:"10px 0 5px"}}>Sida</div>
                  <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>{pickSides.map(c=><button key={c} onClick={()=>togglePF("sides",c)} style={{padding:"5px 11px",borderRadius:14,border:`1.5px solid ${pf.sides.includes(c)?BX:BD}`,background:pf.sides.includes(c)?BX:WH,color:pf.sides.includes(c)?WH:TM,fontSize:11,fontWeight:600,cursor:"pointer"}}>{c}</button>)}</div>
                </>)}
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginTop:10}}>
                  {pickMakes.length>0&&<div><div style={{fontSize:10,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:4}}>Märke</div><select value={pf.make} onChange={e=>setPickFilters(p=>({...p,make:e.target.value}))} style={{width:"100%",padding:"8px 10px",border:`1.5px solid ${pf.make?BX:BD}`,borderRadius:7,fontSize:12,color:pf.make?BX:MU,background:WH,fontWeight:pf.make?600:400}}><option value="">Alla märken</option>{pickMakes.map(m=><option key={m} value={m}>{m}</option>)}</select></div>}
                  {pickModels.length>0&&<div><div style={{fontSize:10,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:4}}>Modell</div><select value={pf.model} onChange={e=>setPickFilters(p=>({...p,model:e.target.value}))} style={{width:"100%",padding:"8px 10px",border:`1.5px solid ${pf.model?BX:BD}`,borderRadius:7,fontSize:12,color:pf.model?BX:MU,background:WH,fontWeight:pf.model?600:400}}><option value="">Alla modeller</option>{pickModels.map(m=><option key={m} value={m}>{m}</option>)}</select></div>}
                  {pickSuppliers.length>0&&<div><div style={{fontSize:10,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:4}}>Leverantör</div><select value={pf.supplier} onChange={e=>setPickFilters(p=>({...p,supplier:e.target.value}))} style={{width:"100%",padding:"8px 10px",border:`1.5px solid ${pf.supplier?BX:BD}`,borderRadius:7,fontSize:12,color:pf.supplier?BX:MU,background:WH,fontWeight:pf.supplier?600:400}}><option value="">Alla</option>{pickSuppliers.map(m=><option key={m} value={m}>{m}</option>)}</select></div>}
                  {pickLocTypes.length>0&&<div><div style={{fontSize:10,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:4}}>Placeringstyp</div><select value={pf.locationType} onChange={e=>setPickFilters(p=>({...p,locationType:e.target.value}))} style={{width:"100%",padding:"8px 10px",border:`1.5px solid ${pf.locationType?BX:BD}`,borderRadius:7,fontSize:12,color:pf.locationType?BX:MU,background:WH,fontWeight:pf.locationType?600:400}}><option value="">Alla</option>{pickLocTypes.map(m=><option key={m} value={m}>{m}</option>)}</select></div>}
                </div>
                <div style={{display:"flex",gap:8,marginTop:10,alignItems:"center"}}>
                  <div style={{flex:1}}><div style={{fontSize:10,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:4}}>Pris från</div><input type="number" inputMode="numeric" value={pf.priceMin} onChange={e=>setPickFilters(p=>({...p,priceMin:e.target.value}))} placeholder="0" style={{width:"100%",padding:"8px 10px",border:`1.5px solid ${pf.priceMin!==""?BX:BD}`,borderRadius:7,fontSize:12,boxSizing:"border-box"}}/></div>
                  <div style={{flex:1}}><div style={{fontSize:10,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:4}}>Pris till</div><input type="number" inputMode="numeric" value={pf.priceMax} onChange={e=>setPickFilters(p=>({...p,priceMax:e.target.value}))} placeholder="∞" style={{width:"100%",padding:"8px 10px",border:`1.5px solid ${pf.priceMax!==""?BX:BD}`,borderRadius:7,fontSize:12,boxSizing:"border-box"}}/></div>
                </div>
              </div>
            )}
            {pickable.map(item=>{
              const sel = picked.has(item.id);
              const free = (item.quantity||0)-((item.reservations&&item.reservations.length)||0);
              return (
                <div key={item.id} onClick={()=>togglePick(item.id)} style={{background:WH,borderRadius:8,border:`2px solid ${sel?AM:BD}`,padding:"10px 12px",marginBottom:6,display:"flex",gap:10,alignItems:"center",cursor:"pointer"}}>
                  <div style={{width:20,height:20,borderRadius:5,border:`2px solid ${sel?AM:BD}`,background:sel?AM:"transparent",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                    {sel&&<Icon name="check" style={{fontSize:10,color:WH}}/>}
                  </div>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontWeight:600,fontSize:13,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{item.stockNumber?`#${item.stockNumber} `:""}{item.name}{item.side?` — ${item.side}`:""}</div>
                    <div style={{fontSize:11,color:MU}}>{item.oem||item.sku} · {free} ledig{free!==1?"a":""}</div>
                  </div>
                  <div style={{fontWeight:700,color:BX,fontSize:13,flexShrink:0}}>{item.price.toLocaleString("sv-SE")} kr</div>
                </div>
              );
            })}
            {pickable.length===0&&<div style={{textAlign:"center",padding:30,color:MU,fontSize:13}}>Inga delar matchar</div>}
          </div>

          <div style={{background:WH,borderTop:`1px solid ${BD}`,padding:"12px 14px",paddingBottom:"max(12px,env(safe-area-inset-bottom))",boxShadow:"0 -4px 20px rgba(0,0,0,.08)"}}>
            <Btn full variant="red" onClick={saveMultiReservation} disabled={(!newForm.regNumber.trim()&&!newForm.customer.trim())||picked.size===0}>
              <Icon name="bookmark"/> Reservera {picked.size} {picked.size===1?"del":"delar"}{newForm.regNumber?` till ${newForm.regNumber}`:""}
            </Btn>
          </div>
        </div>
      )}
    </Page>
  );
}

// ─── Detail Page ──────────────────────────────────────────────────────────────
function DetailPage({ item: initialItem, items, sales, saveItems, saveSales, addToCart, can, isAdmin, currentUser, push, pop, toast$, openReserve, logActivity, moveToTrash, canManageItem }) {
  // Get fresh item from store in case it was updated
  const item = items.find(i=>i.id===initialItem.id) || initialItem;
  const isMobile = useIsMobile();
  const [idx, setIdx] = useState(0);
  const [lightbox, setLightbox] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const [showReserve, setShowReserve] = useState(!!openReserve);
  const [confirmDel, setConfirmDel] = useState(false);
  const [resForm, setResForm] = useState({ regNumber:"", customer:"", note:"" });
  const [confirmUnreserve, setConfirmUnreserve] = useState(null);
  const [sellToReserved, setSellToReserved] = useState(null);
  const touchRef = useRef(null);
  const bilInfoUrl = item.regNumber ? `https://www.biluppgifter.se/fordon/${item.regNumber.replace(/\s/g,"")}` : null;

  // Reservationer ligger på artikeln. Antal som går att sälja fritt =
  // antal minus antal reservationer (reserverade exemplar är skyddade).
  const reservations = item.reservations || [];
  const freeQty = Math.max(0, (item.quantity||0) - reservations.length);

  // Bygg cachebara bild-URL:er — webbläsaren cachar dem, hämtas aldrig om.
  // En URL per bild: /api/img/<id>/<index>?v=<tid>
  const count = item.images?.length > 0 ? item.images.length : (item.hasImages || 0);
  const imgs = item.images?.length > 0
    ? item.images  // precis sparade, redan i minnet
    : Array.from({length: count}, (_, k) => `/api/img/${item.id}/${k}?v=${item.updatedAt||0}`);

  const handleTouchStart = e => { touchRef.current = e.touches[0].clientX; };
  const handleTouchEnd = e => {
    if (touchRef.current===null) return;
    const dx = e.changedTouches[0].clientX - touchRef.current;
    if (dx<-40) setIdx(i=>Math.min(imgs.length-1,i+1));
    if (dx>40)  setIdx(i=>Math.max(0,i-1));
    touchRef.current = null;
  };

  // ── Reservationer ──────────────────────────────────────────────────────────
  const addReservation = async () => {
    if (!resForm.regNumber.trim() && !resForm.customer.trim()) { toast$("Ange antingen registreringsnummer eller kund (minst ett)","error"); return; }
    if (reservations.length >= (item.quantity||0)) { toast$("Alla exemplar är redan reserverade","error"); return; }
    const newRes = {
      id: genId("res"),
      regNumber: resForm.regNumber.trim().toUpperCase(),
      customer: resForm.customer.trim(),
      note: resForm.note.trim(),
      by: currentUser?.username || "Okänd",
      ts: Date.now(),
    };
    const updated = { ...item, reservations:[...reservations, newRes], updatedAt:Date.now() };
    const res = await saveOneItem(updated);
    if (res) saveItems(res); else await saveItems(items.map(i=>i.id===item.id?updated:i));
    setShowReserve(false);
    setResForm({ regNumber:"", customer:"", note:"" });
    logActivity&&logActivity("reserve", `Reserverade ${item.name}${item.stockNumber?` (#${item.stockNumber})`:""} åt ${newRes.regNumber}${newRes.customer?` (${newRes.customer})`:""}`, { user: currentUser?.username });
    toast$("Reservation tillagd","success");

    // Om delen tillhör ett annat lager än den som reserverar — mejla
    // utvalda personer på det lagret (de som satt på notisen i sin profil)
    if (item.warehouse && currentUser?.homeWarehouse && item.warehouse !== currentUser.homeWarehouse) {
      fetch("/admin/api/notify-warehouse-reservation", {
        method:"POST", headers: authHeaders({"Content-Type":"application/json"}),
        body: JSON.stringify({
          warehouse: item.warehouse, itemName: item.name, stockNumber: item.stockNumber,
          oem: item.oem, location: [item.locationType,item.location].filter(Boolean).join(" — "),
          customer: newRes.customer, regNumber: newRes.regNumber, reservedBy: currentUser?.username,
        }),
      }).catch(()=>{});
    }
  };

  const removeReservation = async (resId) => {
    const updated = { ...item, reservations: reservations.filter(r=>r.id!==resId), updatedAt:Date.now() };
    const res = await saveOneItem(updated);
    if (res) saveItems(res); else await saveItems(items.map(i=>i.id===item.id?updated:i));
    setConfirmUnreserve(null);
    toast$("Reservation borttagen","success");
  };

  const doDelete = async () => {
    const updated = await softDeleteOneItem(item.id);
    if (updated) saveItems(updated);
    else await saveItems(items.filter(i=>i.id!==item.id));
    moveToTrash?.(item, currentUser?.username);
    setConfirmDel(false);
    logActivity&&logActivity("delete", `Tog bort ${item.name}${item.stockNumber?` (#${item.stockNumber})`:""}`, { user: currentUser?.username });
    toast$("Flyttad till papperskorgen","success");
    pop();
  };

  const printProduct = () => {
    const imgHtml = item.images?.length>0 ? `<img src="${item.images[0]}" style="width:200px;height:150px;object-fit:cover;border-radius:8px;margin-bottom:12px"/>` : "";
    const loc = [item.locationType, item.location].filter(Boolean).join(" — ");
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${item.name}</title>
    <style>body{font-family:sans-serif;margin:0;padding:24px;color:#141820}
    .num{background:#1B3A6B;color:#fff;padding:6px 14px;border-radius:6px;font-size:22px;font-weight:800;letter-spacing:1px;display:inline-block;margin-bottom:12px}
    h1{font-size:18px;margin:0 0 4px}
    .badge{display:inline-block;background:#1B3A6B18;color:#1B3A6B;border:1px solid #1B3A6B28;border-radius:4px;padding:2px 8px;font-size:11px;font-weight:600;margin:2px}
    .price{font-size:28px;font-weight:800;color:#1B3A6B;margin:12px 0}
    .row{font-size:12px;padding:5px 0;border-bottom:1px solid #f0f0f0}
    .lbl{color:#8A90A0;font-size:10px;text-transform:uppercase}
    .val{font-weight:600;font-size:13px}
    </style></head><body>
    ${imgHtml}
    ${item.stockNumber?`<div class="num">#${item.stockNumber}</div><br/>`:""}
    <h1>${item.name}${item.side?` — ${item.side}`:""}</h1>
    <div style="margin:6px 0">
      <span class="badge">${item.category||""}</span>
      <span class="badge">${item.condition||""}</span>
    </div>
    <div class="price">${(item.price||0).toLocaleString("sv-SE")} kr</div>
    <div class="row"><div class="lbl">Artikelnummer</div><div class="val" style="font-family:monospace">${item.oem||"—"}</div></div>
    ${item.make?`<div class="row"><div class="lbl">Märke</div><div class="val">${item.make} ${item.model||""}</div></div>`:""}
    ${loc?`<div class="row"><div class="lbl">Placering</div><div class="val">${loc}</div></div>`:""}
    ${item.regNumber?`<div class="row"><div class="lbl">Reg.nr</div><div class="val">${item.regNumber}</div></div>`:""}
    ${item.notes?`<div style="margin-top:14px;background:#f5f5f7;border-radius:6px;padding:10px;font-size:12px">${item.notes}</div>`:""}
    <script>window.addEventListener('load',function(){setTimeout(function(){window.print();},400);});</script>
    </body></html>`;
    // Lägg till auto-print script och använd universell printHtml
    const printableHtml = html.replace("</body>", "<script>window.onload=()=>setTimeout(()=>window.print(),400)<\/script></body>");
    printHtml(printableHtml);
  };

  const shareLink = async () => {
    const baseUrl = window.location.origin;
    const link = `${baseUrl}/?item=${item.id}`;
    const text = `${item.name} — #${item.stockNumber||""}\nArtikelnr: ${item.oem||"—"}\nPris: ${(item.price||0).toLocaleString("sv-SE")} kr`;

    // Web Share API — mobilens egna dela-meny (AirDrop, WhatsApp, Messages osv)
    if (navigator.share) {
      try {
        await navigator.share({ title: item.name, text, url: link });
        return;
      } catch (e) {
        // Användaren avbröt — gör inget
        if (e.name === "AbortError") return;
      }
    }

    // Desktop utan Web Share — visa egen panel
    setShareData({ link, subject: encodeURIComponent(`${item.name} — #${item.stockNumber||""}`), body: encodeURIComponent(text + "\n\n" + link) });
    setShowShare(true);
  };

  const [showShare, setShowShare] = useState(false);
  const [shareData, setShareData] = useState(null);

  const canCart = (can("canUseCheckout")||isAdmin) && freeQty>0 && canManageItem(item);
  const canSellBtn = (can("canSell")||isAdmin) && freeQty>0 && canManageItem(item);
  const canReserveBtn = (can("canAddReservations")||isAdmin) && reservations.length<(item.quantity||0);
  const canEditBtn = can("canEdit") && canManageItem(item);
  const canDeleteBtn = (can("canDelete")||isAdmin) && canManageItem(item);
  const restrictedToOtherWarehouse = !canManageItem(item) && item.warehouse;

  const right = (
    <div style={{display:"flex",gap:6,alignItems:"center"}}>
      <Btn small variant="ghost" onClick={shareLink}><Icon name="share-nodes"/></Btn>
      <Btn small variant="ghost" onClick={printProduct}><Icon name="print"/></Btn>
      {canReserveBtn&&<Btn small variant="ghost" onClick={()=>setShowReserve(true)}><Icon name="bookmark"/>{!isMobile&&" Reservera"}</Btn>}
      {canSellBtn&&<Btn small variant="red" onClick={()=>push("sell",{item, maxQty:freeQty})}><Icon name="tag"/>{!isMobile&&" Sälj"}</Btn>}
      {canEditBtn&&<Btn small variant="ghost" onClick={()=>push("edit",{item})}><Icon name="pen"/></Btn>}
      {/* På dator: kassa + ta bort också uppe. På mobil: dessa hamnar längst ner. */}
      {!isMobile&&canCart&&<Btn small variant="blue" onClick={()=>{ addToCart(item); toast$(`${item.name} tillagd i korgen`,"success"); }}><Icon name="cart-shopping"/> Kassa</Btn>}
      {!isMobile&&canDeleteBtn&&<Btn small variant="ghost" onClick={()=>setConfirmDel(true)} style={{color:R}}><Icon name="trash"/></Btn>}
    </div>
  );

  return (
    <Page>
      <TopBar title={item.name+(item.side?` — ${item.side}`:"")} onBack={pop} right={right} />
      <div style={{padding:"14px 14px 40px"}}>

      {/* Dela-panel */}
      {showShare&&shareData&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.5)",zIndex:300,display:"flex",alignItems:"flex-end"}} onClick={()=>setShowShare(false)}>
          <div onClick={e=>e.stopPropagation()} style={{background:WH,borderRadius:"16px 16px 0 0",width:"100%",padding:"20px 16px",paddingBottom:"max(20px,env(safe-area-inset-bottom))"}}>
            <div style={{fontWeight:700,fontSize:15,marginBottom:16,textAlign:"center"}}>Dela artikel</div>
            {[
              {icon:"envelope",label:"Outlook / E-post",action:()=>{ window.open(`mailto:?subject=${shareData.subject}&body=${shareData.body}`); setShowShare(false); }},
              {icon:"brands fa-microsoft",label:"Teams",action:()=>{ window.open(`https://teams.microsoft.com/l/chat/0/0?message=${shareData.body}`); setShowShare(false); }},
              {icon:"brands fa-discord",label:"Discord",action:()=>{ copyText(shareData.link).then(()=>toast$("Länk kopierad — klistra in i Discord","success")); setShowShare(false); }},
              {icon:"copy",label:"Kopiera länk",action:()=>{ copyText(shareData.link).then(()=>toast$("Länk kopierad!","success")); setShowShare(false); }},
            ].map(({icon,label,action})=>(
              <button key={label} onClick={action} style={{width:"100%",display:"flex",alignItems:"center",gap:14,padding:"13px 12px",background:"none",border:"none",borderBottom:`1px solid ${BD}`,cursor:"pointer",fontSize:14,fontWeight:500,color:TX}}>
                <i className={`fa-${icon.startsWith("brands")?icon:`solid fa-${icon}`}`} style={{fontSize:18,color:BX,width:24,textAlign:"center"}}/>
                {label}
              </button>
            ))}
            <button onClick={()=>setShowShare(false)} style={{width:"100%",padding:"13px",marginTop:8,background:BG,border:"none",borderRadius:8,cursor:"pointer",fontSize:14,fontWeight:600,color:MU}}>Avbryt</button>
          </div>
        </div>
      )}

        {/* ÖVERSIKT — bild till vänster (begränsad storlek), viktig info till höger */}
        <div className="detail-hero" style={{display:"flex",gap:18,marginBottom:18,flexWrap:"wrap",alignItems:"flex-start"}}>

          {/* Bild — begränsad maxbredd så den inte tar hela skärmen */}
          {imgs.length>0 && (
            <div style={{flex:"1 1 320px",maxWidth:420,minWidth:260}}>
              <div style={{borderRadius:12,overflow:"hidden",background:BG,aspectRatio:"4/3",position:"relative",userSelect:"none",cursor:"zoom-in"}}
                onTouchStart={handleTouchStart} onTouchEnd={handleTouchEnd}>
                <img src={imgs[idx]} alt="" onClick={()=>setLightbox(true)} style={{width:"100%",height:"100%",objectFit:"cover"}} />
                <div style={{position:"absolute",top:10,right:10,background:"rgba(0,0,0,.45)",color:"#fff",borderRadius:"50%",width:30,height:30,display:"flex",alignItems:"center",justifyContent:"center",fontSize:13,pointerEvents:"none"}}><i className="fa-solid fa-expand"/></div>
                <div style={{position:"absolute",bottom:10,right:10,background:"rgba(0,0,0,.45)",color:"#fff",borderRadius:20,padding:"3px 10px",fontSize:11,fontWeight:600,pointerEvents:"none"}}>{idx+1}/{imgs.length}</div>
                {imgs.length>1&&<>
                  <button onClick={(e)=>{e.stopPropagation();setIdx(i=>Math.max(0,i-1));}} style={{position:"absolute",left:8,top:"50%",transform:"translateY(-50%)",background:"rgba(255,255,255,.85)",border:"none",borderRadius:"50%",width:34,height:34,fontSize:18,cursor:"pointer"}}>‹</button>
                  <button onClick={(e)=>{e.stopPropagation();setIdx(i=>Math.min(imgs.length-1,i+1));}} style={{position:"absolute",right:8,top:"50%",transform:"translateY(-50%)",background:"rgba(255,255,255,.85)",border:"none",borderRadius:"50%",width:34,height:34,fontSize:18,cursor:"pointer"}}>›</button>
                </>}
              </div>
              {imgs.length>1&&(
                <div style={{display:"flex",gap:6,marginTop:8,overflowX:"auto",paddingBottom:2}}>
                  {imgs.map((img,i)=><img key={i} src={img} alt="" loading="lazy" onClick={()=>setIdx(i)} style={{width:52,height:52,objectFit:"cover",borderRadius:7,border:`2.5px solid ${idx===i?BX:BD}`,cursor:"pointer",flexShrink:0}}/>)}
                </div>
              )}
            </div>
          )}

          {/* Viktig info till höger om bilden */}
          <div style={{flex:"1 1 300px",minWidth:260,display:"flex",flexDirection:"column",gap:12}}>

            {/* Lagernummer — stor */}
            {item.stockNumber&&(
              <div style={{background:BX,borderRadius:10,padding:"12px 16px",display:"flex",alignItems:"center",gap:12}}>
                <div style={{flex:1}}>
                  <div style={{fontSize:10,fontWeight:700,color:"rgba(255,255,255,.65)",textTransform:"uppercase",letterSpacing:.7,marginBottom:2}}>Lagernummer</div>
                  <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:40,fontWeight:800,color:WH,letterSpacing:2,lineHeight:1}}>#{item.stockNumber}</div>
                </div>
                <div style={{display:"flex",flexDirection:"column",gap:6}}>
                  <button onClick={()=>copyText(item.stockNumber).then(()=>toast$("Lagernummer kopierat","success"))}
                    style={{background:"rgba(255,255,255,.15)",border:"none",borderRadius:8,padding:"7px 11px",color:WH,cursor:"pointer",fontSize:12,fontWeight:600,display:"flex",alignItems:"center",gap:5,whiteSpace:"nowrap"}}>
                    <i className="fa-solid fa-copy"/> Kopiera
                  </button>
                  <button onClick={()=>push("qrlabels",{preSelected:[item.id]})}
                    style={{background:"rgba(255,255,255,.15)",border:"none",borderRadius:8,padding:"7px 11px",color:WH,cursor:"pointer",fontSize:12,fontWeight:600,display:"flex",alignItems:"center",gap:5,whiteSpace:"nowrap"}}>
                    <i className="fa-solid fa-tag"/> Etikett
                  </button>
                </div>
              </div>
            )}

            {/* Artikelnummer — stort och tydligt */}
            {item.oem&&(
              <div style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,padding:"10px 14px",display:"flex",alignItems:"center",gap:10}}>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:10,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:3}}>Artikelnummer (OEM)</div>
                  <div style={{fontFamily:"monospace",fontSize:22,fontWeight:800,color:TX,wordBreak:"break-all",lineHeight:1.1}}>{item.oem}</div>
                </div>
                <button onClick={()=>copyText(item.oem).then(()=>toast$("Artikelnummer kopierat","success"))}
                  style={{background:BG,border:`1px solid ${BD}`,borderRadius:8,padding:"7px 12px",color:BX,cursor:"pointer",fontSize:12,fontWeight:600,display:"flex",alignItems:"center",gap:5,flexShrink:0}}>
                  <i className="fa-solid fa-copy"/>
                </button>
              </div>
            )}

            {/* Placering — stor och tydlig */}
            {([item.locationType, item.location].filter(Boolean).length>0 || item.warehouse)&&(
              <div style={{background:B+"0A",borderRadius:10,border:`1px solid ${B}22`,padding:"10px 14px",display:"flex",alignItems:"center",gap:10}}>
                <i className="fa-solid fa-location-dot" style={{fontSize:20,color:BX}}/>
                <div style={{flex:1}}>
                  <div style={{fontSize:10,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:1}}>Placering</div>
                  <div style={{fontSize:20,fontWeight:800,color:BX,lineHeight:1.1}}>{[item.locationType, item.location].filter(Boolean).join(" — ")}</div>
                  {item.parentLocation&&<div style={{fontSize:11.5,color:MU,marginTop:2}}><i className="fa-solid fa-turn-up" style={{fontSize:9,transform:"rotate(90deg)",display:"inline-block",marginRight:4}}/>ligger på {item.parentLocation}</div>}
                </div>
                {item.warehouse&&<span style={{background:AM+"18",color:AM,borderRadius:14,padding:"4px 12px",fontSize:12,fontWeight:800,flexShrink:0}}><i className="fa-solid fa-industry" style={{marginRight:5,fontSize:10}}/>{item.warehouse}</span>}
              </div>
            )}

            {restrictedToOtherWarehouse&&(
              <div style={{background:AM+"12",border:`1px solid ${AM}40`,borderRadius:10,padding:"10px 14px",display:"flex",alignItems:"center",gap:10}}>
                <Icon name="triangle-exclamation" style={{color:AM,flexShrink:0}}/>
                <div style={{fontSize:12.5,color:TM}}>Den här delen tillhör <b style={{color:TX}}>{item.warehouse}</b> — du kan reservera den, men bara personal på det lagret kan redigera, sälja eller ta bort den.</div>
              </div>
            )}

            {/* Notering — högt upp så den syns direkt */}
            {item.notes&&(
              <div style={{background:NOTEBG,border:`1px solid ${AM}40`,borderRadius:10,padding:"10px 14px",fontSize:13,color:TM,lineHeight:1.5}}>
                <div style={{fontSize:10,fontWeight:700,color:AM,textTransform:"uppercase",letterSpacing:.7,marginBottom:3}}>Notering</div>
                {item.notes}
              </div>
            )}

            {/* KGK Fordonsdata — visas bara om delen faktiskt kontrollerats */}
            {item.kgkStatus&&(
              <div style={{background:item.kgkStatus==="found"?GR+"10":BG,border:`1px solid ${item.kgkStatus==="found"?GR+"40":BD}`,borderRadius:10,padding:"10px 14px"}}>
                <div style={{fontSize:10,fontWeight:700,color:item.kgkStatus==="found"?GR:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:5}}>
                  <i className="fa-solid fa-car" style={{marginRight:5}}/>KGK Fordonsdata
                </div>
                {item.kgkStatus==="found"&&item.alternativeNumbers?.length>0&&(
                  <div style={{fontSize:12.5,color:TX}}>Alt. artikelnummer: <strong style={{fontFamily:"monospace"}}>{item.alternativeNumbers.join(", ")}</strong></div>
                )}
                {item.kgkStatus==="found"&&!item.alternativeNumbers?.length&&(
                  <div style={{fontSize:12.5,color:TM}}>Hittad hos KGK, inga alternativa nummer registrerade.</div>
                )}
                {item.kgkStatus==="not_found"&&<div style={{fontSize:12.5,color:MU}}>Ej importerad från KGK</div>}
                {item.kgkStatus==="error"&&<div style={{fontSize:12.5,color:R}}>Kunde inte kontrollera mot KGK senast</div>}
              </div>
            )}
          </div>
        </div>

        {/* Flera exemplar — länk till variantsidan */}
        {(() => {
          const siblings = items.filter(i => i.sku?.trim().toLowerCase() === item.sku?.trim().toLowerCase());
          if (siblings.length <= 1) return null;
          return (
            <div onClick={()=>push("variants",{sku:item.sku})} style={{background:AM+"18",border:`1.5px solid ${AM}40`,borderRadius:10,padding:"12px 14px",marginBottom:14,display:"flex",alignItems:"center",gap:12,cursor:"pointer"}}>
              <i className="fa-solid fa-layer-group" style={{fontSize:20,color:AM}}/>
              <div style={{flex:1}}>
                <div style={{fontWeight:700,fontSize:13,color:AM}}>Det finns {siblings.length} exemplar av denna del</div>
                <div style={{fontSize:11,color:AM}}>Olika skick och pris — tryck för att jämföra och välja</div>
              </div>
              <i className="fa-solid fa-chevron-right" style={{color:AM,fontSize:13}}/>
            </div>
          );
        })()}

        {/* Beskrivning */}
        {item.description&&(
          <div style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,padding:"12px 14px",marginBottom:14}}>
            <div style={{fontSize:10,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:5}}>Beskrivning</div>
            <div style={{fontSize:13,color:TX,lineHeight:1.5}}>{item.description}</div>
          </div>
        )}

        {/* Badges */}
        <div style={{display:"flex",gap:5,flexWrap:"wrap",marginBottom:14}}>
          <Badge label={item.category} color={BX} />
          {item.side&&<Badge label={item.side} color={BX} />}
          <Badge label={item.condition} color={cc(item.condition)} />
          
        </div>

        {/* Price + qty */}
        <div style={{display:"flex",gap:10,marginBottom:16}}>
          <div style={{flex:1,background:B+"08",border:`1px solid ${B}20`,borderRadius:10,padding:"12px 14px",textAlign:"center"}}>
            <div style={{fontSize:10,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.8,marginBottom:2}}>Försäljningspris</div>
            <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:28,fontWeight:800,color:BX}}>{item.price.toLocaleString("sv-SE")} kr</div>
          </div>
          <div style={{flex:1,background:sc(item.quantity)+"10",border:`1px solid ${sc(item.quantity)}30`,borderRadius:10,padding:"12px 14px",textAlign:"center"}}>
            <div style={{fontSize:10,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.8,marginBottom:2}}>I lager</div>
            <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:28,fontWeight:800,color:sc(item.quantity)}}>{item.quantity} st</div>
          </div>
        </div>

        {/* ── Reservationer ── */}
        {(can("canViewReservations")||can("canAddReservations")||isAdmin)&&(
          <div style={{background:WH,borderRadius:10,border:`1.5px solid ${reservations.length>0?AM+"60":BD}`,padding:"12px 14px",marginBottom:14}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:reservations.length>0?10:0}}>
              <div style={{display:"flex",alignItems:"center",gap:8}}>
                <i className="fa-solid fa-bookmark" style={{color:reservations.length>0?AM:MU,fontSize:15}}/>
                <span style={{fontWeight:800,fontSize:14,color:TX}}>Reservationer</span>
                {reservations.length>0&&<span style={{background:AM,color:WH,borderRadius:10,padding:"1px 8px",fontSize:11,fontWeight:700}}>{reservations.length} av {item.quantity}</span>}
              </div>
            </div>
            {reservations.length===0&&(
              <div style={{fontSize:12,color:MU}}>Inga reservationer. Använd "Reservera" uppe i headern för att reservera ett exemplar åt en kund.</div>
            )}

            {reservations.length>0&&(
              <div style={{display:"flex",flexDirection:"column",gap:8}}>
                {reservations.map(r=>(
                  <div key={r.id} style={{background:AM+"16",border:`1px solid ${AM}30`,borderRadius:8,padding:"10px 12px"}}>
                    <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:r.customer||r.note?5:0}}>
                      <span style={{background:AM,color:WH,borderRadius:5,padding:"2px 9px",fontSize:14,fontWeight:800,letterSpacing:.5,fontFamily:"monospace"}}>{r.regNumber}</span>
                      {r.customer&&<span style={{fontSize:13,fontWeight:600,color:TX}}>{r.customer}</span>}
                      <div style={{marginLeft:"auto",display:"flex",gap:6}}>
                        {(can("canSell")||isAdmin)&&<Btn small variant="red" onClick={()=>setSellToReserved(r)}><Icon name="tag"/> Sälj</Btn>}
                        {(can("canEditReservations")||isAdmin)&&<Btn small variant="ghost" onClick={()=>setConfirmUnreserve(r)} style={{color:R}}><Icon name="xmark"/></Btn>}
                      </div>
                    </div>
                    {r.note&&<div style={{fontSize:12,color:TM,marginBottom:3}}>{r.note}</div>}
                    <div style={{fontSize:10,color:MU}}>Reserverad av {r.by} · {new Date(r.ts).toLocaleDateString("sv-SE")}</div>
                  </div>
                ))}
                {freeQty>0
                  ? <div style={{fontSize:11,color:MU,marginTop:2}}>{freeQty} av {item.quantity} kan säljas fritt — resten är reserverade.</div>
                  : <div style={{fontSize:11,color:AM,fontWeight:600,marginTop:2}}>Alla exemplar är reserverade — kan bara säljas till reserverad kund.</div>}
              </div>
            )}
          </div>
        )}


        {/* Ursprungsbil */}
        {(item.make||item.model||item.regNumber)&&(
          <div style={{background:B+"08",border:`1px solid ${B}20`,borderRadius:10,padding:"12px 14px",marginBottom:14}}>
            <div style={{fontSize:10,fontWeight:700,color:BX,textTransform:"uppercase",letterSpacing:1,marginBottom:10}}>Ursprungsbil</div>
            <div style={{display:"flex",flexWrap:"wrap",gap:"8px 20px",marginBottom:10}}>
              {item.make&&<div><div style={{fontSize:10,color:MU,fontWeight:700,textTransform:"uppercase",marginBottom:1}}>Märke</div><div style={{fontSize:14,fontWeight:600}}>{item.make}</div></div>}
              {item.model&&<div><div style={{fontSize:10,color:MU,fontWeight:700,textTransform:"uppercase",marginBottom:1}}>Modell</div><div style={{fontSize:14,fontWeight:600}}>{item.model}</div></div>}
              {item.yearFrom&&<div><div style={{fontSize:10,color:MU,fontWeight:700,textTransform:"uppercase",marginBottom:1}}>Årsmodell</div><div style={{fontSize:14,fontWeight:600}}>{item.yearFrom}{item.yearTo?`-${item.yearTo}`:""}</div></div>}
              {item.regNumber&&<div><div style={{fontSize:10,color:MU,fontWeight:700,textTransform:"uppercase",marginBottom:1}}>Reg.nr</div><div style={{fontSize:15,fontWeight:800,letterSpacing:1.5,color:BX}}>{item.regNumber}</div></div>}
            </div>
            {bilInfoUrl&&<button onClick={()=>{ try{ window.open(bilInfoUrl,"_blank"); }catch{ window.location.href=bilInfoUrl; } }} style={{display:"inline-flex",alignItems:"center",gap:5,background:BX,color:"#fff",borderRadius:6,padding:"7px 14px",fontSize:12,fontWeight:600,border:"none",cursor:"pointer"}}><Icon name="magnifying-glass" style={{marginRight:5}}/> Kolla bilinfo & originalpris</button>}
          </div>
        )}

        {/* QR-kod */}
        <div style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,padding:"14px",marginBottom:14,display:"flex",alignItems:"center",gap:14}}>
          <img src={`https://api.qrserver.com/v1/create-qr-code/?size=80x80&data=${encodeURIComponent(item.stockNumber||item.oem||item.sku)}`} alt="QR" style={{width:70,height:70,borderRadius:6,border:`1px solid ${BD}`}} onError={e=>{e.target.style.display="none";e.target.nextSibling.style.display="flex";}} /><div style={{width:70,height:70,borderRadius:6,border:`1px solid ${BD}`,background:BG,display:"none",alignItems:"center",justifyContent:"center",fontSize:9,color:MU,textAlign:"center",padding:4,fontFamily:"monospace"}}>{item.stockNumber||item.oem||item.sku}</div>
          <div>
            <div style={{fontSize:10,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:3}}>QR-kod för skanning</div>
            <div style={{fontSize:13,fontWeight:600,fontFamily:"monospace"}}>{item.stockNumber||item.oem||item.sku}</div>
          </div>
        </div>

        {/* Fields — viktigast synligt, resten bakom "Visa mer" */}
        <div style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,padding:"14px",marginBottom:14}}>
          <div style={{display:"flex",flexWrap:"wrap",gap:"12px 12px"}}>
            <Field label="Artikelnummer" value={item.oem} half />
            <Field label="Skick" value={item.condition} half />
            <Field label="Sida" value={item.side} half />
            <Field label="Placering" value={[item.locationType, item.location].filter(Boolean).join(" — ")} half />
          </div>
          {showMore&&(
            <div style={{display:"flex",flexWrap:"wrap",gap:"12px 12px",marginTop:12,paddingTop:12,borderTop:`1px solid ${BD}`}}>
              <Field label="Färgkod" value={item.colorCode} half />
              <Field label="Vikt" value={item.weight?item.weight+" kg":""} half />
              <Field label="Leverantör" value={item.supplier} half />
              {(isAdmin||can("canEdit"))&&<Field label="Inköpspris" value={item.costPrice?item.costPrice.toLocaleString("sv-SE")+" kr":""} half />}
              <Field label="Uppdaterad" value={new Date(item.updatedAt).toLocaleDateString("sv-SE")} half />
            </div>
          )}
          <button onClick={()=>setShowMore(v=>!v)} style={{width:"100%",background:"none",border:"none",borderTop:showMore?"none":`1px solid ${BD}`,marginTop:showMore?10:12,paddingTop:10,color:BX,fontSize:12,fontWeight:600,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:5}}>
            {showMore?"Visa mindre":"Visa fler detaljer"} <i className={`fa-solid fa-chevron-${showMore?"up":"down"}`} style={{fontSize:10}}/>
          </button>
        </div>

        {/* Mobil — kassa & ta bort längst ner (de nya knapparna) */}
        {isMobile&&(canCart||canDeleteBtn)&&(
          <div style={{display:"flex",gap:8,marginTop:16}}>
            {canCart&&<Btn full variant="blue" onClick={()=>{ addToCart(item); toast$(`${item.name} tillagd i korgen`,"success"); }}><Icon name="cart-shopping"/> Lägg i kassa</Btn>}
            {canDeleteBtn&&<Btn full variant="ghost" onClick={()=>setConfirmDel(true)} style={{color:R,borderColor:R+"40"}}><Icon name="trash"/> Ta bort</Btn>}
          </div>
        )}

      </div>

      {/* Bekräfta ta bort del */}
      {confirmDel&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.4)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:200,padding:20}} onClick={()=>setConfirmDel(false)}>
          <div onClick={e=>e.stopPropagation()} style={{background:WH,borderRadius:14,padding:20,maxWidth:340,width:"100%"}}>
            <div style={{fontWeight:700,fontSize:15,marginBottom:8}}>Ta bort {item.name}?</div>
            <div style={{fontSize:13,color:MU,marginBottom:16}}>Delen tas bort permanent från lagret. Detta går inte att ångra.</div>
            <div style={{display:"flex",gap:8}}>
              <Btn full variant="ghost" onClick={()=>setConfirmDel(false)}>Avbryt</Btn>
              <Btn full variant="red" onClick={doDelete}>Ta bort</Btn>
            </div>
          </div>
        </div>
      )}

      {/* Modal — lägg till reservation */}
      {showReserve&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.4)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:200,padding:20}} onClick={()=>setShowReserve(false)}>
          <div onClick={e=>e.stopPropagation()} style={{background:WH,borderRadius:14,padding:20,maxWidth:380,width:"100%"}}>
            <div style={{fontWeight:800,fontSize:16,marginBottom:4}}>Reservera del</div>
            <div style={{fontSize:12,color:MU,marginBottom:16}}>Reservera ett exemplar åt en kund. Det skyddas från försäljning tills det säljs till kunden eller av-reserveras. Ange registreringsnummer eller kund — minst ett av dem.</div>
            <div style={{display:"flex",flexDirection:"column",gap:12}}>
              <div>
                <label style={{fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7}}>Registreringsnummer</label>
                <input type="text" value={resForm.regNumber} onChange={e=>setResForm(f=>({...f,regNumber:formatRegNumber(e.target.value)}))} placeholder="ABC 123" autoFocus
                  style={{width:"100%",border:`1.5px solid ${BD}`,borderRadius:7,padding:"10px 12px",fontSize:15,fontWeight:700,letterSpacing:1,marginTop:4,fontFamily:"monospace"}}/>
              </div>
              <div>
                <label style={{fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7}}>Kund</label>
                <input type="text" value={resForm.customer} onChange={e=>setResForm(f=>({...f,customer:e.target.value}))} placeholder="Namn eller företag"
                  style={{width:"100%",border:`1.5px solid ${BD}`,borderRadius:7,padding:"9px 12px",fontSize:14,marginTop:4}}/>
              </div>
              <div>
                <label style={{fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7}}>Notering (valfritt)</label>
                <input type="text" value={resForm.note} onChange={e=>setResForm(f=>({...f,note:e.target.value}))} placeholder="t.ex. hämtas på fredag"
                  style={{width:"100%",border:`1.5px solid ${BD}`,borderRadius:7,padding:"9px 12px",fontSize:14,marginTop:4}}/>
              </div>
            </div>
            <div style={{display:"flex",gap:8,marginTop:18}}>
              <Btn full variant="ghost" onClick={()=>setShowReserve(false)}>Avbryt</Btn>
              <Btn full onClick={addReservation}><Icon name="bookmark"/> Reservera</Btn>
            </div>
          </div>
        </div>
      )}

      {/* Bekräfta av-reservation */}
      {confirmUnreserve&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.4)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:200,padding:20}} onClick={()=>setConfirmUnreserve(null)}>
          <div onClick={e=>e.stopPropagation()} style={{background:WH,borderRadius:14,padding:20,maxWidth:340,width:"100%"}}>
            <div style={{fontWeight:700,fontSize:15,marginBottom:8}}>Ta bort reservation?</div>
            <div style={{fontSize:13,color:MU,marginBottom:16}}>Reservationen för <strong style={{color:TX}}>{confirmUnreserve.regNumber}</strong>{confirmUnreserve.customer?` (${confirmUnreserve.customer})`:""} tas bort. Delen blir säljbar för alla igen.</div>
            <div style={{display:"flex",gap:8}}>
              <Btn full variant="ghost" onClick={()=>setConfirmUnreserve(null)}>Avbryt</Btn>
              <Btn full variant="red" onClick={()=>removeReservation(confirmUnreserve.id)}>Ta bort</Btn>
            </div>
          </div>
        </div>
      )}

      {/* Sälj till reserverad kund */}
      {sellToReserved&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.4)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:200,padding:20}} onClick={()=>setSellToReserved(null)}>
          <div onClick={e=>e.stopPropagation()} style={{background:WH,borderRadius:14,padding:20,maxWidth:360,width:"100%"}}>
            <div style={{fontWeight:800,fontSize:16,marginBottom:4}}>Sälj till reserverad kund</div>
            <div style={{fontSize:13,color:MU,marginBottom:16}}>
              Säljer till <strong style={{color:TX}}>{sellToReserved.regNumber}</strong>{sellToReserved.customer?` — ${sellToReserved.customer}`:""}. Reservationen tas bort när försäljningen är klar.
            </div>
            <div style={{display:"flex",gap:8}}>
              <Btn full variant="ghost" onClick={()=>setSellToReserved(null)}>Avbryt</Btn>
              <Btn full variant="red" onClick={()=>{
                const remaining = reservations.filter(r=>r.id!==sellToReserved.id);
                const updated = { ...item, reservations: remaining, updatedAt:Date.now() };
                saveOneItem(updated).then(res=>{ if(res) saveItems(res); else saveItems(items.map(i=>i.id===item.id?updated:i)); });
                push("sell",{ item:updated, maxQty:1, presetBuyer: sellToReserved.customer||sellToReserved.regNumber });
                setSellToReserved(null);
              }}><Icon name="tag"/> Fortsätt till försäljning</Btn>
            </div>
          </div>
        </div>
      )}

      {/* Bild i helskärm — tryck på bilden för att förstora */}
      {lightbox&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.92)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:300}}
          onClick={()=>setLightbox(false)} onTouchStart={handleTouchStart} onTouchEnd={handleTouchEnd}>
          <button onClick={()=>setLightbox(false)} style={{position:"absolute",top:16,right:16,background:"rgba(255,255,255,.15)",border:"none",borderRadius:"50%",width:40,height:40,color:"#fff",fontSize:20,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",zIndex:2}}>
            <i className="fa-solid fa-xmark"/>
          </button>
          {imgs.length>1&&<div style={{position:"absolute",top:16,left:16,background:"rgba(255,255,255,.15)",color:"#fff",borderRadius:20,padding:"6px 14px",fontSize:13,fontWeight:600}}>{idx+1}/{imgs.length}</div>}
          <img src={imgs[idx]} alt="" onClick={e=>e.stopPropagation()} style={{maxWidth:"92vw",maxHeight:"88vh",objectFit:"contain",borderRadius:6,userSelect:"none"}}/>
          {imgs.length>1&&<>
            <button onClick={e=>{e.stopPropagation();setIdx(i=>Math.max(0,i-1));}} style={{position:"absolute",left:16,top:"50%",transform:"translateY(-50%)",background:"rgba(255,255,255,.15)",border:"none",borderRadius:"50%",width:44,height:44,color:"#fff",fontSize:22,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>‹</button>
            <button onClick={e=>{e.stopPropagation();setIdx(i=>Math.min(imgs.length-1,i+1));}} style={{position:"absolute",right:16,top:"50%",transform:"translateY(-50%)",background:"rgba(255,255,255,.15)",border:"none",borderRadius:"50%",width:44,height:44,color:"#fff",fontSize:22,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>›</button>
          </>}
        </div>
      )}
    </Page>
  );
}

// ─── Filter Page ──────────────────────────────────────────────────────────────
function FilterPage({ items, filters, setFilters, lists, pop }) {
  const CATS = lists?.categories||CATEGORIES, CONDS = lists?.conditions||CONDITIONS, SIDS = lists?.sides||SIDES, WHS = lists?.warehouses||WAREHOUSES;
  const [f, setF] = useState({...filters});
  const toggle = (key, val) => setF(p=>({...p,[key]:p[key].includes(val)?p[key].filter(x=>x!==val):[...p[key],val]}));
  const set = (key,val) => setF(p=>({...p,[key]:val}));

  const allMakes     = ["", ...new Set(items.map(i=>i.make).filter(Boolean))].sort((a,b)=>a.localeCompare(b,"sv"));
  const allGroups    = ["", ...new Set(items.map(i=>getBrandGroup(i.make)).filter(Boolean))].sort();
  const allSuppliers = ["", ...new Set(items.map(i=>i.supplier).filter(Boolean))].sort((a,b)=>a.localeCompare(b,"sv"));
  const allLocTypes  = ["", ...new Set(items.map(i=>i.locationType).filter(Boolean))].sort();
  const allModels    = ["", ...new Set(items.map(i=>i.model).filter(Boolean))].sort((a,b)=>a.localeCompare(b,"sv"));

  const prices = items.map(i=>i.price||0).filter(p=>p>0);
  const globalMin = prices.length ? Math.floor(Math.min(...prices)/100)*100 : 0;
  const globalMax = prices.length ? Math.ceil(Math.max(...prices)/100)*100 : 100000;

  const pMin = f.priceMin !== "" ? Number(f.priceMin) : globalMin;
  const pMax = f.priceMax !== "" ? Number(f.priceMax) : globalMax;

  const condColors = {"Ny":GR,"Begagnad - Gott skick":BX,"Begagnad - Liten spricka":AM,"Begagnad - Kräver lackering":AM,"Reservdelar / Skrotning":R};

  const parseList = (str) => (str||"").split(",").map(s=>s.trim().toLowerCase()).filter(Boolean);
  const matchCount = items.filter(i => {
    const sn = parseList(f.stockNums), an = parseList(f.artNums);
    if (sn.length && !sn.includes((i.stockNumber||"").toLowerCase())) return false;
    if (an.length && !an.includes((i.oem||"").toLowerCase())) return false;
    if (f.reserved && !(i.reservations?.length>0)) return false;
    if (f.noImage && (i.hasImages>0 || i.images?.length>0 || i.thumb)) return false;
    if (f.cats.length&&!f.cats.includes(i.category)) return false;
    if (f.conds.length&&!f.conds.includes(i.condition)) return false;
    if (f.sides.length&&!f.sides.includes(i.side)) return false;
    if (f.make&&i.make!==f.make) return false;
    if (f.brandGroup&&getBrandGroup(i.make)!==f.brandGroup) return false;
    if (f.locationType&&i.locationType!==f.locationType) return false;
    if (f.model&&i.model!==f.model) return false;
    if (f.priceMin!==""&&i.price<Number(f.priceMin)) return false;
    if (f.priceMax!==""&&i.price>Number(f.priceMax)) return false;
    if (f.low&&i.quantity>3) return false;
    if (f.supplier&&i.supplier!==f.supplier) return false;
    return true;
  }).length;

  const Section = ({label,value})=>(
    <div style={{fontSize:11,fontWeight:700,color:value?BX:MU,textTransform:"uppercase",letterSpacing:1,margin:"18px 0 8px",paddingBottom:4,borderBottom:`1px solid ${value?B+"40":BD}`,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
      {label}
      {value&&<span style={{fontSize:10,fontWeight:600,color:BX,background:B+"15",borderRadius:10,padding:"1px 8px",textTransform:"none",letterSpacing:0}}>{value}</span>}
    </div>
  );

  const Chip = ({label,active,color=BX,onClick})=>(
    <button onClick={onClick} style={{padding:"6px 14px",borderRadius:20,border:`1.5px solid ${active?color:BD}`,background:active?color:WH,color:active?WH:TM,fontSize:12,fontWeight:600,whiteSpace:"nowrap",cursor:"pointer"}}>
      {label}
    </button>
  );

  const Dropdown = ({value, onChange, options, placeholder}) => (
    <select value={value} onChange={e=>onChange(e.target.value)}
      style={{width:"100%",padding:"10px 12px",border:`1.5px solid ${value?BX:BD}`,borderRadius:8,fontSize:13,color:value?BX:MU,background:WH,fontWeight:value?600:400,cursor:"pointer"}}>
      <option value="">{placeholder}</option>
      {options.filter(Boolean).map(o=><option key={o} value={o}>{o}</option>)}
    </select>
  );

  const apply = () => { setFilters(f); pop(); };
  const clear = () => {
    const empty={cats:[],conds:[],sides:[],make:"",brandGroup:"",locationType:"",model:"",yearMin:"",yearMax:"",priceMin:"",priceMax:"",low:false,supplier:"",stockNums:"",artNums:"",reserved:false,noImage:false,warehouse:""};
    setF(empty); setFilters(empty);
  };

  const right = <button onClick={clear} style={{background:"none",border:"none",color:R,fontWeight:600,fontSize:13}}>Rensa</button>;

  return (
    <div className="page" style={{position:"absolute",inset:0,display:"flex",flexDirection:"column",background:BG}}>
      <TopBar title="Filter" onBack={pop} right={right} />
      <div style={{flex:1,overflowY:"auto",WebkitOverflowScrolling:"touch",padding:"0 14px 20px"}}>
        <div style={{fontSize:13,color:MU,padding:"12px 0"}}>Matchar <strong style={{color:TX}}>{matchCount}</strong> av {items.length} delar</div>

        {/* Lagernummer & artikelnummer — flera med komma */}
        <Section label="Lagernummer" value={f.stockNums?"aktivt":""} />
        <input value={f.stockNums||""} onChange={e=>set("stockNums",e.target.value)} placeholder="t.ex. 11, 15, 23"
          style={{width:"100%",padding:"10px 12px",border:`1.5px solid ${f.stockNums?BX:BD}`,borderRadius:8,fontSize:13,boxSizing:"border-box",background:f.stockNums?B+"08":WH}}/>
        <div style={{fontSize:11,color:MU,marginTop:4}}>Visa bara delar med dessa lagernummer (flera separeras med komma).</div>

        <Section label="Artikelnummer" value={f.artNums?"aktivt":""} />
        <input value={f.artNums||""} onChange={e=>set("artNums",e.target.value.toUpperCase())} placeholder="t.ex. 8K0945095, 4G8867409"
          style={{width:"100%",padding:"10px 12px",border:`1.5px solid ${f.artNums?BX:BD}`,borderRadius:8,fontSize:13,boxSizing:"border-box",background:f.artNums?B+"08":WH,fontFamily:"monospace"}}/>
        <div style={{fontSize:11,color:MU,marginTop:4}}>Visa bara delar med dessa artikelnummer (flera separeras med komma).</div>

        {/* Snabbval */}
        <Section label="Snabbval" value={[f.low,f.reserved,f.noImage].filter(Boolean).length?`${[f.low,f.reserved,f.noImage].filter(Boolean).length} valda`:""} />
        <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
          <Chip label="Lågt lager" active={!!f.low} color={R} onClick={()=>set("low",!f.low)}/>
          <Chip label="Reserverade" active={!!f.reserved} color={AM} onClick={()=>set("reserved",!f.reserved)}/>
          <Chip label="Utan bild" active={!!f.noImage} onClick={()=>set("noImage",!f.noImage)}/>
        </div>

        {/* Kategori — chips */}
        <Section label="Kategori" value={f.cats.length?`${f.cats.length} valda`:""} />
        <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
          {CATS.map(c=><Chip key={c} label={c} active={f.cats.includes(c)} onClick={()=>toggle("cats",c)}/>)}
        </div>

        {/* Skick — chips med färg */}
        <Section label="Skick" value={f.conds.length?`${f.conds.length} valda`:""} />
        <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
          {CONDS.map(c=><Chip key={c} label={c} active={f.conds.includes(c)} color={condColors[c]||MU} onClick={()=>toggle("conds",c)}/>)}
        </div>

        {/* Sida — chips */}
        <Section label="Sida" value={f.sides.length?`${f.sides.length} valda`:""} />
        <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
          {SIDS.filter(Boolean).map(s=><Chip key={s} label={s} active={f.sides.includes(s)} onClick={()=>toggle("sides",s)}/>)}
        </div>

        {/* Koncern — dropdown */}
        <Section label="Koncern" value={f.brandGroup||""} />
        <Dropdown value={f.brandGroup} onChange={v=>set("brandGroup",v)} options={allGroups} placeholder="Alla koncerner" />

        {/* Tillverkare — dropdown */}
        <Section label="Tillverkare" value={f.make||""} />
        <Dropdown value={f.make} onChange={v=>set("make",v)} options={allMakes} placeholder="Alla tillverkare" />

        {/* Modell — dropdown */}
        <Section label="Modell" value={f.model||""} />
        <Dropdown value={f.model} onChange={v=>set("model",v)} options={allModels} placeholder="Alla modeller" />

        {/* Placeringstyp — dropdown */}
        <Section label="Placeringstyp" value={f.locationType||""} />
        <Dropdown value={f.locationType} onChange={v=>set("locationType",v)} options={allLocTypes} placeholder="Alla placeringstyper" />

        <Section label="Lager (ort)" value={f.warehouse||""} />
        <Dropdown value={f.warehouse} onChange={v=>set("warehouse",v)} options={["",...WHS]} placeholder="Alla lager" />

        {/* Leverantör — dropdown */}
        <Section label="Leverantör" value={f.supplier||""} />
        <Dropdown value={f.supplier} onChange={v=>set("supplier",v)} options={allSuppliers} placeholder="Alla leverantörer" />

        {/* Pris — range slider */}
        <Section label="Pris (kr)" value={(f.priceMin!==""||f.priceMax!=="")?`${pMin.toLocaleString("sv-SE")} – ${pMax.toLocaleString("sv-SE")} kr`:""} />
        <div style={{padding:"0 6px"}}>
          <div style={{display:"flex",justifyContent:"space-between",fontSize:12,color:MU,marginBottom:8}}>
            <span style={{fontWeight:600,color:BX}}>{pMin.toLocaleString("sv-SE")} kr</span>
            <span style={{fontWeight:600,color:BX}}>{pMax.toLocaleString("sv-SE")} kr</span>
          </div>
          {/* Min slider */}
          <div style={{position:"relative",height:36}}>
            <div style={{position:"absolute",top:"50%",left:0,right:0,height:4,background:BD,borderRadius:2,transform:"translateY(-50%)"}}>
              <div style={{position:"absolute",left:`${((pMin-globalMin)/(globalMax-globalMin||1))*100}%`,right:`${100-((pMax-globalMin)/(globalMax-globalMin||1))*100}%`,height:"100%",background:BX,borderRadius:2}}/>
            </div>
            <input type="range" min={globalMin} max={globalMax} step={100} value={pMin}
              onChange={e=>{const v=Number(e.target.value); if(v<=pMax) set("priceMin",String(v));}}
              style={{position:"absolute",width:"100%",height:"100%",opacity:0,cursor:"pointer",zIndex:2}}/>
            <input type="range" min={globalMin} max={globalMax} step={100} value={pMax}
              onChange={e=>{const v=Number(e.target.value); if(v>=pMin) set("priceMax",String(v));}}
              style={{position:"absolute",width:"100%",height:"100%",opacity:0,cursor:"pointer",zIndex:3}}/>
          </div>
          {(f.priceMin!==""||f.priceMax!=="")&&(
            <button onClick={()=>{set("priceMin","");set("priceMax","");}} style={{background:"none",border:"none",color:MU,fontSize:11,cursor:"pointer",textDecoration:"underline",display:"block",marginTop:4}}>Rensa pris</button>
          )}
        </div>

        {/* Lagerstatus */}
        <Section label="Lagerstatus" value={f.low?"Låglager":""} />
        <Chip label="Visa bara låglager (≤3 st)" active={f.low} color={R} onClick={()=>set("low",!f.low)} />

      </div>

      <div style={{flexShrink:0,padding:"12px 14px",background:WH,borderTop:`1px solid ${BD}`,boxShadow:"0 -4px 12px rgba(0,0,0,.08)"}}>
        <Btn full onClick={apply} style={{padding:"13px"}}>Visa {matchCount} delar</Btn>
      </div>
    </div>
  );
}

// ─── Edit Page helpers (defined outside to avoid remount on every keystroke) ──
const G2 = ({children}) => <div style={{display:"flex",gap:10,marginBottom:12}}>{children}</div>;
const H = ({children}) => <div style={{flex:1,minWidth:0}}>{children}</div>;

// ─── Edit Page ────────────────────────────────────────────────────────────────
function EditPage({ item, items, saveItems, lists, pop, push, toast$, currentUser, logActivity, trash }) {
  const CATS = lists?.categories||CATEGORIES, CONDS = lists?.conditions||CONDITIONS, SIDS = lists?.sides||SIDES, LOCTYPES = lists?.locationTypes||LOCATION_TYPES, WHS = lists?.warehouses||WAREHOUSES;
  // Lagernummer som ligger i papperskorgen räknas som upptagna tills de
  // rensas permanent — annars skulle en ny del kunna kapa numret från en
  // del som väntar på att återställas. Se src/calc.mjs (testad funktion).
  const [f, setF] = useState(item ? {...item, alternativeNumbers: item.alternativeNumbers||[]} : {name:"",stockNumber:nextAvailableStockNumber(items, trash), side:"",category:"Skärmar",quantity:1,price:0,costPrice:0,supplier:"",location:"",warehouse:"",weight:"",colorCode:"",oem:"",alternativeNumbers:[],description:"",condition:"Begagnad - Gott skick",compatible:"",make:"",model:"",yearFrom:"",yearTo:"",regNumber:"",notes:"",images:[]});
  // Pris exkl. moms (härlett från lagrat inkl-moms-pris; 25% moms)
  const [priceExVat, setPriceExVat] = useState(item && item.price ? String(inclVatToExVat(item.price)) : "");
  const set = (k,v) => setF(p=>({...p,[k]:v}));
  const fRef = useRef(); const cRef = useRef();

  // Laholm får en egen lagernummer-serie (LH1, LH2, …) — helt skild från
  // den vanliga sifferserien, krockar aldrig. Andra lager (Halmstad m.fl.)
  // fortsätter med vanliga siffror som innan.
  const stockPrefixFor = (wh) => wh === "Laholm" ? "LH" : "";
  // Håller reda på om lagernumret fortfarande är det AUTOMATISKT föreslagna
  // — bara då räknas det om när man byter lager. Har man redan skrivit in
  // ett eget nummer för hand rörs det inte.
  const stockNumberAuto = useRef(!item?.id);
  const setWarehouse = (wh) => {
    setF(p => {
      const next = { ...p, warehouse: wh };
      if (!item?.id && stockNumberAuto.current) {
        next.stockNumber = nextAvailableStockNumber(items, trash, stockPrefixFor(wh));
      }
      return next;
    });
  };

  // Snabbtillägg — om KGK-integrationen är påslagen, visa bara de sex
  // fält som verkligen skiljer sig mellan delar; resten hämtas från KGK.
  const [kgkEnabled, setKgkEnabled] = useState(false);
  useEffect(() => { sget("ow:kgkconfig").then(v => setKgkEnabled(!!v?.enabled)); }, []);
  const quickAddMode = !item?.id && kgkEnabled;

  // ── Redigeringslås ──────────────────────────────────────────────────────────
  const [lockState, setLockState] = useState(null); // null=okänt, {ok}|{blocked}
  const [waitingUser, setWaitingUser] = useState(null);
  const me = currentUser?.username || "Okänd";

  useEffect(() => {
    if (!item?.id) { setLockState({ ok: true }); return; } // ny del — inget lås behövs
    let active = true;
    let hbInterval = null;
    (async () => {
      const r = await lockAcquire(item.id, me, "edit");
      if (!active) return;
      if (r.ok) {
        setLockState({ ok: true });
        // Heartbeat var 30:e sek — håller låset vid liv + kollar om någon väntar
        hbInterval = setInterval(async () => {
          const h = await lockHeartbeat(item.id, me);
          if (h.waitingUser) setWaitingUser(h.waitingUser);
        }, 30000);
      } else {
        setLockState({ blocked: true, by: r.lockedBy, action: r.action, remainingMs: r.remainingMs });
      }
    })();
    return () => {
      active = false;
      if (hbInterval) clearInterval(hbInterval);
      if (item?.id) lockRelease(item.id, me); // släpp låset när man går ut
    };
  }, [item?.id]);

  // Ladda befintliga bilder (snabb endpoint)
  useEffect(() => {
    if (item?.id && (!item.images || item.images.length===0) && item.hasImages > 0) {
      (async () => {
        const imgs = await getImages(item.id);
        if (imgs?.length) setF(p => ({...p, images: imgs}));
      })();
    }
  }, [item?.id]);

  // ── Duplicate detection (lagernummer via testad funktion, se src/calc.mjs) ──
  const otherItems = items.filter(i => i.id !== f.id);
  const stockCheck = checkStockNumberTaken(f.stockNumber, items, trash||[], f.id);
  const dupStockNumber = stockCheck.taken ? stockCheck.item : null;
  const dupStockNumberTrash = stockCheck.taken && stockCheck.byTrash ? stockCheck.item : null;
  const dupOem        = f.oem?.trim()         && otherItems.find(i => i.oem?.trim().toLowerCase() === f.oem?.trim().toLowerCase());

  const DupWarning = ({ dup, label }) => dup ? (
    <div onClick={()=>pop() || push?.("detail",{item:dup})} style={{background:AM+"1A",border:`1.5px solid ${AM}`,borderRadius:8,padding:"8px 12px",marginTop:4,cursor:"pointer",display:"flex",alignItems:"center",gap:8}}>
      <Icon name="triangle-exclamation" style={{color:AM,flexShrink:0}}/>
      <div style={{flex:1}}>
        <div style={{fontSize:11,fontWeight:700,color:AM}}>⚠ {label} finns redan på: <strong>{dup.name}{dup.side?` — ${dup.side}`:""}</strong> #{dup.stockNumber||"—"}</div>
        <div style={{fontSize:10,color:AM,marginTop:1}}>Tryck för att se den artikeln</div>
      </div>
    </div>
  ) : null;

  // Komprimera bilden innan den sparas — minskar storleken drastiskt
  const compressImage = (file) => new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = e => {
      const img = new Image();
      img.onload = () => {
        // Skala ner till max 1000px bredd, behåll proportioner
        const maxW = 1000;
        const scale = Math.min(1, maxW / img.width);
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, w, h);
        // JPEG med 70% kvalitet — mycket mindre än original
        resolve(canvas.toDataURL("image/jpeg", 0.7));
      };
      img.onerror = () => resolve(e.target.result);
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
  // Tar en FileList (flera bilder samtidigt) eller en enstaka fil.
  // Använder funktionell uppdatering så bilderna inte skriver över varandra
  // när flera väljs på en gång.
  const addImg = async (files) => {
    const list = files ? Array.from(files) : [];
    if (!list.length) return;
    const compressed = await Promise.all(list.map(compressImage));
    setF(p => ({ ...p, images: [...(p.images || []), ...compressed] }));
  };
  const rmImg = i => set("images",f.images.filter((_,idx)=>idx!==i));
  // ── Dra-och-släpp för bildordning (fungerar med både mus och touch) ──
  const [dragImgIdx, setDragImgIdx] = useState(null);
  const startImgDrag = (e, i) => {
    setDragImgIdx(i);
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
  };
  const onImgDragMove = (e) => {
    if (dragImgIdx===null) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const thumb = el?.closest("[data-imgidx]");
    if (!thumb) return;
    const idx = Number(thumb.getAttribute("data-imgidx"));
    if (Number.isNaN(idx) || idx===dragImgIdx) return;
    setF(p => {
      const imgs = [...(p.images||[])];
      const [moved] = imgs.splice(dragImgIdx,1);
      imgs.splice(idx,0,moved);
      return {...p, images:imgs};
    });
    setDragImgIdx(idx);
  };
  const endImgDrag = () => setDragImgIdx(null);

  const missing = [];
  if (!f.name?.trim()) missing.push("Namn");
  if (!f.oem?.trim()) missing.push("Artikelnummer");
  if (!f.location?.trim()) missing.push("Lagerplats");
  if (!f.stockNumber?.trim()) missing.push("Lagernummer");
  if (!f.warehouse?.trim()) missing.push("Lager (ort)");

  // Snabbtillägg: artikelnummer + lagernummer + placering + regnr + pris +
  // notering är allt du skriver in — resten (namn, kategori, märke, modell,
  // år, alt.nr) hämtas automatiskt från KGK baserat på artikelnumret.
  const quickMissing = [];
  if (!f.oem?.trim()) quickMissing.push("Artikelnummer");
  if (!f.stockNumber?.trim()) quickMissing.push("Lagernummer");
  if (!f.location?.trim()) quickMissing.push("Placering");
  if (!f.warehouse?.trim()) quickMissing.push("Lager (ort)");
  const [quickSaving, setQuickSaving] = useState(false);

  const quickSave = async () => {
    if (quickMissing.length>0) { toast$(`Saknas: ${quickMissing.join(", ")}`,"error"); return; }
    if (dupStockNumber) { toast$(dupStockNumberTrash ? `Lagernr ${f.stockNumber} ligger i papperskorgen — kan inte återanvändas ännu` : `Lagernr ${f.stockNumber} används redan!`,"error"); return; }
    setQuickSaving(true);

    // Hämta märke/modell/år/kategori/namn/alt.nr från KGK baserat på artikelnumret
    let kgkFields = {};
    try {
      const r = await fetch("/admin/api/kgk/lookup", {
        method:"POST", headers: authHeaders({"Content-Type":"application/json"}),
        body: JSON.stringify({ oem: f.oem })
      }).then(r=>r.json());
      if (r.ok && r.found) {
        kgkFields = {
          name: r.name || f.name || f.oem,
          category: r.category || f.category,
          make: r.make || "", model: r.model || "",
          yearFrom: r.yearFrom || "", yearTo: r.yearTo || "",
          alternativeNumbers: r.alternativeNumbers || [],
          kgkStatus: "found", kgkLastChecked: Date.now(),
        };
      } else {
        kgkFields = { name: f.name || f.oem, kgkStatus: "not_found", kgkLastChecked: Date.now() };
      }
    } catch {
      kgkFields = { name: f.name || f.oem, kgkStatus: "error", kgkLastChecked: Date.now() };
    }

    const merged = { ...f, ...kgkFields };
    const autoSku = merged.oem.trim().toLowerCase().replace(/[^a-z0-9]/g,"");
    const normalizedMake = normalizeMake(merged.make);
    const id = merged.id || genId("item");
    const imgs = merged.images || [];
    await setImages(id, imgs);
    const thumb = imgs.length > 0 ? await makeThumbnail(imgs[0]) : null;
    const payload = { ...merged, id, oem: (merged.oem||'').toUpperCase().trim(), sku: autoSku, make: normalizedMake, updatedAt: Date.now(), images: [], hasImages: imgs.length, thumb };

    const updated = await saveOneItem(payload);
    if (updated) saveItems(updated);
    else await saveItems([...items,payload]);
    logActivity&&logActivity("add", `La till ${payload.name}${payload.stockNumber?` (#${payload.stockNumber})`:""} via KGK-snabbtillägg`, { user: currentUser?.username, itemName:payload.name, stockNumber:payload.stockNumber });
    setQuickSaving(false);
    toast$(kgkFields.kgkStatus==="found" ? "Tillagd — data hämtad från KGK" : "Tillagd — ej hittad hos KGK, fyll i resten manuellt","success");
    pop();
  };

  const save = async () => {
    if (missing.length>0) { toast$(`Saknas: ${missing.join(", ")}`,"error"); return; }
    if (dupStockNumber) { toast$(dupStockNumberTrash ? `Lagernr ${f.stockNumber} ligger i papperskorgen — kan inte återanvändas ännu` : `Lagernr ${f.stockNumber} används redan!`,"error"); return; }
    const autoSku = f.oem.trim().toLowerCase().replace(/[^a-z0-9]/g,"");
    const normalizedMake = normalizeMake(f.make);
    const id = f.id || genId("item");

    // Spara bilderna separat via snabb endpoint — håll items-listan liten
    const imgs = f.images || [];
    await setImages(id, imgs);
    // Skapa en liten thumbnail för kortet (några KB, håller listan snabb)
    const thumb = imgs.length > 0 ? await makeThumbnail(imgs[0]) : null;
    const payload = { ...f, id, oem: (f.oem||'').toUpperCase().trim(), sku: autoSku, make: normalizedMake, updatedAt: Date.now(), images: [], hasImages: imgs.length, thumb };

    const updated = await saveOneItem(payload);
    if (updated) { saveItems(updated); toast$(f.id?"Uppdaterad":"Tillagd","success"); }
    else {
      if (f.id) await saveItems(items.map(i=>i.id===f.id?payload:i));
      else await saveItems([...items,payload]);
      toast$(f.id?"Uppdaterad":"Tillagd","success");
    }
    logActivity&&logActivity(f.id?"edit":"add", `${f.id?"Redigerade":"La till"} ${payload.name}${payload.stockNumber?` (#${payload.stockNumber})`:""}`, { user: currentUser?.username, itemName:payload.name, stockNumber:payload.stockNumber });
    pop();
  };

  const saveAndNew = async () => {
    if (missing.length>0) { toast$(`Saknas: ${missing.join(", ")}`,"error"); return; }
    if (dupStockNumber) { toast$(dupStockNumberTrash ? `Lagernr ${f.stockNumber} ligger i papperskorgen — kan inte återanvändas ännu` : `Lagernr ${f.stockNumber} används redan!`,"error"); return; }
    const autoSku = f.oem.trim().toLowerCase().replace(/[^a-z0-9]/g,"");
    const normalizedMake = normalizeMake(f.make);
    const id = f.id || genId("item");

    const imgs = f.images || [];
    await setImages(id, imgs);
    const thumb = imgs.length > 0 ? await makeThumbnail(imgs[0]) : null;
    const payload = { ...f, id, oem: (f.oem||'').toUpperCase().trim(), sku: autoSku, make: normalizedMake, updatedAt: Date.now(), images: [], hasImages: imgs.length, thumb };

    const updated = await saveOneItem(payload);
    const newList = updated || (f.id ? items.map(i=>i.id===f.id?payload:i) : [...items,payload]);
    saveItems(newList);
    toast$("Sparad — fyll i nästa exemplar","success");

    const used = new Set(newList.map(i => parseInt(i.stockNumber||"0")).filter(n=>!isNaN(n)&&n>0));
    let n = 1; while (used.has(n)) n++;

    setF({ ...f, id: undefined, stockNumber: String(n), quantity: 1, images: [], regNumber: "" });
    window.scrollTo(0, 0);
  };

  const R2 = <Btn small onClick={save} style={{padding:"5px 14px"}}>Spara</Btn>;

  // Blockerad — någon annan redigerar/säljer delen
  if (lockState?.blocked) {
    const actionText = lockState.action === "cart" ? "har den i sin kassa" : "redigerar den här delen";
    return (
      <Page noAnim>
        <TopBar title="Delen är upptagen" onBack={pop} />
        <div style={{padding:"40px 24px",display:"flex",flexDirection:"column",alignItems:"center",textAlign:"center",gap:16}}>
          <div style={{width:72,height:72,borderRadius:"50%",background:AM+"18",display:"flex",alignItems:"center",justifyContent:"center"}}>
            <Icon name="lock" style={{fontSize:30,color:AM}}/>
          </div>
          <div>
            <div style={{fontWeight:800,fontSize:18,color:TX,marginBottom:6}}>{lockState.by} {actionText}</div>
            <div style={{fontSize:14,color:MU,lineHeight:1.5,maxWidth:320}}>
              Du kan inte ändra den här delen just nu. Den blir tillgänglig automatiskt om <strong style={{color:AM}}>{fmtLockTime(lockState.remainingMs)}</strong> om {lockState.by} inte blir klar innan dess.
            </div>
          </div>
          <Btn variant="ghost" onClick={pop}><Icon name="arrow-left"/> Tillbaka</Btn>
        </div>
      </Page>
    );
  }

  // ── Snabbtillägg — bara artikelnummer, lagernummer, placering, regnr, pris, notering ──
  if (quickAddMode) {
    return (
      <Page noAnim>
        <TopBar title="Ny del — KGK-snabbtillägg" onBack={pop}/>
        <div style={{padding:"14px 14px 100px"}}>
          <div style={{background:GR+"12",border:`1px solid ${GR}40`,borderRadius:10,padding:12,marginBottom:16,display:"flex",alignItems:"center",gap:10}}>
            <Icon name="bolt" style={{color:GR,fontSize:18,flexShrink:0}}/>
            <div style={{fontSize:12,color:TM}}>KGK-integrationen är på — namn, kategori, märke, modell, år och alternativa nummer hämtas automatiskt utifrån artikelnumret när du sparar.</div>
          </div>

          <div style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,padding:14,marginBottom:12,display:"flex",flexDirection:"column",gap:12}}>
            <Inp label="Artikelnummer (OEM) *" value={f.oem} onChange={e=>set("oem",e.target.value.toUpperCase())} placeholder="t.ex. 8Y0941034"/>

            {/* Fler artikelnummer — samma del kan ha flera giltiga OEM-nummer
                (t.ex. olika årsmodeller/marknader). Sparas i alternativeNumbers,
                samma fält KGK-integrationen redan fyller i automatiskt. */}
            <div>
              <label style={{display:"block",fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:6}}>Fler artikelnummer (valfritt)</label>
              {(f.alternativeNumbers||[]).map((num,idx)=>(
                <div key={idx} style={{display:"flex",gap:6,marginBottom:6}}>
                  <input value={num} onChange={e=>{
                    const next=[...f.alternativeNumbers]; next[idx]=e.target.value.toUpperCase(); set("alternativeNumbers",next);
                  }} placeholder="t.ex. 8Y0941024" style={{flex:1,padding:"9px 12px",border:`1.5px solid ${BD}`,borderRadius:7,fontSize:13,fontFamily:"monospace"}}/>
                  <button onClick={()=>set("alternativeNumbers",f.alternativeNumbers.filter((_,i)=>i!==idx))} style={{background:"none",border:"none",color:MU,cursor:"pointer",padding:"0 8px",fontSize:16}}>×</button>
                </div>
              ))}
              <button onClick={()=>set("alternativeNumbers",[...(f.alternativeNumbers||[]),""])} style={{display:"flex",alignItems:"center",gap:6,background:"none",border:`1.5px dashed ${BD}`,borderRadius:7,padding:"8px 12px",color:BX,fontSize:12,fontWeight:700,cursor:"pointer",width:"100%",justifyContent:"center"}}>
                <Icon name="plus"/> Lägg till artikelnummer
              </button>
            </div>

            <Inp label="Lagernummer *" value={f.stockNumber} onChange={e=>{stockNumberAuto.current=false;set("stockNumber",e.target.value);}}/>
            {dupStockNumber&&<div style={{background:"rgba(255,107,107,.15)",borderRadius:6,padding:"6px 10px",fontSize:11,fontWeight:700,color:R}}><i className="fa-solid fa-triangle-exclamation"/> {dupStockNumberTrash ? <>Ligger i papperskorgen ({dupStockNumberTrash.name})</> : <>Används redan av {dupStockNumber.name}</>}</div>}
            <Sel label="Lager (ort) *" value={f.warehouse||""} onChange={e=>setWarehouse(e.target.value)} options={["",...WHS]}/>
            <G2>
              <H><Sel label="Placeringstyp" value={f.locationType||""} onChange={e=>set("locationType",e.target.value)} options={["",...LOCTYPES]}/></H>
              <H><Inp label="Placering *" value={f.location} onChange={e=>set("location",e.target.value)} placeholder="Hylla / plats"/></H>
            </G2>
            <Inp label="Var finns den här platsen? (valfritt)" value={f.parentLocation||""} onChange={e=>set("parentLocation",e.target.value)} placeholder="T.ex. Hisshylla 2 — om Låda 1 finns flera ställen"/>
            <Inp label="Regnummer (om känt)" value={f.regNumber} onChange={e=>set("regNumber",formatRegNumber(e.target.value))} placeholder="Bilen delen kom ifrån"/>
            <Inp label="Pris (kr, inkl. moms)" type="number" min="0" value={f.price} onChange={e=>set("price",Number(e.target.value))}/>
            <div>
              <label style={{display:"block",fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:4}}>Notering</label>
              <textarea value={f.notes} onChange={e=>set("notes",e.target.value)} rows={2} placeholder="Skador, skick, övrigt..."
                style={{width:"100%",border:`1.5px solid ${BD}`,borderRadius:7,padding:"9px 12px",fontSize:13,fontFamily:"inherit",resize:"vertical",boxSizing:"border-box"}}/>
            </div>
          </div>

          <button onClick={()=>push("edit",{item:{...f}})} style={{background:"none",border:"none",color:BX,fontSize:12,fontWeight:600,cursor:"pointer",padding:0}}>
            Fyll i alla fält manuellt istället →
          </button>
        </div>

        <div style={{position:"fixed",bottom:0,left:0,right:0,background:WH,borderTop:`1px solid ${BD}`,padding:"12px 14px",paddingBottom:"max(12px,env(safe-area-inset-bottom))"}}>
          <Btn full variant="red" onClick={quickSave} disabled={quickSaving}>
            {quickSaving ? <><Icon name="spinner"/> Hämtar från KGK…</> : <><Icon name="bolt"/> Spara och hämta från KGK</>}
          </Btn>
        </div>
      </Page>
    );
  }

  return (
    <Page noAnim>
      <TopBar title={item?"Redigera del":"Ny karossedel"} onBack={pop} right={R2} />
      <div style={{padding:"14px 14px 60px"}}>

        {/* Banner — någon väntar på delen */}
        {waitingUser&&(
          <div style={{background:AM+"15",border:`1.5px solid ${AM}`,borderRadius:10,padding:"10px 14px",marginBottom:12,display:"flex",alignItems:"center",gap:10}}>
            <Icon name="clock" style={{color:AM,fontSize:18}}/>
            <div style={{fontSize:13,color:TX,fontWeight:600}}><strong>{waitingUser}</strong> väntar på den här delen — spara och gå ut när du är klar.</div>
          </div>
        )}

        {/* De 4 obligatoriska fälten — samlade högst upp för smidigast möjliga flöde */}
        <div style={{background:BX,borderRadius:10,padding:14,marginBottom:12}}>
          <div style={{fontSize:10,fontWeight:700,color:"rgba(255,255,255,.65)",textTransform:"uppercase",letterSpacing:.7,marginBottom:10}}>Obligatoriskt</div>
          <div style={{display:"flex",flexDirection:"column",gap:8}}>
            <div>
              <input type="text" value={f.name} onChange={e=>set("name",e.target.value)} placeholder="Namn på delen *"
                style={{width:"100%",border:`1.5px solid ${!f.name?.trim()?"#FF6B6B":"rgba(255,255,255,.3)"}`,borderRadius:7,padding:"9px 12px",fontSize:14,fontWeight:600,color:WH,background:"rgba(255,255,255,.12)"}}/>
            </div>
            <div style={{display:"flex",gap:8}}>
              <input type="text" value={f.oem} onChange={e=>set("oem",e.target.value.toUpperCase())} placeholder="Artikelnummer *"
                style={{flex:1,border:`1.5px solid ${(!f.oem?.trim()||dupOem)?"#FF6B6B":"rgba(255,255,255,.3)"}`,borderRadius:7,padding:"9px 12px",fontSize:13,fontWeight:600,color:WH,background:"rgba(255,255,255,.12)"}}/>
              <input type="text" value={f.stockNumber||""} onChange={e=>{stockNumberAuto.current=false;set("stockNumber",e.target.value);}} placeholder="Lagernr *"
                style={{width:100,border:`1.5px solid ${(!f.stockNumber?.trim()||dupStockNumber)?"#FF6B6B":"rgba(255,255,255,.3)"}`,borderRadius:7,padding:"9px 12px",fontSize:13,fontWeight:800,color:WH,background:"rgba(255,255,255,.12)",textAlign:"center"}}/>
            </div>
            <div style={{display:"flex",gap:8}}>
              <select value={f.locationType||""} onChange={e=>set("locationType",e.target.value)}
                style={{width:130,border:`1.5px solid rgba(255,255,255,.3)`,borderRadius:7,padding:"9px 10px",fontSize:13,fontWeight:600,color:WH,background:"rgba(255,255,255,.15)"}}>
                {LOCTYPES.map(t=><option key={t} value={t} style={{background:"#1B3A6B",color:WH}}>{t||"Typ av plats"}</option>)}
              </select>
              <input type="text" value={f.location} onChange={e=>set("location",e.target.value)} placeholder="Placering *"
                style={{flex:1,border:`1.5px solid ${!f.location?.trim()?"#FF6B6B":"rgba(255,255,255,.3)"}`,borderRadius:7,padding:"9px 12px",fontSize:13,fontWeight:600,color:WH,background:"rgba(255,255,255,.12)"}}/>
            </div>
            <select value={f.warehouse||""} onChange={e=>setWarehouse(e.target.value)}
              style={{width:"100%",border:`1.5px solid ${!f.warehouse?.trim()?"#FF6B6B":"rgba(255,255,255,.3)"}`,borderRadius:7,padding:"9px 10px",fontSize:13,fontWeight:600,color:WH,background:"rgba(255,255,255,.15)"}}>
              <option value="" style={{background:"#1B3A6B",color:WH}}>Vilket lager (ort)? *</option>
              {WHS.map(w=><option key={w} value={w} style={{background:"#1B3A6B",color:WH}}>{w}</option>)}
            </select>
          </div>
          {dupOem&&<div style={{background:"rgba(255,107,107,.2)",borderRadius:6,padding:"6px 10px",marginTop:8,fontSize:11,fontWeight:700,color:"#FFE0E0"}}><i className="fa-solid fa-triangle-exclamation"/> Artikelnummer finns redan på: {dupOem.name} #{dupOem.stockNumber}</div>}
          {dupStockNumber&&<div style={{background:"rgba(255,107,107,.2)",borderRadius:6,padding:"6px 10px",marginTop:8,fontSize:11,fontWeight:700,color:"#FFE0E0"}}><i className="fa-solid fa-triangle-exclamation"/> {dupStockNumberTrash ? <>Lagernr {f.stockNumber} tillhör {dupStockNumberTrash.name}, som ligger i papperskorgen — kan inte återanvändas förrän den är permanent borttagen</> : <>Lagernr {f.stockNumber} används redan av: {dupStockNumber.name}</>}</div>}
        </div>

        {/* Images */}
        <div style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,padding:14,marginBottom:12}}>
          <div style={{fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:10}}>Bilder{(f.images||[]).length>1?" — dra för att ändra ordning, första bilden blir omslag":""}</div>
          <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
            {(f.images||[]).map((img,i)=>(
              <div key={i} data-imgidx={i}
                onPointerDown={e=>startImgDrag(e,i)}
                onPointerMove={onImgDragMove}
                onPointerUp={endImgDrag}
                onPointerCancel={endImgDrag}
                style={{position:"relative",touchAction:"none",cursor:dragImgIdx===i?"grabbing":"grab",opacity:dragImgIdx===i?0.5:1,transition:"opacity .1s"}}>
                <img src={img} alt="" draggable={false} style={{width:70,height:70,objectFit:"cover",borderRadius:8,border:`1px solid ${i===0?BX:BD}`,pointerEvents:"none"}}/>
                {i===0&&<div style={{position:"absolute",bottom:-6,left:0,right:0,textAlign:"center",pointerEvents:"none"}}><span style={{background:BX,color:WH,fontSize:8,fontWeight:800,borderRadius:4,padding:"1px 5px"}}>OMSLAG</span></div>}
                <div style={{position:"absolute",top:2,left:2,width:16,height:16,borderRadius:4,background:"rgba(0,0,0,.35)",display:"flex",alignItems:"center",justifyContent:"center",pointerEvents:"none"}}>
                  <i className="fa-solid fa-grip-vertical" style={{fontSize:9,color:"rgba(255,255,255,.9)"}}/>
                </div>
                <button onPointerDown={e=>e.stopPropagation()} onClick={()=>rmImg(i)} style={{position:"absolute",top:-6,right:-6,background:R,color:WH,border:"none",borderRadius:"50%",width:20,height:20,fontSize:11,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer"}}>×</button>
              </div>
            ))}
            <button onClick={()=>fRef.current.click()} title="Välj en eller flera bilder" style={{width:70,height:70,borderRadius:8,border:`1.5px dashed ${BD}`,background:BG,color:MU,fontSize:20,display:"flex",alignItems:"center",justifyContent:"center"}}><Icon name="plus"/></button>
            <button onClick={()=>cRef.current.click()} style={{width:70,height:70,borderRadius:8,border:`1.5px dashed ${BD}`,background:BG,color:MU,fontSize:20,display:"flex",alignItems:"center",justifyContent:"center"}}><Icon name="camera"/></button>
          </div>
          <input ref={fRef} type="file" accept="image/*" multiple style={{display:"none"}} onChange={e=>addImg(e.target.files)}/>
          <input ref={cRef} type="file" accept="image/*" capture="environment" style={{display:"none"}} onChange={e=>addImg(e.target.files)}/>
        </div>

        {/* Beskrivning + kategori/sida/skick */}
        <div style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,padding:14,marginBottom:12}}>
          <div style={{marginBottom:10}}>
            <label style={{display:"block",fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:4}}>Kort beskrivning</label>
            <textarea value={f.description||""} onChange={e=>set("description",e.target.value)} rows={2} maxLength={200} placeholder="T.ex. fungerar perfekt, mindre repa på vänster sida..." style={{width:"100%",border:`1.5px solid ${BD}`,borderRadius:6,padding:"9px 12px",fontSize:13,resize:"none",fontFamily:"inherit"}}/>
            <div style={{fontSize:10,color:MU,textAlign:"right",marginTop:2}}>{(f.description||"").length}/200</div>
          </div>
          <G2><H><Sel label="Kategori" value={f.category} onChange={e=>set("category",e.target.value)} options={CATS}/></H><H><Sel label="Sida" value={f.side} onChange={e=>set("side",e.target.value)} options={SIDS}/></H></G2>
          <Sel label="Skick" value={f.condition} onChange={e=>set("condition",e.target.value)} options={CONDS}/>
        </div>

        {/* Car info */}
        <div style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,padding:14,marginBottom:12}}>
          <div style={{fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:10}}>Ursprungsbil</div>
          <G2><H><Inp label="Bilmärke" value={f.make} onChange={e=>set("make",e.target.value)} placeholder="ex. BMW"/></H><H><Inp label="Modell" value={f.model} onChange={e=>set("model",e.target.value)} placeholder="ex. 5-serie F10"/></H></G2>
          <G2><H><Inp label="Kompatibel med" value={f.compatible} onChange={e=>set("compatible",e.target.value)} placeholder="ex. BMW 5-serie F10"/></H><H><Inp label="Reg.nr" value={f.regNumber} onChange={e=>set("regNumber",formatRegNumber(e.target.value))} placeholder="ex. ABC 123"/></H></G2>
          <G2><H><Inp label="Från år" value={f.yearFrom} onChange={e=>set("yearFrom",e.target.value)} placeholder="2010"/></H><H><Inp label="Till år" value={f.yearTo} onChange={e=>set("yearTo",e.target.value)} placeholder="2016"/></H></G2>
        </div>

        {/* Pricing + stock */}
        <div style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,padding:14,marginBottom:12}}>
          <div style={{fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:10}}>Pris &amp; lager</div>
          {/* Pris: skriv ex moms → systemet räknar ut försäljningspris (ink moms 25%) */}
          <div style={{background:B+"06",border:`1px solid ${B}20`,borderRadius:8,padding:12,marginBottom:10}}>
            <G2>
              <H>
                <Inp label="Pris exkl. moms (kr)" type="number" min="0" value={priceExVat}
                  onChange={e=>{ const ex=Number(e.target.value)||0; setPriceExVat(e.target.value); set("price", exVatToInclVat(ex)); }}/>
              </H>
              <H>
                <Inp label="Försäljningspris inkl. moms (kr)" type="number" min="0" value={f.price}
                  onChange={e=>{ const inc=Number(e.target.value)||0; set("price", inc); setPriceExVat(inc? String(inclVatToExVat(inc)) : ""); }}/>
              </H>
            </G2>
            <div style={{fontSize:11,color:MU,marginTop:6}}>
              Skriv priset <strong>exkl. moms</strong> — försäljningspriset (inkl. 25% moms) räknas ut automatiskt. Moms: {f.price?Math.round(f.price - f.price/1.25).toLocaleString("sv-SE"):0} kr
            </div>
          </div>
          <G2><H><Inp label="Inköpspris exkl. moms (kr)" type="number" min="0" value={f.costPrice} onChange={e=>set("costPrice",Number(e.target.value))}/></H><H><Inp label="Antal" type="number" min="0" value={f.quantity} onChange={e=>set("quantity",Number(e.target.value))}/></H></G2>
          <G2><H><Inp label="Enhet" value={f.unit||"st"} onChange={e=>set("unit",e.target.value)}/></H><H/></G2>
        </div>

        {/* Details */}
        <div style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,padding:14,marginBottom:12}}>
          <div style={{fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:10}}>Övrig info</div>
          <G2><H><Inp label="Leverantör" value={f.supplier} onChange={e=>set("supplier",e.target.value)}/></H></G2>
          <G2><H><Inp label="Vikt (kg)" value={f.weight} onChange={e=>set("weight",e.target.value)}/></H><H><Inp label="Färgkod" value={f.colorCode} onChange={e=>set("colorCode",e.target.value)} placeholder="ex. 300 Alpinweiss"/></H></G2>
          <div style={{marginTop:4}}>
            <label style={{display:"block",fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:4}}>Notering</label>
            <textarea value={f.notes} onChange={e=>set("notes",e.target.value)} rows={3} style={{width:"100%",border:`1.5px solid ${BD}`,borderRadius:6,padding:"9px 12px",fontSize:13,resize:"vertical",fontFamily:"inherit",color:TX}}/>
          </div>
        </div>

        <div style={{display:"flex",flexDirection:"column",gap:8}}>
          <Btn full onClick={save} style={{padding:"13px"}}>{item?"Spara ändringar":"Lägg till del"}</Btn>
          <Btn full variant="ghost" onClick={saveAndNew} style={{padding:"13px"}}>
            <i className="fa-solid fa-plus"/> Spara &amp; lägg till nytt exemplar
          </Btn>
        </div>
      </div>
    </Page>
  );
}

// ─── Sell Page ────────────────────────────────────────────────────────────────
function SellPage({ item, items, sales, saveItems, saveSales, currentUser, push, pop, toast$, maxQty, presetBuyer, logActivity, isAdmin, customers, saveCustomers }) {
  const cap = maxQty != null ? maxQty : (item.quantity || 0);
  const [qty, setQty] = useState(1);
  const [buyer, setBuyer] = useState(presetBuyer || "");
  const [customerId, setCustomerId] = useState(null);
  const [anonymous, setAnonymous] = useState(false);
  // Admin kan välja att INTE registrera försäljningen i säljloggen (intern utlämning)
  const [registerSale, setRegisterSale] = useState(true);
  const VAT_RATE = 0.25; // 25% moms
  // unitPrice hålls som pris INKL moms (källan). De två rutorna skriver båda hit.
  const [unitPrice, setUnitPrice] = useState(item.price);
  // Vilken ruta som visas "rå" medan man skriver (så avrundning inte stör skrivandet)
  const [editing, setEditing] = useState(null); // "incl" | "excl" | null
  const [draftIncl, setDraftIncl] = useState(String(item.price));
  const [draftExcl, setDraftExcl] = useState(String(Math.round(item.price/(1+VAT_RATE))));
  const [discountMode, setDiscountMode] = useState("pct"); // "pct" | "kr"
  const [discountPct, setDiscountPct] = useState(0);
  const [discountKr, setDiscountKr] = useState(0);
  const [note, setNote] = useState("");

  // När man skriver i INKL-rutan → uppdatera priset + räkna ut EXKL automatiskt
  const onInclChange = (v) => {
    setDraftIncl(v);
    const n = Math.max(0, Number(v)||0);
    setUnitPrice(n);
    setDraftExcl(String(Math.round(n/(1+VAT_RATE))));
  };
  // När man skriver i EXKL-rutan → räkna upp till inkl + uppdatera priset
  const onExclChange = (v) => {
    setDraftExcl(v);
    const n = Math.max(0, Number(v)||0);
    const incl = Math.round(n*(1+VAT_RATE));
    setUnitPrice(incl);
    setDraftIncl(String(incl));
  };

  // ── Redigeringslås — hindra samtidig försäljning/redigering av samma del ──
  const [lockState, setLockState] = useState(null);
  const me = currentUser?.username || "Okänd";
  useEffect(() => {
    if (!item?.id) { setLockState({ ok: true }); return; }
    let active = true, hb = null;
    (async () => {
      const r = await lockAcquire(item.id, me, "edit");
      if (!active) return;
      if (r.ok) { setLockState({ ok: true }); hb = setInterval(()=>lockHeartbeat(item.id, me), 30000); }
      else setLockState({ blocked: true, by: r.lockedBy, action: r.action, remainingMs: r.remainingMs });
    })();
    return () => { active=false; if(hb)clearInterval(hb); if(item?.id) lockRelease(item.id, me); };
  }, [item?.id]);

  // Pris efter rabatt (rabatt räknas på inkl-priset)
  const finalPrice = discountMode === "pct"
    ? Math.round(unitPrice * (1 - discountPct/100))
    : Math.max(0, unitPrice - discountKr);
  const effectiveDiscountPct = unitPrice>0 ? Math.round((1 - finalPrice/unitPrice)*100) : 0;

  // finalPrice är INKL moms (kunden betalar detta). Exkl räknas ut.
  const priceInclVat = finalPrice;
  const priceExclVat = Math.round(finalPrice / (1 + VAT_RATE));
  const vatPerUnit = priceInclVat - priceExclVat;

  const total = qty * priceInclVat;
  const totalExclVat = qty * priceExclVat;
  const totalVat = qty * vatPerUnit;
  const profit = qty * (priceExclVat - (item.costPrice||0)); // vinst räknas exkl moms
  const priceChanged = unitPrice !== item.price;

  const resetPrice = () => {
    setUnitPrice(item.price);
    setDraftIncl(String(item.price));
    setDraftExcl(String(Math.round(item.price/(1+VAT_RATE))));
    setDiscountPct(0); setDiscountKr(0);
  };

  // Håll utkastvärdena i synk när man INTE aktivt redigerar (t.ex. efter återställning)
  useEffect(() => {
    if (editing !== "incl") setDraftIncl(String(unitPrice));
    if (editing !== "excl") setDraftExcl(String(Math.round(unitPrice/(1+VAT_RATE))));
  }, [unitPrice]);

  const sell = async () => {
    const it = items.find(i=>i.id===item.id);
    if (!it || qty > cap || it.quantity-qty<0) { toast$("Otillräckligt i lager!","error"); return; }
    const saleEntry = {
      id: genId("sale"),
      itemId: item.id,
      itemName: item.name,
      itemSku: item.sku,
      itemStockNumber: item.stockNumber||"",
      itemOem: item.oem||"",
      itemSide: item.side||"",
      qty,
      unitPrice: priceInclVat,
      priceInclVat,
      priceExclVat,
      vatPerUnit,
      vatRate: VAT_RATE,
      totalExclVat,
      totalVat,
      originalPrice: item.price,
      manualPrice: priceChanged ? unitPrice : null,
      discount: effectiveDiscountPct,
      discountKr: unitPrice - finalPrice,
      total,
      costPrice: item.costPrice||0,
      profit,
      buyer: buyer.trim()||"Okänd",
      customerId: customerId||null,
      note: note.trim(),
      soldBy: currentUser?.username||"Okänd",
      soldAt: Date.now(),
      // Snapshot — gör att man kan se alla detaljer i säljloggen även efter delen tagits bort
      itemSnapshot: {
        name:item.name, oem:item.oem, sku:item.sku, side:item.side,
        stockNumber:item.stockNumber, category:item.category, condition:item.condition,
        make:item.make, model:item.model, location:item.location, locationType:item.locationType,
        warehouse:item.warehouse,
        regNumber:item.regNumber, price:item.price, costPrice:item.costPrice,
        notes:item.notes, supplier:item.supplier,
      },
    };
    const newQty = item.quantity - qty;
    if (newQty <= 0) {
      // Antal noll → ta bort från lager (men säljloggen finns kvar)
      const updated = await deleteOneItem(item.id);
      if (updated) saveItems(updated);
      else await saveItems(items.filter(i=>i.id!==item.id));
    } else {
      const updatedItem = {...item, quantity:newQty, updatedAt:Date.now()};
      const updated = await saveOneItem(updatedItem);
      if (updated) saveItems(updated);
      else await saveItems(items.map(i=>i.id===item.id?updatedItem:i));
    }
    if (registerSale) {
      // Automatisk kundregistrering — samma logik som i Kassan.
      const buyerName = buyer?.trim() || presetBuyer?.trim() || "";
      let finalCustomerId = customerId;
      if (buyerName && !anonymous && !finalCustomerId && saveCustomers) {
        const existingMatch = (customers||[]).find(c => c.name.trim().toLowerCase() === buyerName.toLowerCase());
        if (existingMatch) {
          finalCustomerId = existingMatch.id;
        } else {
          const newCustomer = { id: genId("cust"), name: buyerName, phone:"", email:"", regNumbers:[], notes:"Skapad automatiskt vid köp", createdAt: Date.now() };
          await saveCustomers([newCustomer, ...(customers||[])]);
          finalCustomerId = newCustomer.id;
        }
      }
      await saveSales([{...saleEntry, customerId: finalCustomerId||null},...(sales||[])]);
      logActivity&&logActivity("sale", `Sålde ${qty} × ${item.name}${item.stockNumber?` (#${item.stockNumber})`:""} för ${total.toLocaleString("sv-SE")} kr`, { user: currentUser?.username, itemName:item.name, stockNumber:item.stockNumber });
      fetch("/admin/api/notify",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({type:"large_sale",total,buyer:buyer?.trim()||presetBuyer||"Okänd",soldBy:currentUser?.username})}).catch(()=>{});
      toast$(`Sålde ${qty} × ${item.name} — ${total.toLocaleString("sv-SE")} kr`,"success");
    } else {
      logActivity&&logActivity("sale", `Intern utlämning (ej registrerad): ${qty} × ${item.name}${item.stockNumber?` (#${item.stockNumber})`:""}`, { user: currentUser?.username, itemName:item.name, stockNumber:item.stockNumber });
      toast$(`Utlämnad — ${qty} × ${item.name} (ej registrerat i säljlogg)`,"success");
    }
    push("receipt",{sale:saleEntry});
  };

  if (lockState?.blocked) {
    const actionText = lockState.action === "cart" ? "har den i sin kassa" : "redigerar den här delen";
    return (
      <Page>
        <TopBar title="Delen är upptagen" onBack={pop} />
        <div style={{padding:"40px 24px",display:"flex",flexDirection:"column",alignItems:"center",textAlign:"center",gap:16}}>
          <div style={{width:72,height:72,borderRadius:"50%",background:AM+"18",display:"flex",alignItems:"center",justifyContent:"center"}}>
            <Icon name="lock" style={{fontSize:30,color:AM}}/>
          </div>
          <div>
            <div style={{fontWeight:800,fontSize:18,color:TX,marginBottom:6}}>{lockState.by} {actionText}</div>
            <div style={{fontSize:14,color:MU,lineHeight:1.5,maxWidth:320}}>
              Du kan inte sälja den här delen just nu. Den blir tillgänglig automatiskt om <strong style={{color:AM}}>{fmtLockTime(lockState.remainingMs)}</strong> om {lockState.by} inte blir klar innan dess.
            </div>
          </div>
          <Btn variant="ghost" onClick={pop}><Icon name="arrow-left"/> Tillbaka</Btn>
        </div>
      </Page>
    );
  }

  return (
    <Page>
      <TopBar title="Sälj del" onBack={pop} />
      <div style={{padding:"20px 14px"}}>
        {/* Item summary */}
        <div style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,padding:16,marginBottom:12,display:"flex",gap:12,alignItems:"center"}}>
          <div style={{width:56,height:56,borderRadius:8,overflow:"hidden",background:BG,border:`1px solid ${BD}`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:24,flexShrink:0}}>
            {(item.thumb||item.images?.[0])?<img src={item.thumb||item.images[0]} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}}/>:<Icon name="wrench" style={{color:MU}}/>}
          </div>
          <div style={{flex:1}}>
            {item.stockNumber&&<div style={{display:"inline-flex",alignItems:"center",gap:4,background:BX,color:WH,borderRadius:5,padding:"2px 8px",fontSize:12,fontWeight:800,marginBottom:4}}>#{item.stockNumber}</div>}
            <div style={{fontWeight:700,fontSize:15}}>{item.name}{item.side?` — ${item.side}`:""}</div>
            <div style={{fontSize:12,color:MU,marginTop:1}}></div>
            <div style={{fontSize:13,color:MU,marginTop:2}}>I lager: <strong style={{color:sc(item.quantity)}}>{item.quantity} st</strong> &nbsp;·&nbsp; <span style={{color:BX,fontWeight:600}}>Ordinarie: {item.price.toLocaleString("sv-SE")} kr/st</span></div>
          </div>
        </div>

        {/* Pris & rabatt */}
        <div style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,padding:16,marginBottom:12,display:"flex",flexDirection:"column",gap:12}}>
          <div>
            <Inp label="Antal" type="number" min="1" max={cap} value={qty} onChange={e=>setQty(Math.max(1,Math.min(cap,Number(e.target.value))))}/>
            {maxQty != null && maxQty < (item.quantity||0) && <div style={{fontSize:11,color:AM,fontWeight:600,marginTop:3}}>Max {cap} st kan säljas — resten är reserverade.</div>}
          </div>

          {/* Två prisrutor — inkl och exkl moms, räknar ut varandra automatiskt */}
          <div>
            <label style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",fontSize:11,fontWeight:700,color:priceChanged?BX:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:6}}>
              <span>Pris per styck (moms 25%)</span>
              {priceChanged&&<button onClick={resetPrice} style={{background:"none",border:"none",color:BX,fontSize:10,fontWeight:700,cursor:"pointer",textDecoration:"underline"}}>Återställ</button>}
            </label>
            <div style={{display:"flex",gap:10}}>
              <div style={{flex:1}}>
                <div style={{fontSize:10,fontWeight:700,color:MU,marginBottom:3}}>EXKL. MOMS</div>
                <input type="number" min="0" inputMode="decimal"
                  value={draftExcl}
                  onFocus={()=>setEditing("excl")} onBlur={()=>setEditing(null)}
                  onChange={e=>onExclChange(e.target.value)}
                  style={{width:"100%",padding:"9px 12px",border:`1.5px solid ${priceChanged?BX:BD}`,borderRadius:6,fontSize:14,fontWeight:600,color:TX,background:priceChanged?B+"06":WH}}/>
              </div>
              <div style={{display:"flex",alignItems:"flex-end",paddingBottom:9,color:MU,fontSize:16,fontWeight:700}}>→</div>
              <div style={{flex:1}}>
                <div style={{fontSize:10,fontWeight:700,color:BX,marginBottom:3}}>INKL. MOMS</div>
                <input type="number" min="0" inputMode="decimal"
                  value={draftIncl}
                  onFocus={()=>setEditing("incl")} onBlur={()=>setEditing(null)}
                  onChange={e=>onInclChange(e.target.value)}
                  style={{width:"100%",padding:"9px 12px",border:`1.5px solid ${priceChanged?BX:BD}`,borderRadius:6,fontSize:14,fontWeight:700,color:BX,background:priceChanged?B+"08":WH}}/>
              </div>
            </div>
            <div style={{fontSize:11,color:MU,marginTop:6}}>Skriv i valfri ruta — den andra fylls i automatiskt.</div>
          </div>

          {/* Rabatt toggle: % eller kr */}
          <div>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:4}}>
              <label style={{fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7}}>Ytterligare rabatt</label>
              <div style={{display:"flex",gap:4,background:BG,borderRadius:6,padding:2}}>
                <button onClick={()=>{setDiscountMode("pct");setDiscountKr(0);}} style={{padding:"3px 10px",borderRadius:5,border:"none",background:discountMode==="pct"?WH:"transparent",color:discountMode==="pct"?BX:MU,fontSize:11,fontWeight:700,boxShadow:discountMode==="pct"?SH:"none"}}>%</button>
                <button onClick={()=>{setDiscountMode("kr");setDiscountPct(0);}} style={{padding:"3px 10px",borderRadius:5,border:"none",background:discountMode==="kr"?WH:"transparent",color:discountMode==="kr"?BX:MU,fontSize:11,fontWeight:700,boxShadow:discountMode==="kr"?SH:"none"}}>kr</button>
              </div>
            </div>
            {discountMode==="pct"?(
              <input type="number" min="0" max="100" value={discountPct} onChange={e=>setDiscountPct(Math.min(100,Math.max(0,Number(e.target.value))))}
                placeholder="0" style={{width:"100%",padding:"9px 12px",border:`1.5px solid ${BD}`,borderRadius:6,fontSize:14}}/>
            ):(
              <input type="number" min="0" value={discountKr} onChange={e=>setDiscountKr(Math.max(0,Number(e.target.value)))}
                placeholder="0" style={{width:"100%",padding:"9px 12px",border:`1.5px solid ${BD}`,borderRadius:6,fontSize:14}}/>
            )}
          </div>

          {anonymous ? (
            <div style={{display:"flex",alignItems:"center",gap:10,background:BG,borderRadius:8,padding:"10px 12px"}}>
              <Icon name="user-secret" style={{color:MU}}/>
              <span style={{flex:1,fontSize:13,fontWeight:600,color:TM}}>Anonym försäljning — ingen kund registreras</span>
              <button onClick={()=>{setAnonymous(false);setBuyer("");}} style={{background:"none",border:"none",color:BX,fontWeight:700,fontSize:12,cursor:"pointer"}}>Ångra</button>
            </div>
          ) : (
            <>
              <CustomerPicker customers={customers} value={buyer} onChange={v=>{setBuyer(v);setCustomerId(null);}} onSelectCustomer={c=>{setBuyer(c.name);setCustomerId(c.id);}}/>
              <button onClick={()=>{setAnonymous(true);setBuyer("Privatkund (anonym)");setCustomerId(null);}} style={{alignSelf:"flex-start",background:"none",border:"none",color:MU,fontSize:12,fontWeight:600,cursor:"pointer",padding:0,display:"flex",alignItems:"center",gap:5}}>
                <Icon name="user-secret"/> Sälj anonymt (privatkund, ingen registrering)
              </button>
            </>
          )}
          <div>
            <label style={{display:"block",fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:4}}>Notering</label>
            <textarea value={note} onChange={e=>setNote(e.target.value)} rows={2} placeholder="Valfri kommentar..." style={{width:"100%",border:`1.5px solid ${BD}`,borderRadius:6,padding:"9px 12px",fontSize:13,resize:"none",fontFamily:"inherit",color:TX}}/>
          </div>
        </div>

        {/* Summary */}
        {qty>0&&qty<=cap&&(
          <div style={{background:B+"08",border:`1px solid ${B}20`,borderRadius:10,padding:14,marginBottom:14}}>
            {(discountPct>0||discountKr>0)&&(
              <div style={{display:"flex",justifyContent:"space-between",fontSize:12,color:MU,marginBottom:3}}>
                <span>Pris innan rabatt</span>
                <span style={{textDecoration:"line-through"}}>{unitPrice.toLocaleString("sv-SE")} kr</span>
              </div>
            )}
            {(discountPct>0||discountKr>0)&&(
              <div style={{display:"flex",justifyContent:"space-between",fontSize:12,color:AM,marginBottom:3}}>
                <span>Rabatt</span>
                <span>-{discountMode==="pct"?`${discountPct}%`:`${discountKr.toLocaleString("sv-SE")} kr`}</span>
              </div>
            )}
            <div style={{display:"flex",justifyContent:"space-between",fontSize:13,color:TM,marginBottom:3}}>
              <span>{qty} st × {priceExclVat.toLocaleString("sv-SE")} kr (exkl. moms)</span>
              <span>{totalExclVat.toLocaleString("sv-SE")} kr</span>
            </div>
            <div style={{display:"flex",justifyContent:"space-between",fontSize:13,color:TM,marginBottom:6,paddingBottom:6,borderBottom:`1px solid ${B}20`}}>
              <span>Moms (25%)</span>
              <span>{totalVat.toLocaleString("sv-SE")} kr</span>
            </div>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline"}}>
              <span style={{fontSize:13,fontWeight:700,color:TX}}>Totalt (inkl. moms)</span>
              <span style={{fontSize:22,fontWeight:800,color:BX}}>{total.toLocaleString("sv-SE")} kr</span>
            </div>
            {item.costPrice>0&&<div style={{marginTop:6,fontSize:12,color:profit>=0?GR:R,fontWeight:600}}>Vinst (exkl. moms): {profit.toLocaleString("sv-SE")} kr</div>}
          </div>
        )}

        {/* Admin: registrera försäljningen i säljloggen eller inte (intern utlämning) */}
        {isAdmin&&(
          <div style={{background:registerSale?WH:AM+"10",borderRadius:10,border:`1px solid ${registerSale?BD:AM}`,padding:14,marginBottom:14,display:"flex",alignItems:"center",gap:12}}>
            <div style={{flex:1}}>
              <div style={{fontWeight:700,fontSize:13}}>Registrera i säljlogg</div>
              <div style={{fontSize:11,color:MU,marginTop:2}}>Av = lagret minskar ändå, men syns inte i säljlogg/statistik (t.ex. intern utlämning)</div>
            </div>
            <button onClick={()=>setRegisterSale(v=>!v)} style={{width:44,height:24,borderRadius:12,border:"none",background:registerSale?GR:BD,position:"relative",cursor:"pointer",flexShrink:0}}>
              <div style={{width:18,height:18,borderRadius:"50%",background:WH,position:"absolute",top:3,left:registerSale?23:3,transition:"left .15s"}}/>
            </button>
          </div>
        )}

        <Btn full variant={registerSale?"red":"ghost"} onClick={sell} disabled={qty<1||qty>item.quantity} style={{padding:"13px",...(registerSale?{}:{border:`2px solid ${AM}`,color:AM})}}>
          <Icon name={registerSale?"tag":"box-open"}/> {registerSale?"Bekräfta försäljning":"Lämna ut (ej registrerat)"}
        </Btn>
      </div>
    </Page>
  );
}


// ─── Sales Log Page ───────────────────────────────────────────────────────────
function SalesLogPage({ sales, saveSales, items, saveItems, users, can, isAdmin, currentUser, push, pop, toast$, logActivity }) {
  const [search, setSearch] = useState("");
  const [period, setPeriod] = useState("all");
  const [confirmReverse, setConfirmReverse] = useState(null);
  const all = sales||[];

  const [saleDetail, setSaleDetail] = useState(null);

  const reverseSale = async (s) => {
    const existing = items.find(i => i.id===s.itemId);
    if (existing) {
      // Delen finns kvar — lägg bara tillbaka antalet
      const updatedItem = {...existing, quantity:existing.quantity+s.qty, updatedAt:Date.now()};
      const updated = await saveOneItem(updatedItem);
      if (updated) saveItems(updated);
      else await saveItems(items.map(i=>i.id===s.itemId?updatedItem:i));
    } else {
      // Delen är borttagen — återskapa den helt från snapshot eller säljdata
      const snap = s.itemSnapshot || {};
      const restored = {
        id: s.itemId || genId("item"),
        name: snap.name || s.itemName || "Återställd del",
        oem: snap.oem || "",
        sku: snap.sku || s.itemSku || "",
        side: snap.side || s.itemSide || "",
        stockNumber: snap.stockNumber || s.itemStockNumber || "",
        category: snap.category || "Övrigt",
        condition: snap.condition || "Begagnad - Gott skick",
        make: snap.make || "",
        model: snap.model || "",
        location: snap.location || "",
        locationType: snap.locationType || "",
        warehouse: snap.warehouse || "",
        regNumber: snap.regNumber || "",
        price: snap.price != null ? snap.price : (s.originalPrice || 0),
        costPrice: snap.costPrice || s.costPrice || 0,
        notes: snap.notes || "",
        supplier: snap.supplier || "",
        quantity: s.qty || 1,
        images: [],
        hasImages: 0,
        updatedAt: Date.now(),
      };
      const updated = await saveOneItem(restored);
      if (updated) saveItems(updated);
      else await saveItems([...items, restored]);
    }
    await saveSales((sales||[]).filter(x=>x.id!==s.id));
    logActivity&&logActivity("reverse", `Ångrade försäljning av ${s.itemName}${s.itemStockNumber?` (#${s.itemStockNumber})`:""}`, { user: currentUser?.username });
    toast$("Försäljning ångrad — delen är tillbaka i lagret","success");
    setConfirmReverse(null);
  };

  // Ångrar ALLA delar i ett helt köp (en receiptId) på en gång — bygger på
  // samma återställningslogik som reverseSale, men samlar alla borttagningar
  // ur säljloggen i ETT sparande så inget skrivs över av misstag.
  const reverseGroup = async (group) => {
    let latestItems = items;
    for (const s of group.rows) {
      const existing = latestItems.find(i => i.id===s.itemId);
      if (existing) {
        const updatedItem = {...existing, quantity:existing.quantity+s.qty, updatedAt:Date.now()};
        const updated = await saveOneItem(updatedItem);
        latestItems = updated || latestItems.map(i=>i.id===s.itemId?updatedItem:i);
      } else {
        const snap = s.itemSnapshot || {};
        const restored = {
          id: s.itemId || genId("item"),
          name: snap.name || s.itemName || "Återställd del",
          oem: snap.oem || "", sku: snap.sku || s.itemSku || "", side: snap.side || s.itemSide || "",
          stockNumber: snap.stockNumber || s.itemStockNumber || "",
          category: snap.category || "Övrigt", condition: snap.condition || "Begagnad - Gott skick",
          make: snap.make || "", model: snap.model || "",
          location: snap.location || "", locationType: snap.locationType || "", warehouse: snap.warehouse || "",
          regNumber: snap.regNumber || "",
          price: snap.price != null ? snap.price : (s.originalPrice || 0),
          costPrice: snap.costPrice || s.costPrice || 0,
          notes: snap.notes || "", supplier: snap.supplier || "",
          quantity: s.qty || 1, images: [], hasImages: 0, updatedAt: Date.now(),
        };
        const updated = await saveOneItem(restored);
        latestItems = updated || [...latestItems, restored];
      }
    }
    await saveItems(latestItems);
    const idsToRemove = new Set(group.rows.map(s=>s.id));
    await saveSales((sales||[]).filter(x=>!idsToRemove.has(x.id)));
    logActivity&&logActivity("reverse", `Ångrade hela köpet (${group.rows.length} artiklar, ${group.buyer})`, { user: currentUser?.username });
    toast$("Hela köpet ångrat — delarna är tillbaka i lagret","success");
    setConfirmReverse(null);
  };

  const now = Date.now();
  const filtered = all.filter(s => {
    if (period==="today")  { const d=new Date(s.soldAt); const t=new Date(); return d.toDateString()===t.toDateString(); }
    if (period==="week")   return now-s.soldAt < 7*864e5;
    if (period==="month")  return now-s.soldAt < 30*864e5;
    return true;
  }).filter(s => !search || s.itemName.toLowerCase().includes(search.toLowerCase()) || s.buyer.toLowerCase().includes(search.toLowerCase()) || s.soldBy.toLowerCase().includes(search.toLowerCase()) || (s.receiptId||s.id||"").toLowerCase().includes(search.toLowerCase()));

  const totalRev = filtered.reduce((a,s)=>a+s.total,0);
  const totalProfit = filtered.reduce((a,s)=>a+(s.profit||0),0);
  const totalQty = filtered.reduce((a,s)=>a+s.qty,0);
  const totalDiscount = filtered.reduce((a,s)=>a+(s.discountKr||0)*s.qty,0);

  // Group by receiptId for dagskassa view
  const byReceipt = {};
  filtered.forEach(s => {
    const key = s.receiptId || s.id;
    if (!byReceipt[key]) byReceipt[key] = { id:key, rows:[], soldAt:s.soldAt, soldBy:s.soldBy, buyer:s.buyer, payMethod:s.payMethod||"kontant" };
    byReceipt[key].rows.push(s);
  });
  const receipts = Object.values(byReceipt).sort((a,b)=>b.soldAt-a.soldAt);

  // Dagskassa: group by date
  const byDate = {};
  filtered.forEach(s => {
    const d = new Date(s.soldAt).toLocaleDateString("sv-SE",{weekday:"short",day:"numeric",month:"short"});
    if (!byDate[d]) byDate[d] = { date:d, rev:0, profit:0, qty:0, txCount:0, byPayment:{} };
    byDate[d].rev += s.total;
    byDate[d].profit += (s.profit||0);
    byDate[d].qty += s.qty;
    byDate[d].txCount++;
    const pay = s.payMethod||"kontant";
    byDate[d].byPayment[pay] = (byDate[d].byPayment[pay]||0) + s.total;
  });
  const dagskassa = Object.values(byDate);

  // Top sellers
  const byUser = {};
  filtered.forEach(s=>{ byUser[s.soldBy]=(byUser[s.soldBy]||0)+s.total; });
  const topSellers = Object.entries(byUser).sort((a,b)=>b[1]-a[1]).slice(0,3);

  const fmt = ts => {
    const d = new Date(ts);
    return d.toLocaleDateString("sv-SE",{day:"numeric",month:"short"}) + " " + d.toLocaleTimeString("sv-SE",{hour:"2-digit",minute:"2-digit"});
  };
  const fmtPay = p => p==="swish"?"Swish":p==="kort"?"Kort":"Kontant";

  return (
    <Page>
      <TopBar title="Säljlogg" onBack={pop} subtitle="Alla försäljningar" />
      <div style={{padding:"clamp(14px,2vw,28px)",paddingBottom:80}}>

        {/* Period filter */}
        <div style={{display:"flex",gap:6,marginBottom:12,overflowX:"auto",paddingBottom:2}}>
          {[["all","Alla"],["today","Idag"],["week","7 dagar"],["month","30 dagar"],["dagskassa","Dagskassa"]].map(([v,l])=>(
            <button key={v} onClick={()=>setPeriod(v)} style={{flexShrink:0,padding:"6px 14px",borderRadius:20,border:`1.5px solid ${period===v?BX:BD}`,background:period===v?BX:WH,color:period===v?WH:TM,fontWeight:600,fontSize:12}}>{l}</button>
          ))}
        </div>

        {/* Search */}
        <div style={{position:"relative",marginBottom:12}}>
          <span style={{position:"absolute",left:10,top:"50%",transform:"translateY(-50%)",pointerEvents:"none"}}><Icon name="magnifying-glass" style={{color:MU,fontSize:13}}/></span>
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Sök artikel, kund, säljare..." style={{width:"100%",padding:"9px 10px 9px 32px",border:`1.5px solid ${BD}`,borderRadius:8,fontSize:13,color:TX,background:WH}}/>
        </div>

        {/* Stats */}
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr 1fr",gap:6,marginBottom:12}}>
          {[[totalRev.toLocaleString("sv-SE")+" kr","Intäkt",BX],[totalProfit.toLocaleString("sv-SE")+" kr","Vinst",totalProfit>=0?GR:R],[totalQty+" st","Sålda",TM],[totalDiscount>0?"-"+totalDiscount.toLocaleString("sv-SE")+" kr":"0 kr","Rabatt",AM]].map(([val,lbl,col])=>(
            <div key={lbl} style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,padding:"10px 8px",textAlign:"center"}}>
              <div style={{fontSize:13,fontWeight:800,color:col}}>{val}</div>
              <div style={{fontSize:9,color:MU,fontWeight:600,textTransform:"uppercase",letterSpacing:.5,marginTop:2}}>{lbl}</div>
            </div>
          ))}
        </div>

        {/* Dagskassa view */}
        {period==="dagskassa" && (
          <div>
            {dagskassa.length===0?(
              <div style={{textAlign:"center",padding:40,color:MU,fontSize:13}}>Inga försäljningar att visa</div>
            ):dagskassa.map(d=>(
              <div key={d.date} style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,padding:14,marginBottom:10}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:10}}>
                  <div style={{fontWeight:700,fontSize:14,textTransform:"capitalize"}}>{d.date}</div>
                  <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:20,fontWeight:800,color:BX}}>{d.rev.toLocaleString("sv-SE")} kr</div>
                </div>
                <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:8}}>
                  <Badge label={`${d.txCount} transaktioner`} color={TM} small/>
                  <Badge label={`${d.qty} delar`} color={TM} small/>
                  <Badge label={`Vinst: ${d.profit.toLocaleString("sv-SE")} kr`} color={d.profit>=0?GR:R} small/>
                </div>
                <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                  {Object.entries(d.byPayment).map(([pay,rev])=>(
                    <div key={pay} style={{flex:1,minWidth:80,background:BG,borderRadius:6,padding:"6px 10px",textAlign:"center"}}>
                      <div style={{fontSize:12,fontWeight:700,color:TX}}>{rev.toLocaleString("sv-SE")} kr</div>
                      <div style={{fontSize:10,color:MU,fontWeight:600}}>{fmtPay(pay)}</div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Receipt-grouped view (non-dagskassa) */}
        {period!=="dagskassa" && <>

        {/* Top sellers */}
        {topSellers.length>0&&(
          <div style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,padding:12,marginBottom:12}}>
            <div style={{fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:8}}>Toppsäljare</div>
            {topSellers.map(([name,rev],i)=>(
              <div key={name} style={{display:"flex",alignItems:"center",gap:8,marginBottom:6}}>
                <div style={{width:20,height:20,borderRadius:"50%",background:[BX,GR,AM][i]+"20",color:[BX,GR,AM][i],fontSize:11,fontWeight:800,display:"flex",alignItems:"center",justifyContent:"center"}}>{i+1}</div>
                <span style={{flex:1,fontSize:13,fontWeight:600}}>{name}</span>
                <span style={{fontSize:13,fontWeight:700,color:BX}}>{rev.toLocaleString("sv-SE")} kr</span>
              </div>
            ))}
          </div>
        )}

        {/* Sales list — grupperad per köp (en rad per hela köpet, inte per del) */}
        {receipts.length===0?(
          <div style={{textAlign:"center",padding:40,color:MU,fontSize:14}}>Inga försäljningar hittades</div>
        ):(
          <Virtuoso
            style={{ height: "calc(100vh - 240px)" }}
            data={receipts}
            computeItemKey={(_, r) => r.id}
            itemContent={(_, r) => {
              const total = r.rows.reduce((a,s)=>a+s.total,0);
              const profit = r.rows.reduce((a,s)=>a+(s.profit||0),0);
              const qty = r.rows.reduce((a,s)=>a+s.qty,0);
              const payIcon = { kontant:"money-bill-wave", swish:"mobile-screen", kort:"credit-card" }[r.payMethod] || "money-bill-wave";
              return (
            <div style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,padding:14,marginBottom:8}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:8}}>
                <div>
                  <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:2}}>
                    <Icon name={payIcon} style={{fontSize:12,color:MU}}/>
                    <div style={{fontWeight:700,fontSize:14}}>{r.rows.length} {r.rows.length===1?"artikel":"artiklar"} · {qty} st</div>
                  </div>
                  <span style={{fontSize:12,color:MU}}>Kund: <strong style={{color:TX}}>{r.buyer}</strong></span>
                </div>
                <div style={{textAlign:"right"}}>
                  <div style={{fontWeight:800,fontSize:18,color:BX}}>{total.toLocaleString("sv-SE")} kr</div>
                  <div style={{fontSize:11,color:profit>=0?GR:R,fontWeight:600}}>Vinst: {profit.toLocaleString("sv-SE")} kr</div>
                </div>
              </div>

              {/* Kompakt lista över delarna i köpet */}
              <div style={{background:BG,borderRadius:8,padding:"4px 10px",marginBottom:8}}>
                {r.rows.map(s=>(
                  <div key={s.id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"6px 0",borderBottom:`1px solid ${BD}50`}}>
                    <div style={{minWidth:0,flex:1}}>
                      <div style={{display:"flex",alignItems:"center",gap:5}}>
                        {s.itemStockNumber&&<span style={{background:BX,color:WH,borderRadius:3,padding:"0px 5px",fontSize:9,fontWeight:800,flexShrink:0}}>#{s.itemStockNumber}</span>}
                        <span style={{fontSize:12.5,fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{s.itemName}{s.itemSide?` — ${s.itemSide}`:""}</span>
                      </div>
                    </div>
                    <span style={{fontSize:11.5,color:MU,flexShrink:0,marginLeft:8}}>{s.qty} × {s.unitPrice.toLocaleString("sv-SE")} kr</span>
                  </div>
                ))}
              </div>

              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <span style={{fontSize:12,color:MU}}>Säljare: <strong style={{color:TX}}>{r.soldBy}</strong></span>
                <span style={{fontSize:11,color:MU}}>{fmt(r.soldAt)}</span>
              </div>
              <div style={{display:"flex",gap:8,marginTop:8,paddingTop:8,borderTop:`1px solid ${BD}50`}}>
                <Btn variant="ghost" small onClick={()=>push("receipt",{sale:r.rows[0], receiptRows:r.rows, payMethod:r.payMethod})}><Icon name="receipt"/> Kvitto</Btn>
                {(isAdmin||r.soldBy===currentUser?.username)&&(
                  <Btn variant="ghost" small onClick={()=>setConfirmReverse(r)} style={{color:R}}><Icon name="rotate-left"/> Ångra allt</Btn>
                )}
              </div>
            </div>
              );
            }}
          />
        )}
        </>}
      </div>

      {/* Säljdetaljer */}
      {saleDetail&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.5)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:200,padding:20}} onClick={()=>setSaleDetail(null)}>
          <div onClick={e=>e.stopPropagation()} style={{background:WH,borderRadius:14,padding:0,maxWidth:380,width:"100%",maxHeight:"85vh",overflowY:"auto"}}>
            <div style={{background:BX,color:WH,padding:"16px 18px",borderRadius:"14px 14px 0 0"}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
                <div>
                  {saleDetail.itemStockNumber&&<span style={{background:"rgba(255,255,255,.2)",borderRadius:4,padding:"1px 7px",fontSize:11,fontWeight:800}}>#{saleDetail.itemStockNumber}</span>}
                  <div style={{fontWeight:800,fontSize:17,marginTop:4}}>{saleDetail.itemName}{saleDetail.itemSide?` — ${saleDetail.itemSide}`:""}</div>
                </div>
                <button onClick={()=>setSaleDetail(null)} style={{background:"none",border:"none",color:WH,fontSize:20,cursor:"pointer"}}>✕</button>
              </div>
            </div>
            <div style={{padding:18}}>
              {(() => {
                const snap = saleDetail.itemSnapshot || {};
                const rows = [
                  ["Artikelnummer", snap.oem],
                  ["Märke", snap.make ? `${snap.make}${snap.model?` ${snap.model}`:""}` : null],
                  ["Skick", snap.condition],
                  ["Kategori", snap.category],
                  ["Placering", [snap.locationType,snap.location].filter(Boolean).join(" — ")],
                  ["Reg.nr", snap.regNumber],
                ].filter(([,v])=>v);
                return rows.map(([k,v])=>(
                  <div key={k} style={{display:"flex",justifyContent:"space-between",padding:"7px 0",borderBottom:`1px solid ${BD}`,fontSize:13}}>
                    <span style={{color:MU}}>{k}</span>
                    <span style={{fontWeight:600,fontFamily:k==="Artikelnummer"?"monospace":"inherit"}}>{v}</span>
                  </div>
                ));
              })()}
              <div style={{marginTop:14,background:BG,borderRadius:8,padding:12}}>
                <div style={{fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",marginBottom:8}}>Försäljning</div>
                {[
                  ["Antal", `${saleDetail.qty} st`],
                  ["Pris/st", `${saleDetail.unitPrice.toLocaleString("sv-SE")} kr`],
                  saleDetail.discount>0?["Rabatt", `-${saleDetail.discount}%`]:null,
                  ["Totalt", `${saleDetail.total.toLocaleString("sv-SE")} kr`],
                  saleDetail.profit!=null?["Vinst", `${saleDetail.profit.toLocaleString("sv-SE")} kr`]:null,
                  ["Kund", saleDetail.buyer],
                  ["Säljare", saleDetail.soldBy],
                  ["Datum", fmt(saleDetail.soldAt)],
                  saleDetail.payMethod?["Betalning", fmtPay(saleDetail.payMethod)]:null,
                ].filter(Boolean).map(([k,v])=>(
                  <div key={k} style={{display:"flex",justifyContent:"space-between",padding:"5px 0",fontSize:13}}>
                    <span style={{color:MU}}>{k}</span>
                    <span style={{fontWeight:k==="Totalt"?800:600,color:k==="Totalt"?BX:TX}}>{v}</span>
                  </div>
                ))}
              </div>
              {saleDetail.note&&<div style={{marginTop:12,fontSize:13,color:TM,background:AM+"18",borderRadius:8,padding:10}}>{saleDetail.note}</div>}
              <Btn full variant="ghost" onClick={()=>{setSaleDetail(null);push("receipt",{sale:saleDetail});}} style={{marginTop:14}}><Icon name="receipt"/> Visa kvitto</Btn>
            </div>
          </div>
        </div>
      )}

      {confirmReverse&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.4)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:200,padding:20}} onClick={()=>setConfirmReverse(null)}>
          <div onClick={e=>e.stopPropagation()} style={{background:WH,borderRadius:14,padding:20,maxWidth:340,width:"100%"}}>
            {confirmReverse.rows ? (<>
              <div style={{fontWeight:700,fontSize:15,marginBottom:8}}>Ångra hela köpet?</div>
              <div style={{fontSize:13,color:MU,marginBottom:16}}>
                {confirmReverse.rows.length} artiklar återförs till lagret, totalt {confirmReverse.rows.reduce((a,s)=>a+s.total,0).toLocaleString("sv-SE")} kr ({confirmReverse.buyer}).
              </div>
              <div style={{display:"flex",gap:8}}>
                <Btn full variant="ghost" onClick={()=>setConfirmReverse(null)}>Avbryt</Btn>
                <Btn full variant="red" onClick={()=>reverseGroup(confirmReverse)}>Ångra allt</Btn>
              </div>
            </>) : (<>
              <div style={{fontWeight:700,fontSize:15,marginBottom:8}}>Ångra försäljning?</div>
              <div style={{fontSize:13,color:MU,marginBottom:16}}>
                {confirmReverse.qty} × {confirmReverse.itemName} återförs till lagret ({confirmReverse.total.toLocaleString("sv-SE")} kr).
              </div>
              <div style={{display:"flex",gap:8}}>
                <Btn full variant="ghost" onClick={()=>setConfirmReverse(null)}>Avbryt</Btn>
                <Btn full variant="red" onClick={()=>reverseSale(confirmReverse)}>Ångra</Btn>
              </div>
            </>)}
          </div>
        </div>
      )}
    </Page>
  );
}
// ─── Users Page ───────────────────────────────────────────────────────────────
function UsersPage({ users, saveUsers, roles, currentUser, push, pop, toast$, can, isAdmin, isFullAdmin, isPlatsAdmin }) {
  if (!isAdmin && !can("canManageUsers")) return <Page><TopBar title="Användare" onBack={pop}/><div style={{padding:40,textAlign:"center",color:MU}}><i className="fa-solid fa-lock" style={{fontSize:32,marginBottom:12,display:"block"}}/>Du saknar behörighet.</div></Page>;
  const [confirmDel, setConfirmDel] = useState(null);
  // Huvudadmin = admin UTAN tilldelat hemmalager. Måste alltid finnas minst
  // en — annars kan ingen längre hantera hela systemet, eller skapa fler
  // admins överhuvudtaget.
  const huvudadminCount = users.filter(u => u.role==="admin" && !u.homeWarehouse).length;
  const isLastHuvudadmin = u => u.role==="admin" && !u.homeWarehouse && huvudadminCount<=1;
  const del = async (id) => {
    const target = users.find(u=>u.id===id);
    if (target && isLastHuvudadmin(target)) {
      toast$("Går inte — måste finnas minst en huvudadmin","error");
      setConfirmDel(null);
      return;
    }
    await saveUsers(users.filter(u=>u.id!==id)); toast$("Borttagen","success"); setConfirmDel(null);
  };
  const roleOf = u => (roles||[]).find(r => r.id === u.roleId);
  // Platsadmin ser bara användare i sitt eget lager — huvudadmin ser alla.
  const visibleUsers = isPlatsAdmin ? users.filter(u => u.homeWarehouse === currentUser.homeWarehouse || u.id===currentUser.id) : users;
  const right = (
    <div style={{display:"flex",gap:6}}>
      <Btn small variant="ghost" onClick={()=>push("roles")}><Icon name="user-shield"/> Roller</Btn>
      <Btn small onClick={()=>push("edituser",{user:null})}><Icon name="plus"/> Ny</Btn>
    </div>
  );
  return (
    <Page>
      <TopBar title="Användare" onBack={pop} subtitle={isPlatsAdmin?`Hantera team — ${currentUser.homeWarehouse}`:"Hantera team"} right={right} />
      {isPlatsAdmin&&<div style={{margin:"0 14px",background:AM+"12",border:`1px solid ${AM}40`,borderRadius:10,padding:"10px 14px",fontSize:12.5,color:TM}}><Icon name="triangle-exclamation" style={{color:AM,marginRight:6}}/>Du ser bara användare kopplade till <b style={{color:TX}}>{currentUser.homeWarehouse}</b>.</div>}
      <div style={{padding:"14px 14px 40px",display:"flex",flexDirection:"column",gap:8}}>
        {visibleUsers.map(u=>{
          const role = roleOf(u);
          const outOfScope = isPlatsAdmin && u.homeWarehouse !== currentUser.homeWarehouse; // t.ex. sig själv, redan filtrerat men extra skydd
          return (
          <div key={u.id} style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,boxShadow:SH,padding:"12px 14px"}}>
            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:8}}>
              <div style={{width:38,height:38,borderRadius:8,background:u.role==="admin"?R:(role?.color||BX),display:"flex",alignItems:"center",justifyContent:"center",color:WH,fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:16,flexShrink:0}}>
                {u.username[0].toUpperCase()}
              </div>
              <div>
                <div style={{fontWeight:700}}>{u.username} {u.id===currentUser.id&&<Badge label="Du" color={BX} small />}</div>
                {u.role==="admin"
                  ? <Badge label={u.homeWarehouse?`Platsadmin — ${u.homeWarehouse}`:"Huvudadmin"} color={R} small />
                  : role
                    ? <Badge label={role.name} color={role.color||BX} small />
                    : <Badge label="Egna behörigheter" color={MU} small />}
                {u.homeWarehouse&&u.role!=="admin"&&<Badge label={u.homeWarehouse} color={AM} small />}
              </div>
              <div style={{marginLeft:"auto",display:"flex",gap:6}}>
                {u.role!=="admin"&&<Btn variant="blue" small onClick={()=>push("perms",{user:u})}><Icon name="key"/></Btn>}
                {(isFullAdmin || u.role!=="admin")&&<Btn variant="ghost" small onClick={()=>push("edituser",{user:u})}><Icon name="pen"/></Btn>}
                {u.id!==currentUser.id&&(isFullAdmin||u.role!=="admin")&&(
                  isLastHuvudadmin(u)
                    ? <Btn variant="ghost" small disabled title="Måste finnas minst en huvudadmin" style={{color:MU,opacity:.4,cursor:"not-allowed"}}><Icon name="lock"/></Btn>
                    : <Btn variant="ghost" small onClick={()=>setConfirmDel(u)} style={{color:R}}><Icon name="trash"/></Btn>
                )}
              </div>
            </div>
            {u.role!=="admin"&&(
              <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>
                {(() => {
                  // Visa effektiva behörigheter (roll + egna)
                  const effective = { ...(role?.permissions||{}), ...(u.permissions||{}) };
                  const active = ALL_PERMISSIONS.filter(p=>effective[p.key]);
                  return active.length>0
                    ? active.map(p=><Badge key={p.key} label={<><Icon name={p.icon.replace("fa-","")} style={{marginRight:4}}/>{p.label}</>} color={BX} small />)
                    : <span style={{fontSize:11,color:MU}}>Inga behörigheter</span>;
                })()}
              </div>
            )}
          </div>
          );
        })}
      </div>

      {confirmDel&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.4)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:200,padding:20}} onClick={()=>setConfirmDel(null)}>
          <div onClick={e=>e.stopPropagation()} style={{background:WH,borderRadius:14,padding:20,maxWidth:320,width:"100%"}}>
            <div style={{fontWeight:700,fontSize:15,marginBottom:8}}>Ta bort {confirmDel.username}?</div>
            <div style={{fontSize:13,color:MU,marginBottom:16}}>Detta går inte att ångra.</div>
            <div style={{display:"flex",gap:8}}>
              <Btn full variant="ghost" onClick={()=>setConfirmDel(null)}>Avbryt</Btn>
              <Btn full variant="red" onClick={()=>del(confirmDel.id)}>Ta bort</Btn>
            </div>
          </div>
        </div>
      )}
    </Page>
  );
}

// ─── Hantera listor — redigera kategorier, skick, sidor, placeringstyper ──────
function MenuLayoutPage({ settings, saveSettings, pop, toast$, isAdmin, can }) {
  if (!isAdmin && !can("canManageSettings")) return <Page><TopBar title="Meny-layout" onBack={pop}/><div style={{padding:40,textAlign:"center",color:MU}}><i className="fa-solid fa-lock" style={{fontSize:32,marginBottom:12,display:"block"}}/>Du saknar behörighet.</div></Page>;

  // Alla menyval (samma routes som i menyn). inventory + settings kan inte döljas.
  const ALL = [
    { route:"inventory",  label:"Lager",         icon:"house",              locked:true },
    { route:"checkout",   label:"Kassa",         icon:"cart-shopping" },
    { route:"dashboard",  label:"Dashboard",     icon:"chart-line" },
    { route:"reports",    label:"Rapporter",     icon:"chart-line" },
    { route:"saleslog",   label:"Säljlogg",      icon:"list" },
    { route:"reservations", label:"Reservationer", icon:"bookmark" },
    { route:"activitylog", label:"Aktivitetslogg", icon:"clock-rotate-left" },
    { route:"scan",       label:"Skanna",        icon:"qrcode" },
    { route:"import",     label:"Importera",     icon:"file-import" },
    { route:"bulkedit",   label:"Massredigera",  icon:"layer-group" },
    { route:"qrlabels",   label:"Etiketter",     icon:"qrcode" },
    { route:"locationview", label:"Platser",     icon:"location-dot" },
    { route:"suppliers",  label:"Leverantörer",  icon:"truck" },
    { route:"customers",  label:"Kunder",        icon:"address-book" },
    { route:"users",      label:"Användare",     icon:"users" },
    { route:"backup",     label:"Backup",        icon:"rotate" },
    { route:"trash",      label:"Papperskorg",   icon:"trash-can" },
    { route:"settings",   label:"Inställningar", icon:"sliders", locked:true },
  ];
  const byRoute = Object.fromEntries(ALL.map(x=>[x.route,x]));

  const layout = settings?.menuLayout || {};
  // Bygg initial ordning: sparad ordning först, sedan resten
  const initialOrder = () => {
    const saved = (layout.order||[]).filter(r=>byRoute[r]);
    const rest = ALL.map(x=>x.route).filter(r=>!saved.includes(r));
    return [...saved, ...rest];
  };
  const [order, setOrder] = useState(initialOrder);
  const [hidden, setHidden] = useState(new Set(layout.hidden||[]));

  const move = (i, dir) => {
    setOrder(o => {
      const n=[...o]; const j=i+dir;
      if (j<0||j>=n.length) return o;
      [n[i],n[j]]=[n[j],n[i]];
      return n;
    });
  };
  const toggleHide = (route) => {
    if (byRoute[route]?.locked) return;
    setHidden(h => { const n=new Set(h); n.has(route)?n.delete(route):n.add(route); return n; });
  };

  const save = async () => {
    await saveSettings({ ...settings, menuLayout: { order, hidden: [...hidden] } });
    toast$("Meny-layout sparad","success");
    pop();
  };
  const reset = async () => {
    setOrder(ALL.map(x=>x.route));
    setHidden(new Set());
  };

  return (
    <Page flush noAnim>
      <TopBar title="Meny-layout" onBack={pop} subtitle="Ordna och dölj menyval"
        right={<button onClick={reset} style={{background:"none",border:"none",color:R,fontWeight:600,fontSize:13,cursor:"pointer"}}>Återställ</button>}/>
      <div style={{flex:1,overflowY:"auto",WebkitOverflowScrolling:"touch",padding:"14px 14px 20px"}}>
        <div style={{fontSize:13,color:MU,marginBottom:14}}>Använd pilarna för att ändra ordning och ögat för att dölja/visa. Lager och Inställningar kan inte döljas. Ändringarna gäller för alla enheter.</div>

        <div style={{display:"flex",flexDirection:"column",gap:6}}>
          {order.map((route,i)=>{
            const item = byRoute[route];
            if (!item) return null;
            const isHidden = hidden.has(route);
            return (
              <div key={route} style={{display:"flex",alignItems:"center",gap:10,background:WH,borderRadius:9,border:`1.5px solid ${isHidden?BD:B+"30"}`,padding:"10px 12px",opacity:isHidden?0.55:1}}>
                <div style={{display:"flex",flexDirection:"column",gap:2}}>
                  <button onClick={()=>move(i,-1)} disabled={i===0} style={{background:"none",border:"none",cursor:i===0?"default":"pointer",color:i===0?BD:BX,padding:0,fontSize:12}}><i className="fa-solid fa-chevron-up"/></button>
                  <button onClick={()=>move(i,1)} disabled={i===order.length-1} style={{background:"none",border:"none",cursor:i===order.length-1?"default":"pointer",color:i===order.length-1?BD:BX,padding:0,fontSize:12}}><i className="fa-solid fa-chevron-down"/></button>
                </div>
                <div style={{width:32,height:32,borderRadius:8,background:B+"10",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                  <Icon name={item.icon} style={{color:BX,fontSize:14}}/>
                </div>
                <span style={{flex:1,fontWeight:600,fontSize:14,color:isHidden?MU:TX}}>{item.label}{item.locked&&<span style={{fontSize:10,color:MU,marginLeft:6,fontWeight:500}}>(kan ej döljas)</span>}</span>
                <button onClick={()=>toggleHide(route)} disabled={item.locked} title={isHidden?"Visa":"Dölj"}
                  style={{background:"none",border:"none",cursor:item.locked?"default":"pointer",color:item.locked?BD:(isHidden?R:BX),fontSize:16,padding:6}}>
                  <i className={`fa-solid ${isHidden?"fa-eye-slash":"fa-eye"}`}/>
                </button>
              </div>
            );
          })}
        </div>
      </div>

      <div style={{flexShrink:0,background:WH,borderTop:`1px solid ${BD}`,padding:"12px 14px",paddingBottom:"max(12px,env(safe-area-inset-bottom))"}}>
        <Btn full variant="red" onClick={save}><Icon name="check"/> Spara layout</Btn>
      </div>
    </Page>
  );
}

// ─── KGK Fordonsdata — automatisk import av märke/modell/år/alt.nr ──────────
// Byggd i väntan på riktig API-dokumentation från KGK. Så länge "Aktivera"
// är avstängd (standard) görs INGA anrop till KGK alls. När du fått pris
// och API-uppgifter från KGK: fyll i fälten, testa anslutningen, aktivera,
// och kör en genomgång. Om svarsformatet inte stämmer säger jag till Claude
// vad KGK faktiskt svarar, så justeras tolkningen på servern.
function KgkPage({ items, saveItems, isAdmin, can, pop, toast$ }) {
  if (!isAdmin && !can("canManageSettings")) return <Page><TopBar title="KGK Fordonsdata" onBack={pop}/><div style={{padding:40,textAlign:"center",color:MU}}><i className="fa-solid fa-lock" style={{fontSize:32,marginBottom:12,display:"block"}}/>Du saknar behörighet.</div></Page>;

  const DEFAULTS = { enabled:false, apiKey:"", baseUrl:"", customerNumber:"" };
  const [cfg, setCfg] = useState(DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState({ done:0, total:0, updated:0, notFound:0, errors:0 });
  const [scanLog, setScanLog] = useState([]);
  const cancelScan = useRef(false);

  useEffect(() => {
    sget("ow:kgkconfig").then(v => { if (v) setCfg({...DEFAULTS, ...v}); setLoading(false); });
  }, []);

  const set = (k,v) => setCfg(c=>({...c,[k]:v}));

  const save = async () => {
    setSaving(true);
    const ok = await sset("ow:kgkconfig", cfg);
    setSaving(false);
    toast$(ok?"Sparat":"Kunde inte spara", ok?"success":"error");
  };

  const testConnection = async () => {
    setTesting(true);
    await save(); // spara innan test så servern har senaste uppgifterna
    try {
      const r = await fetch("/admin/api/kgk/test", { method:"POST", headers: authHeaders() }).then(r=>r.json());
      toast$(r.ok ? (r.message||"Anslutning fungerar") : (r.error||"Kunde inte ansluta"), r.ok?"success":"error");
    } catch { toast$("Kunde inte nå servern","error"); }
    setTesting(false);
  };

  const runFullScan = async () => {
    if (!cfg.enabled) { toast$("Aktivera integrationen först","error"); return; }
    cancelScan.current = false;
    setScanning(true);
    setScanLog([]);
    const total = items.length;
    setScanProgress({ done:0, total, updated:0, notFound:0, errors:0 });
    let working = [...items];
    let updated=0, notFound=0, errors=0;
    const notFoundList = [];

    for (let i=0; i<working.length; i++) {
      if (cancelScan.current) break;
      const item = working[i];
      try {
        const r = await fetch("/admin/api/kgk/lookup", {
          method:"POST", headers: authHeaders({"Content-Type":"application/json"}),
          body: JSON.stringify({ oem:item.oem, sku:item.sku, name:item.name })
        }).then(r=>r.json());

        if (r.ok && r.found) {
          working[i] = {
            ...item,
            make: r.make || item.make,
            model: r.model || item.model,
            yearFrom: r.yearFrom || item.yearFrom,
            yearTo: r.yearTo || item.yearTo,
            category: r.category || item.category,
            alternativeNumbers: r.alternativeNumbers?.length ? r.alternativeNumbers : (item.alternativeNumbers||[]),
            kgkStatus: "found",
            kgkLastChecked: Date.now(),
          };
          updated++;
          setScanLog(l=>[{type:"ok",text:`${item.name} — uppdaterad`},...l].slice(0,40));
        } else if (r.ok && !r.found) {
          working[i] = { ...item, kgkStatus:"not_found", kgkLastChecked: Date.now() };
          notFound++;
          notFoundList.push({ name:item.name, oem:item.oem, stockNumber:item.stockNumber });
          setScanLog(l=>[{type:"miss",text:`${item.name} — ej hittad hos KGK`},...l].slice(0,40));
        } else {
          working[i] = { ...item, kgkStatus:"error", kgkLastChecked: Date.now() };
          errors++;
          setScanLog(l=>[{type:"err",text:`${item.name} — fel: ${r.error||"okänt"}`},...l].slice(0,40));
        }
      } catch (e) {
        working[i] = { ...item, kgkStatus:"error", kgkLastChecked: Date.now() };
        errors++;
      }
      setScanProgress({ done:i+1, total, updated, notFound, errors });
      // Liten paus mellan varje anrop så vi inte överbelastar KGK:s API
      await new Promise(res=>setTimeout(res, 300));
    }

    await saveItems(working);
    setScanning(false);
    toast$(`Klart: ${updated} uppdaterade, ${notFound} ej hittade, ${errors} fel`, "success");

    // Mejla listan över ej hittade delar, så de kan kollas manuellt
    // (kanske ett felskrivet artikelnummer, eller så finns delen inte hos KGK).
    if (notFoundList.length > 0) {
      fetch("/admin/api/kgk/notify-not-found", {
        method:"POST", headers: authHeaders({"Content-Type":"application/json"}),
        body: JSON.stringify({ items: notFoundList })
      }).catch(()=>{});
    }
  };

  if (loading) return <Page><TopBar title="KGK Fordonsdata" onBack={pop}/><div style={{padding:40,textAlign:"center",color:MU}}>Laddar…</div></Page>;

  return (
    <Page>
      <TopBar title="KGK Fordonsdata" onBack={pop} subtitle="Automatisk import av märke/modell/år/alt.nr" right={<Btn small onClick={save} disabled={saving}>Spara</Btn>}/>
      <div style={{padding:"14px 14px 40px",display:"flex",flexDirection:"column",gap:14}}>

        <div style={{background:AM+"12",border:`1px solid ${AM}40`,borderRadius:10,padding:14}}>
          <div style={{display:"flex",alignItems:"center",gap:8,color:AM,fontWeight:700,fontSize:13,marginBottom:4}}><Icon name="triangle-exclamation"/> Väntar på KGK:s API-uppgifter</div>
          <div style={{fontSize:12,color:TM}}>Fälten nedan sparas men ingenting skickas till KGK förrän du aktiverar integrationen. Anropens exakta format är en rimlig gissning tills vi har riktig dokumentation — fungerar testet inte, skicka det KGK svarar så justerar vi det direkt.</div>
        </div>

        {/* På/av */}
        <div style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,padding:16,display:"flex",alignItems:"center",gap:12}}>
          <div style={{flex:1}}>
            <div style={{fontWeight:700,fontSize:14}}>Aktivera KGK-integrationen</div>
            <div style={{fontSize:12,color:MU,marginTop:2}}>Ingenting hämtas automatiskt — bara när du själv kör en genomgång</div>
          </div>
          <button onClick={()=>set("enabled",!cfg.enabled)} style={{width:48,height:28,borderRadius:14,border:"none",background:cfg.enabled?GR:BD,position:"relative",cursor:"pointer",flexShrink:0}}>
            <div style={{width:22,height:22,borderRadius:"50%",background:WH,position:"absolute",top:3,left:cfg.enabled?23:3,transition:"left .15s",boxShadow:SH}}/>
          </button>
        </div>

        {/* API-uppgifter */}
        <div style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,padding:16}}>
          <div style={{fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:12}}>API-uppgifter från KGK</div>
          <div style={{display:"flex",flexDirection:"column",gap:12}}>
            <Inp label="Bas-URL" value={cfg.baseUrl} onChange={e=>set("baseUrl",e.target.value)} placeholder="https://api.kgk.se/fordonsdata/v1"/>
            <div style={{position:"relative"}}>
              <label style={{display:"block",fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:4}}>API-nyckel</label>
              <input type={showKey?"text":"password"} value={cfg.apiKey} onChange={e=>set("apiKey",e.target.value)} placeholder="Nyckel från KGK"
                style={{width:"100%",border:`1.5px solid ${BD}`,borderRadius:6,padding:"9px 40px 9px 12px",fontSize:14,boxSizing:"border-box",fontFamily:"monospace"}}/>
              <button onClick={()=>setShowKey(v=>!v)} type="button" style={{position:"absolute",right:8,top:28,background:"none",border:"none",color:MU,cursor:"pointer",padding:6}}>
                <i className={`fa-solid fa-${showKey?"eye-slash":"eye"}`}/>
              </button>
            </div>
            <Inp label="Kundnummer (om KGK kräver det)" value={cfg.customerNumber} onChange={e=>set("customerNumber",e.target.value)} placeholder="Valfritt"/>
          </div>
          <div style={{marginTop:12}}>
            <Btn variant="ghost" onClick={testConnection} disabled={testing}><Icon name="plug"/> {testing?"Testar…":"Testa anslutning"}</Btn>
          </div>
        </div>

        {/* Genomgång av lagret */}
        <div style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,padding:16}}>
          <div style={{fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:12}}>Genomgång av lagret</div>
          <div style={{fontSize:12,color:TM,marginBottom:12}}>Går igenom alla {items.length} delar i lagret och hämtar namn, kategori, märke, modell, år och alternativa artikelnummer från KGK. Delar som inte hittas markeras "Ej importerad från KGK" — inget skrivs över i onödan. Om delar inte hittas mejlas en lista efter genomgången (kan stängas av i E-postnotiser).</div>

          {!scanning ? (
            <Btn full variant="red" onClick={runFullScan} disabled={!cfg.enabled}><Icon name="magnifying-glass"/> Kör genomgång av hela lagret</Btn>
          ) : (
            <>
              <div style={{display:"flex",justifyContent:"space-between",fontSize:12,marginBottom:6}}>
                <span>{scanProgress.done} av {scanProgress.total}</span>
                <span style={{color:GR}}>{scanProgress.updated} uppdaterade</span>
              </div>
              <div style={{background:BG,borderRadius:6,height:8,overflow:"hidden",marginBottom:10}}>
                <div style={{background:BX,height:"100%",width:`${scanProgress.total?Math.round(scanProgress.done/scanProgress.total*100):0}%`,transition:"width .2s"}}/>
              </div>
              <Btn full variant="ghost" onClick={()=>{cancelScan.current=true;}}><Icon name="stop"/> Avbryt</Btn>
            </>
          )}
          {!cfg.enabled&&<div style={{fontSize:11,color:MU,marginTop:8}}>Aktivera integrationen ovan för att kunna köra en genomgång.</div>}

          {scanLog.length>0&&(
            <div style={{marginTop:14,maxHeight:220,overflowY:"auto",border:`1px solid ${BD}`,borderRadius:8}}>
              {scanLog.map((l,i)=>(
                <div key={i} style={{padding:"6px 10px",fontSize:11.5,borderBottom:`1px solid ${BD}30`,color:l.type==="ok"?GR:l.type==="miss"?MU:R}}>
                  <i className={`fa-solid fa-${l.type==="ok"?"check":l.type==="miss"?"minus":"xmark"}`} style={{marginRight:6,fontSize:10}}/>{l.text}
                </div>
              ))}
            </div>
          )}
        </div>

        <Btn full variant="red" onClick={save} disabled={saving}><Icon name="check"/> Spara inställningar</Btn>
      </div>
    </Page>
  );
}

function EmailNotifyPage({ isAdmin, can, pop, toast$ }) {
  if (!isAdmin && !can("canManageSettings")) return <Page><TopBar title="E-postnotiser" onBack={pop}/><div style={{padding:40,textAlign:"center",color:MU}}><i className="fa-solid fa-lock" style={{fontSize:32,marginBottom:12,display:"block"}}/>Du saknar behörighet.</div></Page>;

  const DEFAULTS = {
    enabled: false, fromEmail: "", appPassword: "", adminEmail: "",
    largePurchaseThreshold: 10000, inactivityDays: 7,
    notifTypes: { largePurchase:true, inactiveSeller:true, failedLogin:true, serverError:true, backupFailed:true, dailySummary:true, weeklySummary:true, kgkNotFound:true, warehouseReservation:true },
  };
  const [cfg, setCfg] = useState(DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [showPw, setShowPw] = useState(false);

  useEffect(() => {
    sget("ow:emailconfig").then(v => { if (v) setCfg({ ...DEFAULTS, ...v, notifTypes:{...DEFAULTS.notifTypes, ...(v.notifTypes||{})} }); setLoading(false); });
  }, []);

  const set = (k,v) => setCfg(c=>({...c,[k]:v}));
  const toggleType = k => setCfg(c=>({...c, notifTypes:{...c.notifTypes,[k]:!c.notifTypes[k]}}));

  const save = async () => {
    setSaving(true);
    const ok = await sset("ow:emailconfig", cfg);
    setSaving(false);
    toast$(ok?"Sparat":"Kunde inte spara", ok?"success":"error");
  };

  const sendTest = async () => {
    setTesting(true);
    try {
      const r = await fetch("/admin/api/email-test", { headers: authHeaders() }).then(r=>r.json());
      if (r.ok) toast$("Testmejl skickat — kolla din inkorg","success");
      else toast$(r.error || "Kunde inte skicka","error");
    } catch { toast$("Kunde inte nå servern","error"); }
    setTesting(false);
  };

  const NOTIF_TYPES = [
    { k:"dailySummary", l:"Daglig sammanfattning", desc:"Varje morgon 08:00 — igår sålde ni X för Y kr (skickas bara om det fanns försäljning)", icon:"calendar-day" },
    { k:"weeklySummary", l:"Veckosammanfattning", desc:"Varje måndag 08:05 — sammanfattning av föregående vecka, per säljare och bästa dag", icon:"calendar-week" },
    { k:"largePurchase", l:"Stort köp genomfört", desc:`Köp över tröskelvärdet nedan (just nu ${Number(cfg.largePurchaseThreshold||0).toLocaleString("sv-SE")} kr)`, icon:"tag" },
    { k:"inactiveSeller", l:"Säljare inaktiv", desc:`Ingen aktivitet på ett konto på ${cfg.inactivityDays||7}+ dagar — kontrolleras varje morgon 09:00`, icon:"user-clock" },
    { k:"failedLogin", l:"Misslyckad inloggning", desc:"3+ misslyckade inloggningsförsök på samma konto inom 15 minuter", icon:"triangle-exclamation" },
    { k:"serverError", l:"Serverfel", desc:"Ett ohanterat fel inträffade på servern (max 1 mejl/30 min)", icon:"bug" },
    { k:"backupFailed", l:"Backup misslyckades", desc:"Den automatiska veckobackupen kunde inte skapas", icon:"database" },
    { k:"kgkNotFound", l:"Delar ej hittade hos KGK", desc:"Efter en genomgång — lista på delar som inte hittades, för manuell kontroll", icon:"car" },
    { k:"warehouseReservation", l:"Reservation från annat lager", desc:"Skickas till utvalda användare (satt i sin profil) när en del reserveras i deras lager av någon från ett annat", icon:"industry" },
  ];

  if (loading) return <Page><TopBar title="E-postnotiser" onBack={pop}/><div style={{padding:40,textAlign:"center",color:MU}}>Laddar…</div></Page>;

  return (
    <Page>
      <TopBar title="E-postnotiser" onBack={pop} subtitle="Viktiga händelser mejlas till huvudadmin" right={<Btn small onClick={save} disabled={saving}>Spara</Btn>}/>
      <div style={{padding:"14px 14px 40px",display:"flex",flexDirection:"column",gap:14}}>

        {/* På/av */}
        <div style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,padding:16,display:"flex",alignItems:"center",gap:12}}>
          <div style={{flex:1}}>
            <div style={{fontWeight:700,fontSize:14}}>Aktivera e-postnotiser</div>
            <div style={{fontSize:12,color:MU,marginTop:2}}>Slå av/på alla notiser i ett steg</div>
          </div>
          <button onClick={()=>set("enabled",!cfg.enabled)} style={{width:48,height:28,borderRadius:14,border:"none",background:cfg.enabled?GR:BD,position:"relative",cursor:"pointer",flexShrink:0}}>
            <div style={{width:22,height:22,borderRadius:"50%",background:WH,position:"absolute",top:3,left:cfg.enabled?23:3,transition:"left .15s",boxShadow:SH}}/>
          </button>
        </div>

        {/* Gmail-uppgifter */}
        <div style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,padding:16}}>
          <div style={{fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:12}}>Avsändare (Gmail)</div>
          <div style={{display:"flex",flexDirection:"column",gap:12}}>
            <Inp label="Gmail-adress" type="email" value={cfg.fromEmail} onChange={e=>set("fromEmail",e.target.value)} placeholder="dittkonto@gmail.com"/>
            <div style={{position:"relative"}}>
              <label style={{display:"block",fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:4}}>App-lösenord</label>
              <input type={showPw?"text":"password"} value={cfg.appPassword} onChange={e=>set("appPassword",e.target.value)} placeholder="16 tecken från Google"
                style={{width:"100%",border:`1.5px solid ${BD}`,borderRadius:6,padding:"9px 40px 9px 12px",fontSize:14,boxSizing:"border-box",fontFamily:"monospace"}}/>
              <button onClick={()=>setShowPw(v=>!v)} type="button" style={{position:"absolute",right:8,top:28,background:"none",border:"none",color:MU,cursor:"pointer",padding:6}}>
                <i className={`fa-solid fa-${showPw?"eye-slash":"eye"}`}/>
              </button>
            </div>
            <div style={{fontSize:11,color:MU}}>Skapas på <span style={{color:BX,fontWeight:600}}>myaccount.google.com/security</span> → Tvåstegsverifiering måste vara på → sök "Applösenord".</div>
          </div>
        </div>

        {/* Mottagare */}
        <div style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,padding:16}}>
          <div style={{fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:12}}>Mottagare (huvudadmin)</div>
          <Inp label="E-post som ska få notiserna" type="email" value={cfg.adminEmail} onChange={e=>set("adminEmail",e.target.value)} placeholder="chef@exempel.se"/>
          <div style={{marginTop:12}}>
            <Btn variant="ghost" onClick={sendTest} disabled={testing}><Icon name="paper-plane"/> {testing?"Skickar…":"Skicka testmejl"}</Btn>
          </div>
        </div>

        {/* Tröskelvärden */}
        <div style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,padding:16}}>
          <div style={{fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:12}}>Tröskelvärden</div>
          <G2>
            <H><Inp label="Stort köp — gräns (kr)" type="number" min="0" value={cfg.largePurchaseThreshold} onChange={e=>set("largePurchaseThreshold",Number(e.target.value))}/></H>
            <H><Inp label="Inaktivitet — dagar" type="number" min="1" value={cfg.inactivityDays} onChange={e=>set("inactivityDays",Number(e.target.value))}/></H>
          </G2>
        </div>

        {/* Vilka notiser */}
        <div style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,padding:16}}>
          <div style={{fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:12}}>Vilka notiser ska skickas</div>
          <div style={{display:"flex",flexDirection:"column",gap:2}}>
            {NOTIF_TYPES.map(n=>(
              <div key={n.k} style={{display:"flex",alignItems:"center",gap:12,padding:"10px 0",borderBottom:`1px solid ${BD}40`}}>
                <div style={{width:34,height:34,borderRadius:8,background:B+"10",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                  <Icon name={n.icon} style={{color:BX,fontSize:14}}/>
                </div>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontWeight:600,fontSize:13}}>{n.l}</div>
                  <div style={{fontSize:11,color:MU}}>{n.desc}</div>
                </div>
                <button onClick={()=>toggleType(n.k)} style={{width:42,height:24,borderRadius:12,border:"none",background:cfg.notifTypes[n.k]?GR:BD,position:"relative",cursor:"pointer",flexShrink:0}}>
                  <div style={{width:18,height:18,borderRadius:"50%",background:WH,position:"absolute",top:3,left:cfg.notifTypes[n.k]?21:3,transition:"left .15s"}}/>
                </button>
              </div>
            ))}
          </div>
        </div>

        <Btn full variant="red" onClick={save} disabled={saving}><Icon name="check"/> Spara inställningar</Btn>
      </div>
    </Page>
  );
}

// ─── Papperskorg — borttagna delar, återställningsbara i 30 dagar ────────────
function TrashPage({ trash, saveTrash, items, saveItems, currentUser, isAdmin, can, pop, toast$ }) {
  if (!isAdmin && !can("canManageTrash")) return <Page><TopBar title="Papperskorg" onBack={pop}/><div style={{padding:40,textAlign:"center",color:MU}}><i className="fa-solid fa-lock" style={{fontSize:32,marginBottom:12,display:"block"}}/>Du saknar behörighet.</div></Page>;

  const [search, setSearch] = useState("");
  const [confirmPurgeAll, setConfirmPurgeAll] = useState(false);
  const [confirmPurgeOne, setConfirmPurgeOne] = useState(null);
  const [busy, setBusy] = useState(null);

  const list = (trash||[])
    .filter(t => !search.trim() || [t.name,t.oem,t.stockNumber,t.sku].some(f=>f?.toLowerCase().includes(search.trim().toLowerCase())))
    .sort((a,b)=>b.deletedAt-a.deletedAt);

  const daysLeft = deletedAt => Math.max(0, 30 - Math.floor((Date.now()-deletedAt)/864e5));

  const restore = async (entry) => {
    setBusy(entry.id);
    const { deletedAt, deletedBy, images, ...clean } = entry;
    // Bilderna finns fortfarande kvar på servern under samma id — de kommer
    // tillbaka automatiskt så fort artikeln finns i lagerlistan igen.
    const restored = { ...clean, updatedAt: Date.now() };
    const res = await saveOneItem(restored);
    if (res) saveItems(res);
    else await saveItems([...items, restored]);
    await saveTrash((trash||[]).filter(t=>t.id!==entry.id));
    setBusy(null);
    toast$(`${entry.name} återställd`,"success");
  };

  const purgeOne = async (id) => {
    setBusy(id);
    await deleteOneItem(id); // rensar ev. kvarvarande bilder på servern permanent
    await saveTrash((trash||[]).filter(t=>t.id!==id));
    setBusy(null);
    setConfirmPurgeOne(null);
    toast$("Borttagen permanent","success");
  };

  const purgeAll = async () => {
    setBusy("all");
    for (const t of (trash||[])) { await deleteOneItem(t.id); }
    await saveTrash([]);
    setBusy(null);
    setConfirmPurgeAll(false);
    toast$("Papperskorgen tömd","success");
  };

  return (
    <Page flush noAnim>
      <TopBar title="Papperskorg" onBack={pop} subtitle={`${(trash||[]).length} borttagna delar · rensas efter 30 dagar`}
        right={(trash||[]).length>0?<button onClick={()=>setConfirmPurgeAll(true)} style={{background:"none",border:"none",color:R,fontWeight:600,fontSize:13,cursor:"pointer"}}>Töm allt</button>:null}/>
      <div style={{flex:1,overflowY:"auto",WebkitOverflowScrolling:"touch",padding:"14px 14px 20px"}}>
        <div style={{position:"relative",marginBottom:14}}>
          <Icon name="magnifying-glass" style={{position:"absolute",left:12,top:"50%",transform:"translateY(-50%)",color:MU,fontSize:13}}/>
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Sök i papperskorgen…"
            style={{width:"100%",border:`1.5px solid ${BD}`,borderRadius:8,padding:"10px 12px 10px 34px",fontSize:14,boxSizing:"border-box"}}/>
        </div>

        {list.length===0&&(
          <div style={{textAlign:"center",padding:50,color:MU}}>
            <i className="fa-solid fa-trash-can" style={{fontSize:32,marginBottom:12,display:"block",opacity:.4}}/>
            {(trash||[]).length===0 ? "Papperskorgen är tom" : "Inga träffar"}
          </div>
        )}

        {list.map(entry=>{
          const dleft = daysLeft(entry.deletedAt);
          return (
            <div key={entry.id} style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,padding:"12px 14px",marginBottom:8}}>
              <div style={{display:"flex",alignItems:"flex-start",gap:10}}>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:3}}>
                    {entry.stockNumber&&<span style={{background:BX,color:WH,borderRadius:4,padding:"1px 6px",fontSize:10,fontWeight:800,flexShrink:0}}>#{entry.stockNumber}</span>}
                    <span style={{fontWeight:700,fontSize:14,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{entry.name}{entry.side?` — ${entry.side}`:""}</span>
                  </div>
                  <div style={{fontSize:11,color:MU}}>
                    {entry.oem&&<span style={{fontFamily:"monospace"}}>{entry.oem}</span>}
                    {entry.oem&&" · "}
                    Borttagen av {entry.deletedBy} · {new Date(entry.deletedAt).toLocaleDateString("sv-SE")}
                  </div>
                  <div style={{fontSize:11,marginTop:3,color:dleft<=5?R:AM,fontWeight:600}}>
                    <Icon name="clock" style={{fontSize:10,marginRight:4}}/>
                    {dleft>0?`${dleft} dagar kvar innan permanent radering`:"Rensas snart permanent"}
                  </div>
                </div>
                <div style={{fontWeight:800,fontSize:14,color:BX,flexShrink:0}}>{(entry.price||0).toLocaleString("sv-SE")} kr</div>
              </div>
              <div style={{display:"flex",gap:8,marginTop:10}}>
                <Btn small full onClick={()=>restore(entry)} disabled={busy===entry.id}><Icon name="rotate-left"/> Återställ</Btn>
                <Btn small variant="ghost" onClick={()=>setConfirmPurgeOne(entry)} disabled={busy===entry.id} style={{color:R}}><Icon name="trash"/></Btn>
              </div>
            </div>
          );
        })}
      </div>

      {confirmPurgeOne&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.4)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:200,padding:20}} onClick={()=>setConfirmPurgeOne(null)}>
          <div onClick={e=>e.stopPropagation()} style={{background:WH,borderRadius:14,padding:20,maxWidth:320,width:"100%"}}>
            <div style={{fontWeight:700,fontSize:15,marginBottom:8,color:R}}>Ta bort permanent?</div>
            <div style={{fontSize:13,color:MU,marginBottom:16}}><strong style={{color:TX}}>{confirmPurgeOne.name}</strong> tas bort permanent, inklusive bilder. Går inte att ångra.</div>
            <div style={{display:"flex",gap:8}}>
              <Btn full variant="ghost" onClick={()=>setConfirmPurgeOne(null)}>Avbryt</Btn>
              <Btn full variant="red" onClick={()=>purgeOne(confirmPurgeOne.id)}>Ta bort permanent</Btn>
            </div>
          </div>
        </div>
      )}

      {confirmPurgeAll&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.4)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:200,padding:20}} onClick={()=>setConfirmPurgeAll(false)}>
          <div onClick={e=>e.stopPropagation()} style={{background:WH,borderRadius:14,padding:20,maxWidth:340,width:"100%"}}>
            <div style={{fontWeight:700,fontSize:15,marginBottom:8,color:R}}>Töm hela papperskorgen?</div>
            <div style={{fontSize:13,color:MU,marginBottom:16}}>Alla <strong style={{color:TX}}>{(trash||[]).length} delar</strong> tas bort permanent, inklusive bilder. Går inte att ångra.</div>
            <div style={{display:"flex",gap:8}}>
              <Btn full variant="ghost" onClick={()=>setConfirmPurgeAll(false)}>Avbryt</Btn>
              <Btn full variant="red" onClick={purgeAll} disabled={busy==="all"}>Töm papperskorgen</Btn>
            </div>
          </div>
        </div>
      )}
    </Page>
  );
}

function ManageListsPage({ lists, saveLists, pop, toast$, isAdmin, can }) {
  if (!isAdmin && !can("canManageSettings")) return <Page><TopBar title="Hantera listor" onBack={pop}/><div style={{padding:40,textAlign:"center",color:MU}}><i className="fa-solid fa-lock" style={{fontSize:32,marginBottom:12,display:"block"}}/>Du saknar behörighet.</div></Page>;
  const [local, setLocal] = useState({
    categories: [...(lists?.categories||DEFAULT_CATEGORIES)],
    conditions: [...(lists?.conditions||DEFAULT_CONDITIONS)],
    sides: [...(lists?.sides||DEFAULT_SIDES)].filter(Boolean),
    locationTypes: [...(lists?.locationTypes||DEFAULT_LOCATION_TYPES)].filter(Boolean),
    warehouses: [...(lists?.warehouses||DEFAULT_WAREHOUSES)],
  });
  const [newVal, setNewVal] = useState({ categories:"", conditions:"", sides:"", locationTypes:"", warehouses:"" });

  const addItem = (key) => {
    const v = newVal[key].trim();
    if (!v) return;
    if (local[key].some(x => x.toLowerCase() === v.toLowerCase())) { toast$("Finns redan","error"); return; }
    setLocal(p => ({ ...p, [key]: [...p[key], v] }));
    setNewVal(p => ({ ...p, [key]: "" }));
  };
  const removeItem = (key, val) => setLocal(p => ({ ...p, [key]: p[key].filter(x => x !== val) }));
  const moveItem = (key, idx, dir) => setLocal(p => {
    const arr = [...p[key]]; const j = idx + dir;
    if (j < 0 || j >= arr.length) return p;
    [arr[idx], arr[j]] = [arr[j], arr[idx]];
    return { ...p, [key]: arr };
  });

  const save = async () => {
    // Sidor och placeringstyper behåller en ledande tom sträng (= "ingen/valfri")
    await saveLists({
      categories: local.categories,
      conditions: local.conditions,
      sides: ["", ...local.sides],
      locationTypes: ["", ...local.locationTypes],
      warehouses: local.warehouses,
    });
    toast$("Listor sparade","success");
    pop();
  };

  const sections = [
    { key:"categories", title:"Kategorier", icon:"fa-tags", hint:"T.ex. Skärmar, Dörrar, Stötfångare" },
    { key:"conditions", title:"Skick", icon:"fa-star-half-stroke", hint:"T.ex. Ny, Begagnad – Gott skick" },
    { key:"sides", title:"Sidor", icon:"fa-arrows-left-right", hint:"T.ex. Vänster, Höger, Fram, Bak" },
    { key:"locationTypes", title:"Placeringstyper", icon:"fa-warehouse", hint:"T.ex. Hylla, Låda, Rum" },
    { key:"warehouses", title:"Lager (orter)", icon:"fa-industry", hint:"T.ex. Halmstad, Laholm" },
  ];

  return (
    <Page>
      <TopBar title="Hantera listor" onBack={pop} right={<Btn small onClick={save}><Icon name="check"/> Spara</Btn>} />
      <div style={{padding:"14px 14px 60px"}}>
        <div style={{fontSize:12,color:MU,marginBottom:12,lineHeight:1.5}}>
          Lägg till, ta bort eller ändra ordning. Tar du bort ett värde försvinner det bara från nya val — delar som redan har det behåller sitt värde.
        </div>
        {sections.map(sec=>(
          <div key={sec.key} style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,padding:14,marginBottom:12}}>
            <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4}}>
              <i className={`fa-solid ${sec.icon}`} style={{color:BX,fontSize:15}}/>
              <div style={{fontWeight:800,fontSize:15,color:TX}}>{sec.title}</div>
            </div>
            <div style={{fontSize:11,color:MU,marginBottom:10}}>{sec.hint}</div>

            <div style={{display:"flex",flexDirection:"column",gap:6,marginBottom:10}}>
              {local[sec.key].length===0&&<div style={{fontSize:12,color:MU,fontStyle:"italic"}}>Inga värden än</div>}
              {local[sec.key].map((val,idx)=>(
                <div key={val} style={{display:"flex",alignItems:"center",gap:8,background:BG,borderRadius:7,padding:"7px 10px"}}>
                  <div style={{display:"flex",flexDirection:"column",gap:1}}>
                    <button onClick={()=>moveItem(sec.key,idx,-1)} disabled={idx===0} style={{background:"none",border:"none",cursor:idx===0?"default":"pointer",color:idx===0?BD:MU,fontSize:10,padding:0,lineHeight:1}}><i className="fa-solid fa-chevron-up"/></button>
                    <button onClick={()=>moveItem(sec.key,idx,1)} disabled={idx===local[sec.key].length-1} style={{background:"none",border:"none",cursor:idx===local[sec.key].length-1?"default":"pointer",color:idx===local[sec.key].length-1?BD:MU,fontSize:10,padding:0,lineHeight:1}}><i className="fa-solid fa-chevron-down"/></button>
                  </div>
                  <span style={{flex:1,fontSize:13,fontWeight:600,color:TX}}>{val}</span>
                  <button onClick={()=>removeItem(sec.key,val)} style={{background:"none",border:"none",cursor:"pointer",color:R,fontSize:14,padding:"2px 4px"}}><i className="fa-solid fa-trash"/></button>
                </div>
              ))}
            </div>

            <div style={{display:"flex",gap:6}}>
              <input type="text" value={newVal[sec.key]} onChange={e=>setNewVal(p=>({...p,[sec.key]:e.target.value}))}
                onKeyDown={e=>{ if(e.key==="Enter") addItem(sec.key); }}
                placeholder="Lägg till nytt värde…"
                style={{flex:1,border:`1.5px solid ${BD}`,borderRadius:7,padding:"8px 11px",fontSize:13}}/>
              <Btn small variant="blue" onClick={()=>addItem(sec.key)}><Icon name="plus"/></Btn>
            </div>
          </div>
        ))}
      </div>
    </Page>
  );
}

// ─── Roles Page — hantera roller ──────────────────────────────────────────────
function RolesPage({ roles, saveRoles, users, push, pop, toast$, isAdmin, can, isFullAdmin, isPlatsAdmin }) {
  if (!isAdmin && !can("canManageUsers")) return <Page><TopBar title="Roller" onBack={pop}/><div style={{padding:40,textAlign:"center",color:MU}}><i className="fa-solid fa-lock" style={{fontSize:32,marginBottom:12,display:"block"}}/>Du saknar behörighet.</div></Page>;
  const [confirmDel, setConfirmDel] = useState(null);
  const usersWithRole = id => users.filter(u => u.roleId === id).length;
  const del = async (role) => {
    await saveRoles((roles||[]).filter(r=>r.id!==role.id));
    toast$("Roll borttagen","success");
    setConfirmDel(null);
  };
  const right = isFullAdmin ? <Btn small onClick={()=>push("editrole",{role:null})}><Icon name="plus"/> Ny roll</Btn> : null;
  return (
    <Page>
      <TopBar title="Roller" onBack={pop} subtitle="Behörighetsmallar" right={right} />
      <div style={{padding:"14px 14px 40px",display:"flex",flexDirection:"column",gap:8}}>
        {isPlatsAdmin&&<div style={{background:AM+"12",border:`1px solid ${AM}40`,borderRadius:10,padding:"10px 14px",fontSize:12.5,color:TM,marginBottom:4}}><Icon name="triangle-exclamation" style={{color:AM,marginRight:6}}/>Roller hanteras av huvudadmin — du kan se dem här för att välja rätt roll åt dina användare.</div>}
        <div style={{fontSize:12,color:MU,marginBottom:4}}>Roller är färdiga behörighetspaket du kan tilldela användare. Ändra en roll så uppdateras alla som har den.</div>
        {(roles||[]).map(role=>{
          const count = ALL_PERMISSIONS.filter(p=>role.permissions?.[p.key]).length;
          const used = usersWithRole(role.id);
          return (
            <div key={role.id} style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,boxShadow:SH,padding:"12px 14px"}}>
              <div style={{display:"flex",alignItems:"center",gap:10}}>
                <div style={{width:14,height:14,borderRadius:4,background:role.color||BX,border:`1px solid ${BD}`,flexShrink:0}}/>
                <div style={{flex:1}}>
                  <div style={{fontWeight:700,fontSize:15}}>{role.name}</div>
                  <div style={{fontSize:12,color:MU}}>{count} behörigheter · {used} användare</div>
                </div>
                {isFullAdmin&&<Btn variant="ghost" small onClick={()=>push("editrole",{role})}><Icon name="pen"/></Btn>}
                {isFullAdmin&&<Btn variant="ghost" small onClick={()=>setConfirmDel(role)} style={{color:R}}><Icon name="trash"/></Btn>}
              </div>
            </div>
          );
        })}
        {(roles||[]).length===0&&<div style={{textAlign:"center",padding:30,color:MU}}>Inga roller än. Skapa en med "Ny roll".</div>}
      </div>

      {confirmDel&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.4)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:200,padding:20}} onClick={()=>setConfirmDel(null)}>
          <div onClick={e=>e.stopPropagation()} style={{background:WH,borderRadius:14,padding:20,maxWidth:340,width:"100%"}}>
            <div style={{fontWeight:700,fontSize:15,marginBottom:8}}>Ta bort rollen "{confirmDel.name}"?</div>
            <div style={{fontSize:13,color:MU,marginBottom:16}}>
              {usersWithRole(confirmDel.id)>0
                ? `${usersWithRole(confirmDel.id)} användare har den här rollen. De blir utan roll (behåller bara ev. egna behörigheter).`
                : "Detta går inte att ångra."}
            </div>
            <div style={{display:"flex",gap:8}}>
              <Btn full variant="ghost" onClick={()=>setConfirmDel(null)}>Avbryt</Btn>
              <Btn full variant="red" onClick={()=>del(confirmDel)}>Ta bort</Btn>
            </div>
          </div>
        </div>
      )}
    </Page>
  );
}

// ─── Edit Role Page ───────────────────────────────────────────────────────────
function EditRolePage({ role, roles, saveRoles, pop, toast$ }) {
  const [f, setF] = useState(role ? {...role, permissions:{...role.permissions}} : { name:"", color:"#1B3A6B", permissions:{} });
  const set = (k,v) => setF(p=>({...p,[k]:v}));
  const togglePerm = k => setF(p=>({...p,permissions:{...p.permissions,[k]:!p.permissions?.[k]}}));
  const COLORS = ["#1B3A6B","#CC1B2B","#2E7D32","#E65100","#6A1B9A","#00838F","#757575"];

  const save = async () => {
    if (!f.name.trim()) { toast$("Ge rollen ett namn","error"); return; }
    if (f.id) {
      await saveRoles((roles||[]).map(r=>r.id===f.id?f:r));
      toast$("Roll uppdaterad","success");
    } else {
      await saveRoles([...(roles||[]), {...f, id:genId("role")}]);
      toast$("Roll skapad","success");
    }
    pop();
  };

  // Gruppera behörigheter för tydlighet
  const groups = [
    { title:"Lager", keys:["canView","canAdd","canEdit","canDelete","canBulkEdit","canScan","canImport","canExport"] },
    { title:"Försäljning", keys:["canSell","canUseCheckout","canPrintReceipt"] },
    { title:"Reservationer", keys:["canViewReservations","canAddReservations","canEditReservations"] },
    { title:"Logg & rapporter", keys:["canViewLog","canViewActivityLog","canViewDashboard","canViewReports"] },
    { title:"Administration", keys:["canManageSuppliers","canBackup","canManageUsers","canManageSettings"] },
  ];

  return (
    <Page>
      <TopBar title={role?"Redigera roll":"Ny roll"} onBack={pop} right={<Btn small onClick={save}><Icon name="check"/> Spara</Btn>} />
      <div style={{padding:"14px 14px 60px"}}>
        <div style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,padding:14,marginBottom:12}}>
          <label style={{fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7}}>Rollnamn</label>
          <input type="text" value={f.name} onChange={e=>set("name",e.target.value)} placeholder="t.ex. Säljare"
            style={{width:"100%",border:`1.5px solid ${BD}`,borderRadius:7,padding:"9px 12px",fontSize:14,fontWeight:600,marginTop:4,marginBottom:12}}/>
          <label style={{fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7}}>Färg</label>
          <div style={{display:"flex",gap:8,marginTop:6}}>
            {COLORS.map(c=>(
              <button key={c} onClick={()=>set("color",c)} style={{width:30,height:30,borderRadius:7,background:c,border:f.color===c?`3px solid ${TX}`:`2px solid ${BD}`,cursor:"pointer"}}/>
            ))}
          </div>
        </div>

        {groups.map(g=>(
          <div key={g.title} style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,padding:14,marginBottom:10}}>
            <div style={{fontSize:12,fontWeight:800,color:BX,textTransform:"uppercase",letterSpacing:.5,marginBottom:10}}>{g.title}</div>
            <div style={{display:"flex",flexDirection:"column",gap:8}}>
              {g.keys.map(key=>{
                const perm = ALL_PERMISSIONS.find(p=>p.key===key);
                if (!perm) return null;
                const on = !!f.permissions?.[key];
                return (
                  <button key={key} onClick={()=>togglePerm(key)} style={{display:"flex",alignItems:"center",gap:10,padding:"8px 10px",borderRadius:8,border:`1.5px solid ${on?BX:BD}`,background:on?B+"0C":WH,cursor:"pointer",textAlign:"left"}}>
                    <div style={{width:34,height:20,borderRadius:10,background:on?BX:BD,position:"relative",flexShrink:0,transition:"background .15s"}}>
                      <div style={{position:"absolute",top:2,left:on?16:2,width:16,height:16,borderRadius:"50%",background:WH,transition:"left .15s"}}/>
                    </div>
                    <i className={`fa-solid ${perm.icon}`} style={{color:on?BX:MU,width:16,textAlign:"center"}}/>
                    <span style={{fontSize:13,fontWeight:600,color:on?TX:TM}}>{perm.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </Page>
  );
}

// ─── Edit User Page ───────────────────────────────────────────────────────────
// ─── Min profil — varje inloggad användare hanterar sitt eget konto ──────────
function ProfilePage({ currentUser, users, saveUsers, pop, toast$, theme, setTheme }) {
  if (!currentUser) return <Page><TopBar title="Min profil" onBack={pop}/><div style={{padding:40,textAlign:"center",color:MU}}>Logga in för att se din profil.</div></Page>;

  const [email, setEmail] = useState(currentUser.email || "");
  const [phone, setPhone] = useState(currentUser.phone || "");
  const [oldPw, setOldPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [saving, setSaving] = useState(false);

  const saveContact = async () => {
    setSaving(true);
    await saveUsers(users.map(u => u.id===currentUser.id ? {...u, email:email.trim(), phone:phone.trim()} : u));
    setSaving(false);
    toast$("Kontaktuppgifter sparade","success");
  };

  const savePassword = async () => {
    if (!oldPw.trim()) { toast$("Fyll i ditt nuvarande lösenord","error"); return; }
    if (!newPw.trim() || newPw.length < 4) { toast$("Det nya lösenordet måste vara minst 4 tecken","error"); return; }
    if (newPw !== confirmPw) { toast$("De nya lösenorden matchar inte","error"); return; }
    setSaving(true);
    try {
      const r = await fetch(`${API}/change-own-password`, {
        method: "POST", headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ oldPassword: oldPw.trim(), newPassword: newPw.trim() }),
      }).then(r => r.json());
      if (!r.ok) {
        toast$(r.error || "Kunde inte byta lösenord", "error");
      } else {
        setOldPw(""); setNewPw(""); setConfirmPw("");
        toast$("Lösenord uppdaterat","success");
      }
    } catch {
      toast$("Kunde inte nå servern","error");
    }
    setSaving(false);
  };

  const THEME_OPTIONS = [
    { k:"system", l:"Följer system", icon:"circle-half-stroke", desc:"Byter automatiskt med enhetens ljusa/mörka läge" },
    { k:"light",  l:"Ljust",         icon:"sun",                desc:"Alltid ljust tema på den här enheten" },
    { k:"dark",   l:"Mörkt",         icon:"moon",               desc:"Alltid mörkt tema på den här enheten" },
  ];

  return (
    <Page>
      <TopBar title="Min profil" onBack={pop} subtitle={currentUser.username}/>
      <div style={{padding:"14px 14px 40px",display:"flex",flexDirection:"column",gap:14}}>

        {/* Konto-info */}
        <div style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,padding:16,display:"flex",alignItems:"center",gap:12}}>
          <div style={{width:44,height:44,borderRadius:10,background:currentUser.role==="admin"?R:BX,display:"flex",alignItems:"center",justifyContent:"center",color:WH,fontWeight:800,fontSize:17,flexShrink:0}}>
            {currentUser.username[0].toUpperCase()}
          </div>
          <div style={{minWidth:0}}>
            <div style={{fontWeight:700,fontSize:15}}>{currentUser.username}</div>
            <div style={{fontSize:12,color:MU}}>{currentUser.role==="admin"?"Administratör":(currentUser.roleId ? "Anpassad roll" : "Användare")}</div>
          </div>
        </div>

        {/* Kontaktuppgifter */}
        <div style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,padding:16}}>
          <div style={{fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:12}}>Kontaktuppgifter</div>
          <div style={{display:"flex",flexDirection:"column",gap:12}}>
            <Inp label="E-post" type="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="namn@exempel.se"/>
            <Inp label="Telefon" type="tel" value={phone} onChange={e=>setPhone(e.target.value)} placeholder="070-123 45 67"/>
          </div>
          <div style={{marginTop:12}}>
            <Btn onClick={saveContact} disabled={saving}><Icon name="check"/> Spara kontaktuppgifter</Btn>
          </div>
        </div>

        {/* Byt lösenord */}
        <div style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,padding:16}}>
          <div style={{fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:12}}>Byt lösenord</div>
          <div style={{display:"flex",flexDirection:"column",gap:12}}>
            <div style={{position:"relative"}}>
              <label style={{display:"block",fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:4}}>Nuvarande lösenord</label>
              <input type={showPw?"text":"password"} value={oldPw} onChange={e=>setOldPw(e.target.value)} placeholder="Ditt nuvarande lösenord"
                style={{width:"100%",border:`1.5px solid ${BD}`,borderRadius:6,padding:"9px 40px 9px 12px",fontSize:14,boxSizing:"border-box"}}/>
              <button onClick={()=>setShowPw(v=>!v)} type="button" style={{position:"absolute",right:8,top:28,background:"none",border:"none",color:MU,cursor:"pointer",padding:6}}>
                <i className={`fa-solid fa-${showPw?"eye-slash":"eye"}`}/>
              </button>
            </div>
            <Inp label="Nytt lösenord" type={showPw?"text":"password"} value={newPw} onChange={e=>setNewPw(e.target.value)} placeholder="Minst 4 tecken"/>
            <Inp label="Bekräfta nytt lösenord" type={showPw?"text":"password"} value={confirmPw} onChange={e=>setConfirmPw(e.target.value)} placeholder="Upprepa lösenordet"/>
          </div>
          <div style={{marginTop:12}}>
            <Btn variant="red" onClick={savePassword} disabled={saving}><Icon name="key"/> Uppdatera lösenord</Btn>
          </div>
        </div>

        {/* Tema */}
        <div style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,padding:16}}>
          <div style={{fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:12}}>Utseende — den här enheten</div>
          <div style={{display:"flex",flexDirection:"column",gap:8}}>
            {THEME_OPTIONS.map(o=>(
              <button key={o.k} onClick={()=>setTheme(o.k)}
                style={{display:"flex",alignItems:"center",gap:12,padding:"11px 12px",borderRadius:9,border:`2px solid ${theme===o.k?BX:BD}`,background:theme===o.k?B+"08":WH,cursor:"pointer",textAlign:"left"}}>
                <div style={{width:34,height:34,borderRadius:8,background:theme===o.k?BX:BG,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                  <Icon name={o.icon} style={{color:theme===o.k?WH:MU,fontSize:14}}/>
                </div>
                <div style={{flex:1}}>
                  <div style={{fontWeight:700,fontSize:13,color:theme===o.k?BX:TX}}>{o.l}</div>
                  <div style={{fontSize:11,color:MU}}>{o.desc}</div>
                </div>
                {theme===o.k&&<Icon name="check" style={{color:BX}}/>}
              </button>
            ))}
          </div>
          <div style={{fontSize:11,color:MU,marginTop:10}}>Valet sparas bara på den här enheten/webbläsaren — andra som loggar in på andra enheter påverkas inte.</div>
        </div>
      </div>
    </Page>
  );
}


function EditUserPage({ user, users, roles, saveUsers, pop, toast$, lists, currentUser, isFullAdmin, isPlatsAdmin }) {
  // Lösenordsfältet är alltid tomt vid redigering — den lagrade hashen kan
  // inte (och ska inte) visas upp som klartext. Lämnas fältet tomt vid
  // sparning behålls det befintliga lösenordet oförändrat.
  const lockedWarehouse = isPlatsAdmin ? currentUser.homeWarehouse : null;
  const [f, setF] = useState(user ? {...user, password:""} : {username:"",password:"",role:"user",permissions:{},homeWarehouse:lockedWarehouse||"",notifyOtherWarehouseReservations:false});
  const WHS = lists?.warehouses||WAREHOUSES;
  const [showPw, setShowPw] = useState(false);
  const set = (k,v) => {
    // Platsadmin kan aldrig ändra hemmalager bort från sitt eget — varken
    // för sig själv eller för nya/redigerade användare de skapar.
    if (k==="homeWarehouse" && lockedWarehouse) return;
    setF(p=>({...p,[k]:v}));
  };
  const togglePerm = k => setF(p=>({...p,permissions:{...p.permissions,[k]:!p.permissions?.[k]}}));
  const save = async () => {
    if (!f.username.trim()) { toast$("Fyll i användarnamn","error"); return; }
    if (!user && !f.password.trim()) { toast$("Lösenord krävs för ny användare","error"); return; }
    // Extra skydd (utöver att UI:t redan låser fältet): en platsadmin kan
    // aldrig spara en användare med ett annat hemmalager än sitt eget.
    const finalF = lockedWarehouse ? { ...f, homeWarehouse: lockedWarehouse } : f;

    // Skydd: får inte göra den SISTA huvudadminen (admin utan hemmalager)
    // till något annat (annan roll, eller ge dem ett hemmalager så de blir
    // en begränsad platsadmin istället) — då finns ingen kvar som kan
    // hantera hela systemet.
    if (finalF.id) {
      const wasHuvudadmin = user?.role==="admin" && !user?.homeWarehouse;
      const stillHuvudadmin = finalF.role==="admin" && !finalF.homeWarehouse;
      const otherHuvudadmins = users.filter(u=>u.id!==finalF.id && u.role==="admin" && !u.homeWarehouse).length;
      if (wasHuvudadmin && !stillHuvudadmin && otherHuvudadmins===0) {
        toast$("Går inte — måste finnas minst en huvudadmin (utan hemmalager)","error");
        return;
      }
    }

    // Lösenordet hashas alltid på SERVERN, aldrig i webbläsaren — se
    // servens hantering av fältet newPlainPassword. Lämnas fältet tomt vid
    // redigering av en befintlig användare behålls det gamla lösenordet
    // automatiskt (servern bevarar det om inget nytt anges).
    if (finalF.id) {
      const { password, ...rest } = finalF;
      const updated = { ...rest, ...(password.trim() ? { newPlainPassword: password.trim() } : {}) };
      await saveUsers(users.map(u=>u.id===finalF.id?updated:u));
      toast$("Uppdaterad","success");
    } else {
      if (users.find(u=>u.username.toLowerCase()===finalF.username.toLowerCase())) { toast$("Användarnamnet är taget","error"); return; }
      const { password, ...rest } = finalF;
      await saveUsers([...users,{...rest,newPlainPassword:password.trim(),id:genId("user"),createdAt:Date.now()}]);
      toast$("Skapad","success");
    }
    pop();
  };
  return (
    <Page>
      <TopBar title={user?"Redigera användare":"Ny användare"} onBack={pop} right={<Btn small onClick={save}>Spara</Btn>} />
      <div style={{padding:"14px 14px 40px",display:"flex",flexDirection:"column",gap:12}}>
        <div style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,padding:16,display:"flex",flexDirection:"column",gap:14}}>
          <Inp label="Användarnamn *" value={f.username} onChange={e=>set("username",e.target.value)}/>
          <div>
            <label style={{display:"block",fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:4}}>{user?"Nytt lösenord (lämna tomt för att behålla)":"Lösenord *"}</label>
            <div style={{position:"relative"}}>
              <input type={showPw?"text":"password"} value={f.password} onChange={e=>set("password",e.target.value)} placeholder={user?"••••••••":""}
                style={{width:"100%",border:`1.5px solid ${BD}`,borderRadius:6,padding:"9px 40px 9px 12px",fontSize:14}}/>
              <button onClick={()=>setShowPw(v=>!v)} type="button" style={{position:"absolute",right:8,top:"50%",transform:"translateY(-50%)",background:"none",border:"none",color:MU,cursor:"pointer",padding:6}}>
                <i className={`fa-solid fa-${showPw?"eye-slash":"eye"}`}/>
              </button>
            </div>
            {user&&<div style={{fontSize:11,color:MU,marginTop:4}}>Av säkerhetsskäl lagras lösenord krypterat och kan inte visas i efterhand. Skriv ett nytt här för att hjälpa en användare som glömt sitt — toggla ögat för att se vad du skrivit innan du sparar.</div>}
          </div>
          <div>
            <label style={{display:"block",fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:8}}>Roll</label>
            <div style={{display:"flex",gap:8}}>
              {[{v:"user",l:"Användare"},{v:"admin",l:"Admin"}].map(({v,l})=>(
                <button key={v} onClick={()=>set("role",v)} style={{flex:1,padding:"9px",borderRadius:8,border:`2px solid ${f.role===v?BX:BD}`,background:f.role===v?B+"10":WH,color:f.role===v?BX:MU,fontWeight:600,fontSize:13}}>
                  {l}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Lager-tillhörighet — styr vilket lager man fullt ut kan redigera/sälja i */}
        <div style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,padding:16}}>
          <div style={{fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.8,marginBottom:6}}>Hemmalager</div>
          <div style={{fontSize:12,color:TM,marginBottom:10}}>
            Delar utanför det egna lagret går fortfarande att <b>se och reservera</b> — men bara redigera/sälja/ta bort i det egna lagret. Lämna tomt för ingen begränsning (t.ex. huvudadmin).
          </div>
          {lockedWarehouse ? (
            <div style={{width:"100%",padding:"9px 12px",border:`1.5px solid ${BD}`,borderRadius:7,fontSize:13,color:TX,background:BG,display:"flex",alignItems:"center",gap:8}}>
              <Icon name="lock" style={{fontSize:11,color:MU}}/>{lockedWarehouse} <span style={{fontSize:11,color:MU,marginLeft:"auto"}}>Låst — du är platsadmin för {lockedWarehouse}</span>
            </div>
          ) : (
            <select value={f.homeWarehouse||""} onChange={e=>set("homeWarehouse",e.target.value)}
              style={{width:"100%",padding:"9px 12px",border:`1.5px solid ${BD}`,borderRadius:7,fontSize:13,color:f.homeWarehouse?TX:MU,background:WH}}>
              <option value="">Inget — full åtkomst till alla lager</option>
              {WHS.map(w=><option key={w} value={w}>{w}</option>)}
            </select>
          )}
          {f.homeWarehouse&&(
            <div onClick={()=>set("notifyOtherWarehouseReservations",!f.notifyOtherWarehouseReservations)}
              style={{display:"flex",alignItems:"center",gap:12,padding:"12px 8px",borderRadius:8,cursor:"pointer",marginTop:10}}>
              <div style={{flex:1}}>
                <div style={{fontSize:13,fontWeight:600,color:TX}}>Mejla mig vid reservationer från andra lager</div>
                <div style={{fontSize:11,color:MU,marginTop:1}}>Får ett mejl när någon i ett annat lager reserverar en del i {f.homeWarehouse}</div>
              </div>
              <div style={{width:42,height:24,borderRadius:12,background:f.notifyOtherWarehouseReservations?BX:BD,position:"relative",transition:"background .2s",flexShrink:0}}>
                <div style={{position:"absolute",top:3,left:f.notifyOtherWarehouseReservations?20:3,width:18,height:18,borderRadius:"50%",background:WH,boxShadow:"0 1px 3px rgba(0,0,0,.2)",transition:"left .2s"}}/>
              </div>
            </div>
          )}
        </div>

        {f.role==="user" && (
          <div style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,padding:16}}>
            <div style={{fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.8,marginBottom:10}}>Roll (färdigt behörighetspaket)</div>
            <div style={{display:"flex",flexDirection:"column",gap:6,marginBottom:8}}>
              <button onClick={()=>set("roleId",null)} style={{display:"flex",alignItems:"center",gap:10,padding:"10px 12px",borderRadius:8,border:`1.5px solid ${!f.roleId?BX:BD}`,background:!f.roleId?B+"0C":WH,cursor:"pointer",textAlign:"left"}}>
                <div style={{width:12,height:12,borderRadius:3,background:MU,flexShrink:0}}/>
                <span style={{fontSize:13,fontWeight:600,color:!f.roleId?TX:TM}}>Ingen roll — bara egna behörigheter nedan</span>
              </button>
              {(roles||[]).map(role=>(
                <button key={role.id} onClick={()=>set("roleId",role.id)} style={{display:"flex",alignItems:"center",gap:10,padding:"10px 12px",borderRadius:8,border:`1.5px solid ${f.roleId===role.id?BX:BD}`,background:f.roleId===role.id?B+"0C":WH,cursor:"pointer",textAlign:"left"}}>
                  <div style={{width:12,height:12,borderRadius:3,background:role.color||BX,border:`1px solid ${BD}`,flexShrink:0}}/>
                  <span style={{fontSize:13,fontWeight:600,color:f.roleId===role.id?TX:TM,flex:1}}>{role.name}</span>
                  <span style={{fontSize:11,color:MU}}>{ALL_PERMISSIONS.filter(p=>role.permissions?.[p.key]).length} behörigheter</span>
                </button>
              ))}
            </div>
            <div style={{fontSize:11,color:MU,marginBottom:4}}>Rollen ger en grunduppsättning behörigheter. Du kan ge extra behörigheter utöver rollen här under:</div>
          </div>
        )}

        {f.role==="user" && (
          <div style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,padding:16}}>
            <div style={{fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.8,marginBottom:12}}>{f.roleId?"Extra behörigheter (utöver rollen)":"Behörigheter"}</div>
            {ALL_PERMISSIONS.map(({key,label,icon})=>{
              const fromRole = f.roleId && (roles||[]).find(r=>r.id===f.roleId)?.permissions?.[key];
              const on = f.permissions?.[key] || fromRole;
              return (
              <div key={key} onClick={()=>!fromRole&&togglePerm(key)}
                style={{display:"flex",alignItems:"center",gap:12,padding:"12px 8px",borderRadius:8,cursor:fromRole?"default":"pointer",background:on?B+"08":"transparent",marginBottom:4,opacity:fromRole?0.7:1}}>
                <div style={{width:32,height:32,borderRadius:8,background:on?B+"18":BG,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}><Icon name={icon.replace("fa-","")} style={{fontSize:14,color:on?BX:MU}}/></div>
                <span style={{flex:1,fontSize:14,fontWeight:500,color:on?TX:MU}}>{label}{fromRole&&<span style={{fontSize:10,color:BX,marginLeft:6,fontWeight:700}}>(från roll)</span>}</span>
                <div style={{width:42,height:24,borderRadius:12,background:on?BX:BD,position:"relative",transition:"background .2s",flexShrink:0}}>
                  <div style={{position:"absolute",top:3,left:on?20:3,width:18,height:18,borderRadius:"50%",background:WH,boxShadow:"0 1px 3px rgba(0,0,0,.2)",transition:"left .2s"}}/>
                </div>
              </div>
              );
            })}
          </div>
        )}
        {f.role==="admin" && (
          <div style={{background:B+"08",border:`1px solid ${B}20`,borderRadius:10,padding:"12px 16px",fontSize:13,color:BX,fontWeight:500}}>
            OK Admin har automatiskt alla behörigheter
          </div>
        )}
      </div>
    </Page>
  );
}

// ─── Permissions Page ─────────────────────────────────────────────────────────
function PermsPage({ user, users, saveUsers, pop, toast$ }) {
  const [p, setP] = useState({...user.permissions});
  const toggle = k => setP(prev=>({...prev,[k]:!prev[k]}));
  const save = async () => {
    await saveUsers(users.map(u=>u.id===user.id?{...u,permissions:p}:u));
    toast$("Behörigheter sparade","success"); pop();
  };
  return (
    <Page>
      <TopBar title={`Behörigheter — ${user.username}`} onBack={pop} right={<Btn small onClick={save}>Spara</Btn>} />
      <div style={{padding:"14px 14px 40px"}}>
        {ALL_PERMISSIONS.map(({key,label,icon})=>(
          <div key={key} onClick={()=>toggle(key)} style={{display:"flex",alignItems:"center",gap:12,padding:"14px",borderRadius:10,cursor:"pointer",background:p[key]?B+"08":WH,border:`1px solid ${p[key]?B+"25":BD}`,marginBottom:8,transition:"background .1s"}}>
            <div style={{width:34,height:34,borderRadius:8,background:p[key]?B+"18":BG,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}><Icon name={icon.replace("fa-","")} style={{fontSize:15,color:p[key]?BX:MU}}/></div>
            <span style={{flex:1,fontSize:14,fontWeight:500,color:p[key]?TX:MU}}>{label}</span>
            <div style={{width:44,height:24,borderRadius:12,background:p[key]?BX:BD,position:"relative",transition:"background .2s",flexShrink:0}}>
              <div style={{position:"absolute",top:3,left:p[key]?22:3,width:18,height:18,borderRadius:"50%",background:WH,boxShadow:"0 1px 3px rgba(0,0,0,.2)",transition:"left .2s"}}/>
            </div>
          </div>
        ))}
      </div>
    </Page>
  );
}

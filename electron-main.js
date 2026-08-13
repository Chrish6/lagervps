// ─── Lager — Electron main process (VPS-VARIANT) ─────────────────────────────
// Skillnaden mot electron-main.js: den vanliga varianten SÖKER upp servern på
// det lokala nätverket (localhost → lager.local → nätverksskanning). Den här
// varianten ansluter istället direkt till en FAST adress på internet — ingen
// sökning behövs, eftersom servern inte längre finns på samma WiFi.
//
// VIKTIGT: fyll i din riktiga adress i SERVER_URL nedan innan du bygger appen.
const { app, BrowserWindow, Tray, Menu, nativeImage, shell, dialog, ipcMain, safeStorage } = require("electron");
const path  = require("path");
const fs    = require("fs");
const http  = require("http");
const https = require("https");

// ── Fyll i din riktiga VPS-adress här när du har domän + HTTPS uppsatt ──
// Exempel: "https://lager.dittforetag.se"
const SERVER_URL = "https://ANDRA-DETTA.exempel.se";

let mainWindow = null;
let tray       = null;

// ─── Säker lagring av inloggningsuppgifter ("Kom ihåg mig") ─────────────────
// Samma mekanism som i electron-main.js (Windows) — se den filen för
// kommentarer. Identisk kod, ingen anledning att skilja sig här.
const CREDENTIALS_PATH = path.join(app.getPath("userData"), "credentials.enc");

ipcMain.handle("credentials:save", (event, { username, password }) => {
  try {
    if (!safeStorage.isEncryptionAvailable()) return { ok:false, error:"Kryptering ej tillgänglig på den här datorn" };
    const payload = JSON.stringify({ username, password });
    const encrypted = safeStorage.encryptString(payload);
    fs.writeFileSync(CREDENTIALS_PATH, encrypted);
    return { ok:true };
  } catch (e) {
    return { ok:false, error: e.message };
  }
});

ipcMain.handle("credentials:get", () => {
  try {
    if (!fs.existsSync(CREDENTIALS_PATH)) return null;
    if (!safeStorage.isEncryptionAvailable()) return null;
    const encrypted = fs.readFileSync(CREDENTIALS_PATH);
    const payload = safeStorage.decryptString(encrypted);
    return JSON.parse(payload);
  } catch {
    return null;
  }
});

ipcMain.handle("credentials:clear", () => {
  try {
    if (fs.existsSync(CREDENTIALS_PATH)) fs.unlinkSync(CREDENTIALS_PATH);
    return { ok:true };
  } catch (e) {
    return { ok:false, error: e.message };
  }
});

// ─── Kontrollera att servern svarar (används vid krasch-återhämtning) ────────
function probeServer(url) {
  return new Promise(resolve => {
    const mod = url.startsWith("https:") ? https : http;
    const req = mod.get(`${url}/api/network`, { timeout: 3000 }, res => {
      let data = "";
      res.on("data", d => data += d);
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          resolve(!!(json && Array.isArray(json.ips)));
        } catch { resolve(res.statusCode >= 200 && res.statusCode < 400); }
      });
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

// ─── Skapa fönstret ───────────────────────────────────────────────────────────
function createWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1280, height: 820, minWidth: 800, minHeight: 600,
    title: "Lager",
    backgroundColor: "#F5F5F7",
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
    },
    show: false,
  });

  mainWindow.loadURL(url);
  mainWindow.once("ready-to-show", () => mainWindow.show());

  mainWindow.webContents.setWindowOpenHandler(({ url: u }) => {
    if (!u.startsWith(url)) { shell.openExternal(u); return { action: "deny" }; }
    return { action: "allow" };
  });

  // ── Krasch-återställning — laddar om bara vid faktiska krascher ──
  let reloading = false;
  const safeReload = () => {
    if (reloading || !mainWindow || mainWindow.isDestroyed()) return;
    reloading = true;
    const tryReload = (attempts = 0) => {
      if (!mainWindow || mainWindow.isDestroyed()) { reloading = false; return; }
      probeServer(url).then(ok => {
        if (ok) {
          mainWindow.loadURL(url);
          reloading = false;
        } else if (attempts < 30) {
          setTimeout(() => tryReload(attempts + 1), 2000);
        } else {
          reloading = false;
        }
      });
    };
    tryReload();
  };

  mainWindow.webContents.on("render-process-gone", (event, details) => {
    console.log("[recovery] Render-processen kraschade:", details.reason);
    safeReload();
  });

  // Ladda om när datorn vaknar från viloläge (t.ex. laptop som slagit igen locket)
  const { powerMonitor } = require("electron");
  powerMonitor.on("resume", () => {
    console.log("[recovery] Datorn vaknade — kontrollerar anslutning...");
    safeReload();
  });

  mainWindow.on("closed", () => { mainWindow = null; });
}

// ─── System tray ─────────────────────────────────────────────────────────────
function createTray() {
  const icon = nativeImage.createFromDataURL(
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABmJLR0QA/wD/AP+gvaeTAAAAQ0lEQVQ4jWNgGAVkgv8MGBhYGBgY/hMh6z8IA6MBgxEGBgaG/5iMpJoGsmE0YDBiNGCwYjRgsGI0YLBiNBgFpAIAWNACIb2Pz0QAAAAASUVORK5CYII="
  );
  tray = new Tray(icon);
  tray.setToolTip(`Lager — ${SERVER_URL}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Server: ${SERVER_URL}`, enabled: false },
    { type: "separator" },
    { label: "Öppna Lager", click: () => { if (mainWindow) mainWindow.show(); else createWindow(SERVER_URL); } },
    { label: "Avsluta", click: () => app.quit() },
  ]));
  tray.on("double-click", () => { if (mainWindow) mainWindow.show(); else createWindow(SERVER_URL); });
}

// ─── App lifecycle ────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  if (SERVER_URL.includes("ANDRA-DETTA")) {
    dialog.showErrorBox(
      "Lager — Adress inte inställd",
      "SERVER_URL i electron-main.vps.js är inte ifylld ännu.\n\n" +
      "Öppna filen och byt ut exempeladressen mot din riktiga VPS-adress, t.ex.:\n" +
      "https://lager.dittforetag.se"
    );
    app.quit();
    return;
  }

  createTray();

  console.log(`[anslutning] Kontrollerar ${SERVER_URL}...`);
  const ok = await probeServer(SERVER_URL);

  if (!ok) {
    dialog.showErrorBox(
      "Lager — Kunde inte nå servern",
      `Kunde inte ansluta till ${SERVER_URL}.\n\n` +
      "Kontrollera att:\n" +
      "• Du har internetanslutning\n" +
      "• VPS:en är igång (pm2 status på servern)\n" +
      "• Adressen i SERVER_URL är korrekt\n\n" +
      "Starta om Lager när anslutningen fungerar."
    );
    app.quit();
    return;
  }

  console.log(`[anslutning] Ansluten till: ${SERVER_URL}`);
  createWindow(SERVER_URL);
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow(SERVER_URL);
});

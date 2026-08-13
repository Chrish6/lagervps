// ─── Lager — Preload script ───────────────────────────────────────────────────
// Exponerar EN säker, avgränsad API-yta till webbsidan (renderer-processen)
// via contextBridge — appen kan aldrig få full Node.js-åtkomst (nodeIntegration
// är avstängt), bara exakt de här tre funktionerna för att spara/hämta/rensa
// inloggningsuppgifter. Själva krypteringen sker i huvudprocessen med
// Electrons safeStorage, som i sin tur använder operativsystemets egna
// skydd (Windows: DPAPI, kopplat till den inloggade Windows-användaren).
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  saveCredentials: (creds) => ipcRenderer.invoke("credentials:save", creds),
  getSavedCredentials: () => ipcRenderer.invoke("credentials:get"),
  clearCredentials: () => ipcRenderer.invoke("credentials:clear"),
});

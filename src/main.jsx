import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";

createRoot(document.getElementById("root")).render(<App/>);

// Service worker-registrering — låg tidigare som en inline <script>-tagg i
// index.html. Flyttad hit (till en riktig, extern modulfil) så att
// Content-Security-Policy kan sätta en strikt script-src UTAN att behöva
// tillåta 'unsafe-inline' bara för denna enda lilla bit — inline-skript är
// annars en av de vanligaste vägarna in för XSS-attacker.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}

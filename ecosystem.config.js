module.exports = {
  apps: [{
    name: "lager",
    script: "server.cjs",
    node_args: "--max-old-space-size=2048",
    max_memory_restart: "1G",
    autorestart: true,
    watch: false,
    env: {
      NODE_ENV: "production",
      PORT: 3000, // nginx (reverse proxy) skickar HTTPS-trafik hit lokalt
      // Fyll i efter att du kört `rclone config` för att backuper ska
      // skickas till OneDrive/Google Drive/m.fl., t.ex. "onedrive:Lager-backups".
      // Lämna tom sträng för att bara spara backuper lokalt på VPS:en.
      RCLONE_REMOTE: "",
      // Valfritt — sätt ett lösenord för admin-panelen (/admin). Utan detta
      // är panelen oskyddad förutom det vanliga admin-kontokravet.
      // ADMIN_PANEL_PASSWORD: "byt-till-nagot-eget",
    },
  }],
};

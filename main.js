const { app, BrowserWindow, protocol, net } = require('electron');
const path = require('path');
const fs   = require('fs');

app.whenReady().then(() => {
  // Serve Three.js from the bundled node_modules instead of CDN
  const CDN = 'https://cdn.jsdelivr.net/npm/three@0.160.0/';
  protocol.handle('https', async (request) => {
    if (request.url.startsWith(CDN)) {
      const rel  = request.url.slice(CDN.length);
      const file = path.join(app.getAppPath(), 'node_modules', 'three', rel);
      try {
        const data = fs.readFileSync(file);
        return new Response(data, {
          headers: { 'Content-Type': 'application/javascript; charset=utf-8' }
        });
      } catch { /* fall through to network */ }
    }
    return net.fetch(request.url, { bypassCustomProtocolHandlers: true });
  });

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 500,
    title: 'Cube Craft',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  win.loadFile('cube-craft.html');
  win.removeMenu();
});

app.on('window-all-closed', () => app.quit());

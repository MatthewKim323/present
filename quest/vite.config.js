import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// The world service runs on the laptop at :8787. We proxy /ws/* through the
// dev server so the page can use same-origin wss:// (an https page cannot open
// plain ws:// to a LAN ip: mixed content). Override with WORLD_URL.
const WORLD = process.env.WORLD_URL || 'http://localhost:8787';
const HTTPS = process.env.NO_HTTPS ? false : true;

export default defineConfig({
  plugins: HTTPS ? [basicSsl()] : [],
  server: {
    host: true,
    port: 5173,
    strictPort: true,
    proxy: {
      '/ws': { target: WORLD, ws: true, changeOrigin: true },
      '/events': { target: WORLD, changeOrigin: true },
    },
  },
});

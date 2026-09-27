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
    // ngrok (scripts/dev-up.sh --tunnel) keeps the public Host header; Vite blocks unknown hosts without this.
    allowedHosts: ['.ngrok-free.app', '.ngrok-free.dev', '.ngrok.app', '.ngrok.dev', '.ngrok.io'],
    proxy: {
      '/qm': { target: WORLD, changeOrigin: true },
      '/ws': { target: WORLD, ws: true, changeOrigin: true },
      '/tools': { target: WORLD, changeOrigin: true },
      '/panels': { target: WORLD, changeOrigin: true },
      '/panel-actions': { target: WORLD, changeOrigin: true },
      '/hud': { target: WORLD, changeOrigin: true },
      '/events': { target: WORLD, changeOrigin: true },
      '/builder': { target: WORLD, changeOrigin: true },
      '/people': { target: WORLD, changeOrigin: true },
      '/health': { target: WORLD, changeOrigin: true }, // ?diag=1 checks the world service through the same origin
      '/procedures': { target: WORLD, changeOrigin: true },
      '/debug': { target: WORLD, changeOrigin: true },
    },
  },
});

// Stand-in world service for developing the Quest client alone.
//   node scripts/mock-world.mjs            (listens on :8787, same paths as the real one)
// Logs frame/audio rates from /ws/quest, replays the demo HUD script to every
// client, and relays any HUD message POSTed to /hud (curl -d '{"kind":...}').
// Do not run this while the real perception service is up (both want :8787).
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { DEMO_SCRIPT } from '../src/mock.js';

const PORT = Number(process.env.PORT || 8787);
const clients = new Set();
const stats = { frame: 0, audio: 0, gesture: 0, label: 0, bytes: 0, lastFrame: null };

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && (req.url === '/hud' || req.url === '/events')) {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      broadcast(body);
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
    });
    return;
  }
  res.writeHead(200).end('mock world service\n');
});

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, sock, head) => {
  if (!req.url.startsWith('/ws/')) return sock.destroy();
  wss.handleUpgrade(req, sock, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws, req) => {
  clients.add(ws);
  console.log(`[mock] client ${req.url} (${clients.size} total)`);
  ws.on('close', () => clients.delete(ws));
  ws.on('message', (data) => {
    stats.bytes += data.length;
    let m;
    try { m = JSON.parse(data); } catch { return; }
    if (m.kind in stats) stats[m.kind]++;
    if (m.kind === 'frame') stats.lastFrame = `${m.w}x${m.h} pose=${JSON.stringify((m.head_pose || []).map((v) => +v.toFixed(2)))}`;
    if (m.kind === 'gesture' || m.kind === 'label') console.log('[mock] <-', JSON.stringify(m));
  });
  playScript(ws);
});

function playScript(ws) {
  const total = DEMO_SCRIPT[DEMO_SCRIPT.length - 1][0] + 2000;
  const run = () => {
    if (ws.readyState !== 1) return;
    ws.send(JSON.stringify({ kind: 'clear' }));
    for (const [t, msg] of DEMO_SCRIPT) setTimeout(() => ws.readyState === 1 && ws.send(JSON.stringify(msg)), t);
    setTimeout(run, total);
  };
  if (!process.env.NO_SCRIPT) run();
}

function broadcast(s) { for (const c of clients) if (c.readyState === 1) c.send(s); }

setInterval(() => {
  if (!stats.frame && !stats.audio) return;
  console.log(`[mock] 5s: frames=${stats.frame} audio=${stats.audio} ${(stats.bytes / 5 / 1024).toFixed(0)}KB/s last=${stats.lastFrame}`);
  stats.frame = stats.audio = stats.bytes = 0;
}, 5000);

server.listen(PORT, () => console.log(`[mock] world service on :${PORT} (/ws/quest, /ws/hud, POST /hud)`));

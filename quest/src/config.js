// All knobs are URL params so the headset can be tuned without a rebuild.
// e.g. https://<laptop>:5173/?fps=4&w=960&hfov=78&mock=1
const q = new URLSearchParams(location.search);
const num = (k, d) => (q.has(k) ? Number(q.get(k)) : d);

const defaultWs = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/quest`;

export const config = {
  wsUrl: q.get('ws') || defaultWs,       // proxied to :8787 by vite
  fps: num('fps', 5),                     // frames/sec sent to the world service
  width: num('w', 640),                   // frame width sent (height keeps aspect)
  jpegQuality: num('q', 0.7),
  audio: q.get('audio') !== '0',
  audioChunkMs: num('chunk', 250),
  hfov: num('hfov', 80),                  // passthrough camera horizontal FOV (deg), for anchoring
  cardDistance: num('dist', 1.6),         // meters in front of the head when no depth
  mock: q.get('mock') === '1',            // scripted HUD demo, no server needed
  camHint: q.get('cam') || '',            // substring of camera label to prefer
  source: q.get('source') || null,        // override WorldEvent source tag
};

import { DEV_SCRIPT } from './devpanels.js';

// Scripted demo sequence (?mock=1). Exercises all three HUD states with no server.
// Perception re-sends the track every frame; fake that at 1 Hz with a slight sway.
const TRACKS = Array.from({ length: 24 }, (_, i) => [i * 1000,
  { kind: 'track', track_id: 3, bbox: [0.38 + 0.02 * Math.sin(i / 2), 0.18, 0.22, 0.62], label: 'UNKNOWN PERSON 03' }]);

export const DEMO_SCRIPT = [
  ...TRACKS,
  [800, { kind: 'person_card', anchor_track_id: 3, person_id: 'matthew', name: 'MATTHEW', subtitle: 'lifelong friend · builder at Kali Labs',
    last: 'friends since 2019 · co-building at YC', owes_you: 'feedback on Opal', you_owe: 'Discord invite' }],
  [4000, { kind: 'memory_event', text: 'FEATURE REQUEST REMEMBERED', detail: 'Opal landing · How it works' }],
  [5200, { kind: 'memory_event', text: 'COMMITMENT REMEMBERED', detail: 'send Matthew the Discord invite' }],
  [6000, { kind: 'agent_activity', anchor_track_id: 3, hook: 'feature_request.detected', workers: [
    { name: 'Context', state: 'running', note: 'searching GBrain' },
    { name: 'Product', state: 'running', note: 'speccing How it works section' },
    { name: 'Builder', state: 'running', note: 'queued: How it works section' } ] }],
  [8500, { kind: 'agent_activity', anchor_track_id: 3, hook: 'feature_request.detected', workers: [
    { name: 'Context', state: 'done', note: 'Matthew · lifelong friend · Opal user' },
    { name: 'Product', state: 'done', note: '3 steps under hero, 2 checks' },
    { name: 'Builder', state: 'running', note: 'coding: How it works section' } ] }],
  [11000, { kind: 'agent_activity', anchor_track_id: 3, hook: 'feature_request.detected', workers: [
    { name: 'Context', state: 'done', note: 'Matthew · lifelong friend · Opal user' },
    { name: 'Product', state: 'done', note: '3 steps under hero, 2 checks' },
    { name: 'Builder', state: 'done', note: 'PR #5 opened on qtzx06/opal' } ] }],
  ...DEV_SCRIPT, // dev cockpit: context_delta, dev_session, dev_github
].sort((a, b) => a[0] - b[0]);

export function runMock(apply, { loop = true } = {}) {
  const timers = [];
  const total = DEMO_SCRIPT[DEMO_SCRIPT.length - 1][0] + 2000;
  const once = () => {
    apply({ kind: 'clear' });
    for (const [t, msg] of DEMO_SCRIPT) timers.push(setTimeout(() => apply(msg), t));
    if (loop) timers.push(setTimeout(once, total));
  };
  once();
  return () => timers.forEach(clearTimeout);
}

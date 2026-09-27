import { DEV_SCRIPT } from './devpanels.js';
import { VISION_SCRIPT, VISION_LEAD, mockResolve } from './visionfx.js';

// Scripted demo sequence (?mock=1). Exercises all three HUD states with no server.
// Track 3 is anchored by the scripted `vision` stream (visionfx.js: unknown face -> "I'm Matthew" ->
// learning filmstrip -> recognized), so the rest of the demo starts VISION_LEAD ms later.
const BASE_SCRIPT = [
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
];

export const DEMO_SCRIPT = [...VISION_SCRIPT, ...BASE_SCRIPT.map(([t, m]) => [t + VISION_LEAD, m])].sort((a, b) => a[0] - b[0]);

export function runMock(apply, { loop = true } = {}) {
  const timers = [];
  const total = DEMO_SCRIPT[DEMO_SCRIPT.length - 1][0] + 2000;
  const once = () => {
    apply({ kind: 'clear' });
    for (const [t, msg] of DEMO_SCRIPT) timers.push(setTimeout(() => apply(mockResolve(msg)), t));
    if (loop) timers.push(setTimeout(once, total));
  };
  once();
  return () => timers.forEach(clearTimeout);
}

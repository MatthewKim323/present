import { DEV_SCRIPT } from './devpanels.js';
import { VISION_SCRIPT, VISION_LEAD, mockResolve } from './visionfx.js';
import { MEMORY_SCRIPT } from './memorypanel.js';

// Scripted demo sequence (?mock=1). Exercises all three HUD states with no server.
// Track 3 is anchored by the scripted `vision` stream (visionfx.js: unknown face -> "I'm Matthew" ->
// learning filmstrip -> recognized), so the rest of the demo starts VISION_LEAD ms later.
const BASE_SCRIPT = [
  [800, { kind: 'person_card', anchor_track_id: 3, person_id: 'matthew', name: 'MATTHEW', subtitle: 'lifelong friend · builder at Kali Labs',
    last: 'friends since 2019 · co-building at YC', owes_you: 'feedback on Opal', you_owe: 'Discord invite' }],
  [4000, { kind: 'memory_event', text: 'FEATURE REQUEST REMEMBERED', detail: 'Opal bot · !recap' }],
  [5200, { kind: 'memory_event', text: 'COMMITMENT REMEMBERED', detail: 'ping Matthew when !recap ships' }],
  // the swarm itself is the QM SWARM panel (qm_swarm in DEV_SCRIPT); no separate agent_activity entries
  ...DEV_SCRIPT, // dev cockpit: context_delta, qm_swarm, dev_github
  ...MEMORY_SCRIPT, // Memorable: recording -> extracting -> learned, then recalled on run 2 (memorypanel.js)
];

export const DEMO_SCRIPT = [...VISION_SCRIPT, ...BASE_SCRIPT.map(([t, m]) => [t + VISION_LEAD, m])].sort((a, b) => a[0] - b[0]);

// ---- current demo, spatial QM swarm (swarmviz.js). Stephen wears the Quest, Matthew asks for
// a !recap command in Opal's Discord bot -> swarm -> Builder tool calls -> PR #6 -> PROCEDURE LEARNED;
// then run 2 (!streak): RECALLED PROCEDURE flies into Builder, fewer tool calls, faster finish.
// Appended after the older sequence; ?mock=1&mockseq=swarm plays only this part. Timings are
// choreography only, never metrics (real run 1 vs run 2 numbers come from QM).
const REPO = 'qtzx06/opal';
const BOT = 'discord-bot/core/bot.py';
// worker tuples are [name, state, note, extra?]
const swarm = (event_id, feature, ...rest) => {
  const extra = Array.isArray(rest[rest.length - 1]) ? {} : rest.pop();
  return { kind: 'qm_swarm', hook: 'feature_request.detected', event_id, anchor_track_id: 3, feature,
    workers: rest.map(([name, state, note, x]) => ({ name, state, note, ...(x || {}) })),
    ...(extra.top || {}) };
};
const tail = (...calls) => calls.map(([tool, target]) => ({ tool, target }));
const pr = (number, title, add, checks, older = []) => ({ kind: 'dev_github', repo: REPO, prs: [
  { number, title, branch: `world/${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, state: 'open', checks, additions: add, deletions: 0,
    files: [BOT], url: `https://github.com/${REPO}/pull/${number}`, preview_url: null, hunk_file: BOT,
    hunk: [{ t: ' ', s: '@bot.command()' }, { t: '+', s: `async def ${title.includes('streak') ? 'streak' : 'recap'}(ctx):` }] }, ...older] });
const R1 = ['Context', 'running', 'searching GBrain: Matthew, Opal'];
const LEARNED = { title: 'add_discord_prefix_command', steps: ['resolve person + project', 'read core/bot.py commands',
  'add @bot.command handler', 'reuse existing embed helpers', 'compile check (compileall)', 'open [WORLD] PR', 'post PR to HUD'] };
const T1 = [
  [0, 'Read', BOT], [1, 'Grep', '@bot.command discord-bot/core'], [2, 'Edit', BOT], [3, 'Edit', BOT],
  [4, 'Bash', 'python -m compileall discord-bot'], [5, 'Bash', 'git push -u origin world/add-recap'],
];
const SWARM_TRACKS = Array.from({ length: 48 }, (_, i) => [i * 1000,
  { kind: 'track', track_id: 3, bbox: [0.4 + 0.015 * Math.sin(i / 3), 0.16, 0.2, 0.64], label: 'MATTHEW' }]);
// GBrain traffic + Memorable lifecycle, so every system visibly connects in the graph.
const gop = (actor, op, x = {}) => ({ kind: 'gbrain_op', actor, op, ok: true, ...x });
const PROC = { title: LEARNED.title, steps: LEARNED.steps.length, source: 'qm-swarm', gbrain_slug: 'procedures/add-discord-prefix-command' };
const BRAIN_OPS = [
  [4700, gop('perception', 'get_page', { slug: 'people/matthew', ms: 22 })],
  [5300, gop('qm:Context', 'query', { query: 'Matthew Opal bot', hits: 4, ms: 38 })],
  [5900, gop('qm:Context', 'get_page', { slug: 'relationships/stephen-matthew', ms: 19 })],
  [6700, gop('live', 'add_timeline_entry', { slug: 'relationships/stephen-matthew', ms: 31 })],
  [7100, gop('qm:Product', 'query', { query: 'opal bot commands', hits: 2, ms: 44 })],
  [7300, { kind: 'procedure', phase: 'recording', source: 'qm-swarm', title: null, steps: null, tool_calls_seen: 1 }],
  [9800, { kind: 'procedure', phase: 'recording', source: 'qm-swarm', title: null, steps: null, tool_calls_seen: 3 }],
  [13200, { kind: 'procedure', phase: 'recording', source: 'qm-swarm', title: null, steps: null, tool_calls_seen: 6 }],
  [12600, gop('qm:Builder', 'put_page', { slug: 'projects/opal', ms: 51 })],
  [16800, { kind: 'procedure', phase: 'extracting', source: 'qm-swarm', title: null, steps: null }],
  [18100, { kind: 'procedure', phase: 'learned', ...PROC }],
  [28600, gop('qm:Context', 'query', { query: 'Matthew !streak', hits: 5, ms: 36 })],
  [28800, { kind: 'procedure', phase: 'recalled', ...PROC }],
  [29400, gop('perception', 'get_page', { slug: 'people/matthew', ms: 18 })],
  [30800, { kind: 'procedure', phase: 'recording', source: 'qm-swarm', title: null, steps: null, tool_calls_seen: 2 }],
  [33000, gop('qm:Builder', 'put_page', { slug: 'projects/opal', ms: 47 })],
];

export const SWARM_SCRIPT = [
  [0, { kind: 'clear' }],
  ...SWARM_TRACKS,
  [300, { kind: 'person_card', anchor_track_id: 3, person_id: 'matthew', name: 'MATTHEW', subtitle: 'Opal customer · builder at Kali Labs',
    last: 'Opal Discord bot', owes_you: 'feedback on Opal', you_owe: 'the !recap command' }],
  [2200, { kind: 'context_delta', person_id: 'matthew', delta_kind: 'fact', text: '+ wants a !recap command in the Opal bot' }],
  [3200, { kind: 'memory_event', text: 'FEATURE REQUEST REMEMBERED', detail: 'Opal Discord bot · !recap' }],
  [3800, swarm('evt_recap', '!recap', R1, ['Product', 'running', 'reading bot commands'], ['Builder', 'running', 'queued: !recap command'])],
  [6000, { kind: 'context_delta', person_id: 'matthew', delta_kind: 'preference', text: '+ runs weekly standups in Discord' }],
  [6400, swarm('evt_recap', '!recap', ['Context', 'done', 'Matthew · Opal customer · wants !recap'], ['Product', 'running', 'speccing: prefix command, 1 file'],
    ['Builder', 'running', 'coding: !recap', { tail: tail(T1[0].slice(1)) }])],
  ...T1.slice(1).map(([i], k) => [7600 + k * 1300, swarm('evt_recap', '!recap', ['Context', 'done', 'Matthew · Opal customer · wants !recap'],
    ['Product', k ? 'done' : 'running', k ? '1 file · compile check' : 'speccing: prefix command, 1 file'],
    ['Builder', 'running', i >= 5 ? 'opening PR' : 'coding: !recap', { tail: tail(...T1.slice(0, i + 1).map((x) => x.slice(1))) }])]),
  [13800, pr(6, '[WORLD] Add !recap command', 24, 'pending')],
  [14000, swarm('evt_recap', '!recap', ['Context', 'done', 'Matthew · Opal customer · wants !recap'], ['Product', 'done', '1 file · compile check'],
    ['Builder', 'running', 'PR #6 opened · compile check', { tail: tail(...T1.map((x) => x.slice(1))) }])],
  [16200, pr(6, '[WORLD] Add !recap command', 24, 'pass')],
  [16400, swarm('evt_recap', '!recap', ['Context', 'done', 'Matthew · Opal customer · wants !recap'], ['Product', 'done', '1 file · compile check'],
    ['Builder', 'done', 'PR #6 · compile ✓', { tail: tail(...T1.map((x) => x.slice(1))) }])],
  [18200, { kind: 'memory_event', text: 'PROCEDURE LEARNED', detail: `${LEARNED.title} · ${LEARNED.steps.length} steps` }],
  [18300, swarm('evt_recap', '!recap', ['Context', 'done', 'Matthew · Opal customer · wants !recap'], ['Product', 'done', '1 file · compile check'],
    ['Builder', 'done', 'PR #6 · compile ✓'], { top: { learned: LEARNED } })],

  // run 2: same kind of request, recall fires off the real-world event
  [27000, { kind: 'context_delta', person_id: 'matthew', delta_kind: 'fact', text: '+ also wants !streak for daily check-ins' }],
  [27800, { kind: 'memory_event', text: 'FEATURE REQUEST REMEMBERED', detail: 'Opal Discord bot · !streak' }],
  [28300, swarm('evt_streak', '!streak', R1, ['Product', 'running', 'reading bot commands'], ['Builder', 'running', 'queued: !streak command'])],
  [28900, { kind: 'memory_event', text: 'RECALLED PROCEDURE', detail: `${LEARNED.title} · ${LEARNED.steps.length} steps` }],
  [29000, swarm('evt_streak', '!streak', R1, ['Product', 'running', 'reading bot commands'], ['Builder', 'running', 'queued: !streak command'],
    { top: { recalled: LEARNED } })],
  [30600, swarm('evt_streak', '!streak', ['Context', 'done', 'Matthew · asked for !recap earlier'], ['Product', 'done', 'same shape as !recap'],
    ['Builder', 'running', 'coding: !streak', { tail: tail(['Read', BOT]) }])],
  [31500, swarm('evt_streak', '!streak', ['Context', 'done', 'Matthew · asked for !recap earlier'], ['Product', 'done', 'same shape as !recap'],
    ['Builder', 'running', 'coding: !streak', { tail: tail(['Read', BOT], ['Edit', BOT]) }])],
  [32400, swarm('evt_streak', '!streak', ['Context', 'done', 'Matthew · asked for !recap earlier'], ['Product', 'done', 'same shape as !recap'],
    ['Builder', 'running', 'opening PR', { tail: tail(['Read', BOT], ['Edit', BOT], ['Bash', 'python -m compileall discord-bot']) }])],
  [33400, pr(7, '[WORLD] Add !streak command', 31, 'pass', [pr(6, '[WORLD] Add !recap command', 24, 'pass').prs[0]])],
  [33600, swarm('evt_streak', '!streak', ['Context', 'done', 'Matthew · asked for !recap earlier'], ['Product', 'done', 'same shape as !recap'],
    ['Builder', 'done', 'PR #7 · compile ✓'])],
  [44000, { kind: 'track', track_id: 3, bbox: [0.4, 0.16, 0.2, 0.64], label: 'MATTHEW' }],
  ...BRAIN_OPS,
];

// The default loop (DEV_SCRIPT) already plays !recap -> !streak as qm_swarm, which swarmviz renders too.
// ?mock=1&mockseq=swarm swaps in this longer standalone take (more tool calls, step list on the card).
if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('mockseq') === 'swarm') {
  DEMO_SCRIPT.length = 0;
  DEMO_SCRIPT.push(...SWARM_SCRIPT);
}

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

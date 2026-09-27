import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWorkPanels, compareRuns, createLiveWork } from '../src/live-work.js';

const report = (id, scopeId, recalled = [], finishedAt = 1) => ({ eventId: id, fireKey: id, scopeId,
  type: 'feature_request.detected', finishedAt, recalled, captured: 1,
  total: { toolCalls: 10, turns: 2, wallMs: 2000 } });

test('run comparison stays within event type and owner, preserving slower actual results', () => {
  const baseline = report('first', 'personal:a');
  const other = report('other', 'personal:b', [], 2);
  const recalled = report('second', 'personal:a', [{ title: 'Build feature' }], 3);
  recalled.total = { toolCalls: 20, turns: 5, wallMs: 6000 };
  assert.equal(compareRuns([baseline, other, recalled]).before, baseline);
  const card = buildWorkPanels({ runs: [baseline, other, recalled] }).find(p => p.id === 'live:comparison');
  assert.equal(card.items[0].value, '10 → 20');
  assert.equal(card.items[2].value, '2s → 6s');
  assert.equal(compareRuns([other, recalled]), null);
});

test('cards preserve zero metrics, filter unsafe links and keep missing metrics unknown', () => {
  const cards = buildWorkPanels({ jobs: [{ id: 'j', state: 'running', stats: { tool_calls: 0 },
    pr_url: 'javascript:alert(1)', preview_url: 'https://example.com' }], runs: [{ eventId: 'r', total: {} }] });
  assert.equal(cards[0].items[1].value, '0');
  assert.equal(cards[0].actions[0].id, 'preview');
  assert.equal(cards.find(p => p.id === 'live:run:r').items[0].value, '—');
});

test('live worker cards preserve all worker states in four-row pages and tolerate numeric recall steps', () => {
  const workers = Array.from({ length: 5 }, (_, i) => ({ name: `Worker ${i}`, state: i ? 'done' : 'running', note: 'Building the feature' }));
  const cards = buildWorkPanels({ activities: [{ event_id: 'e', hook: 'feature_request.detected', workers }],
    jobs: [{ id: 'j', recalled: { title: 'A procedure', steps: 3 } }] });
  const live = cards.filter(p => p.id.startsWith('live:activity:'));
  assert.equal(live.length, 2);
  assert.equal(live[0].body, 'Building the feature');
  assert.equal(live[0].items[0].value, 'running');
  assert.equal(live[1].items[0].label, 'Worker 4');
  assert.deepEqual(cards.find(p => p.id === 'live:procedure:j').items, []);
});

function fixture(overrides = {}) {
  const api = { jobs: async () => [], qmRuns: async () => ({ runs: [] }),
    qmWatches: async () => ({ watches: [] }), qmEntities: async () => ({ entities: [] }), ...overrides };
  const hud = { panels: new Map([['agent-owned', {}]]), touch() {} };
  return { api, hud, work: createLiveWork({ api, hud }) };
}

test('refresh never mutates backend or agent-owned panels; partial failure retains last state', async () => {
  let failed = false;
  const { hud, work } = fixture({ jobs: async () => {
    if (failed) throw Error('offline');
    return [{ id: 'build', feature: 'Feature', state: 'running' }];
  } });
  await work.refresh();
  assert.equal(hud.workPanels[0].title, 'Feature');
  work.dismiss('live:job:build');
  await work.refresh();
  assert.equal(hud.workPanels.length, 0);
  failed = true;
  await work.refresh();
  assert.match(hud.workPanels[0].meta, /Updates unavailable/);
  assert.equal(hud.panels.size, 1);
});

test('watch removal only happens on explicit action and cannot duplicate pending mutation', async () => {
  let calls = 0, release;
  const { work, hud } = fixture({ qmWatches: async () => ({ watches: [{ id: 'w', active: true, action: 'Watch' }] }),
    qmDeleteWatch: async id => { assert.equal(id, 'w'); calls++; await new Promise(r => { release = r; }); } });
  await work.refresh();
  assert.equal(calls, 0);
  const removing = work.action('live:watch:w', 'remove');
  await work.action('live:watch:w', 'remove');
  assert.equal(calls, 1);
  release();
  await removing;
  assert.equal(hud.workPanels.length, 0);
});

test('stopped or nonlive bridge cannot publish in-flight data or mutate a watch', async () => {
  let release;
  const { work, hud } = fixture({ jobs: async () => new Promise(r => { release = r; }) });
  const refresh = work.refresh();
  work.stop();
  release([{ id: 'late' }]);
  await refresh;
  assert.deepEqual(hud.workPanels, []);
  const offline = createLiveWork({ api: {}, hud, isLive: () => false });
  await offline.refresh();
  assert.equal(await offline.action('live:watch:w', 'remove'), null);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { HudState } from '../src/hud.js';
import { act, setDevSender, safeLink, drawGithubPanel, drawSessionPanel } from '../src/devpanels.js';

const canvas = () => ({ width: 0, height: 0, getContext: () => new Proxy({ measureText: (s) => ({width: String(s).length * 5}) }, {get: (o, k) => o[k] || (() => {})}) });

test('PR selection is local and subsequent reviews target the selected PR across snapshots', () => {
  globalThis.document = {createElement: canvas};
  const hud = new HudState();
  const prs = [1,2,3,4,5].map((number) => ({number,title:`PR ${number}`,checks:'pass',files:[],url:`https://github.com/org/repo/pull/${number}`}));
  hud.apply({kind:'dev_github',prs});
  let sent;
  setDevSender((msg) => { sent = msg; return true; });
  const other = drawGithubPanel(hud.devGithub).hits.find((h) => h.action === 'select_pr' && h.pr === 5);
  act(hud, other);
  assert.equal(sent, undefined);
  hud.apply({kind:'dev_github',prs});
  const approve = drawGithubPanel(hud.devGithub).hits.find((h) => h.action === 'approve');
  act(hud, approve);
  assert.equal(sent.pr,5);
  hud.apply({kind:'dev_github',prs:prs.slice(0,2)});
  assert.equal(hud.devGithub._selectedPr,1);
});

test('session and worker links are usable and reject non-web schemes', () => {
  globalThis.document = {createElement: canvas};
  const panel = drawSessionPanel({state:'done',session_url:'https://example.com/session'});
  assert.equal(panel.hits[0].action,'open_link');
  const hud = new HudState();
  hud.xrActive = true;
  act(hud,panel.hits[0]);
  assert.equal(hud.pendingPreview,'https://example.com/session');
  assert.equal(safeLink('javascript:alert(1)'),null);
  hud.apply({kind:'agent_activity',workers:[{name:'Builder',state:'done',url:'https://example.com/preview',pr_url:'https://github.com/org/repo/pull/1'}]});
  assert.equal(hud.devWorkerLinks.length,2);
  hud.apply({kind:'clear'});
  assert.deepEqual(hud.devWorkerLinks,[]);
});

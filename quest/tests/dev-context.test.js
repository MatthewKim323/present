import test from 'node:test';
import assert from 'node:assert/strict';
import { HudState } from '../src/hud.js';

test('Matthew cockpit snapshots and live GBrain deltas coexist with tool panels', () => {
  const hud = new HudState();
  hud.apply({kind:'person_card',anchor_track_id:3,person_id:'matthew',name:'Matthew',relationship:'Early Opal user',recent_deltas:['prefers async demos']});
  hud.apply({kind:'context_delta',person_id:'matthew',delta_kind:'preference',text:'+ wants payout explanation'});
  assert.equal(hud.cards.get('3')._deltas[0].text,'+ wants payout explanation');
  hud.apply({kind:'dev_github',repo:'qtzx06/opal',prs:[{number:7}]});
  hud.apply({kind:'dev_session',job_id:'j1',state:'running',step:'building',tail:[]});
  hud.apply({kind:'panel',op:'show',id:'p1',type:'note',title:'Keep the context'});
  assert.equal(hud.devGithub.prs[0].number,7);
  assert.equal(hud.devSession.step,'building');
  assert.equal(hud.livePanels().length,1);
  hud.apply({kind:'dev_github',repo:'qtzx06/opal',prs:[]});
  assert.equal(hud.devGithub.prs.length,0,'full snapshots replace prior PRs');
  hud.apply({kind:'person_card',anchor_track_id:3,person_id:'matthew',name:'Matthew'});
  assert.equal(hud.cards.get('3')._deltas.length,1,'card refresh retains live deltas');
  hud.apply({kind:'clear'});
  assert.equal(hud.devGithub,null);
  assert.equal(hud.devSession,null);
  assert.equal(hud.deltas.size,0);
  assert.equal(hud.panels.size,0);
});

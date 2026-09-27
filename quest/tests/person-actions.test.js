import test from 'node:test';
import assert from 'node:assert/strict';
import { personRequest } from '../src/person-actions.js';

test('person actions use persistent identity, never tracking ID', () => {
  const card = {person_id:'matthew', anchor_track_id:19, name:'Matthew'};
  assert.deepEqual(personRequest(card,'adopt'), {entity_kind:'person',entity_id:'matthew',label:'Matthew'});
  const watch = personRequest(card,'watch');
  assert.deepEqual(watch.match,{person_id:'matthew',type:'feature_request.detected'});
  assert.equal(watch.once,false);
  assert.match(watch.action,/do not implement/);
});
test('unknown identity and actions cannot launch work', () => {
  assert.throws(()=>personRequest({anchor_track_id:19},'adopt'),/persistent/);
  assert.throws(()=>personRequest({person_id:'matthew'},'unexpected'),/unknown/);
});

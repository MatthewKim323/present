import test from 'node:test';
import assert from 'node:assert/strict';
import { DEMO_SCRIPT, PREVIEW_PHASE_TIMES } from '../src/mock.js';

test('preview chapters reveal the encounter, memory, and active swarm', () => {
  const kindsAt = time => new Set(DEMO_SCRIPT.filter(([at]) => at <= time).map(([, message]) => message.kind));
  assert.ok(kindsAt(PREVIEW_PHASE_TIMES[0]).has('person_card'));
  assert.ok(kindsAt(PREVIEW_PHASE_TIMES[1]).has('memory_event'));
  assert.ok(kindsAt(PREVIEW_PHASE_TIMES[2]).has('qm_swarm'));
});

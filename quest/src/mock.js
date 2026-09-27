// Scripted demo sequence (?mock=1). Exercises all three HUD states with no server.
export const DEMO_SCRIPT = [
  [0, { kind: 'track', track_id: 3, bbox: [0.38, 0.18, 0.22, 0.62], label: 'UNKNOWN PERSON 03' }],
  [800, { kind: 'person_card', anchor_track_id: 3, person_id: 'alex', name: 'ALEX', subtitle: 'founder · Acme',
    last: 'Syla onboarding', owes_you: 'feedback', you_owe: 'demo' }],
  [4000, { kind: 'memory_event', text: 'CUSTOMER FEEDBACK REMEMBERED', detail: 'Canvas onboarding' }],
  [5200, { kind: 'memory_event', text: 'COMMITMENT REMEMBERED', detail: 'send onboarding demo to Alex' }],
  [6000, { kind: 'agent_activity', anchor_track_id: 3, hook: 'customer_feedback.detected', workers: [
    { name: 'Context', state: 'running', note: 'searching GBrain' },
    { name: 'Product', state: 'running', note: 'finding similar Canvas complaints' },
    { name: 'Follow-up', state: 'running', note: 'locating onboarding demo' } ] }],
  [8500, { kind: 'agent_activity', anchor_track_id: 3, hook: 'customer_feedback.detected', workers: [
    { name: 'Context', state: 'done', note: 'Alex · Acme · Syla pilot' },
    { name: 'Product', state: 'running', note: '4 similar, likely OAuth step' },
    { name: 'Follow-up', state: 'running', note: 'drafting reply' } ] }],
  [11000, { kind: 'agent_activity', anchor_track_id: 3, hook: 'customer_feedback.detected', workers: [
    { name: 'Context', state: 'done', note: 'Alex · Acme · Syla pilot' },
    { name: 'Product', state: 'done', note: 'issue drafted: OAuth onboarding' },
    { name: 'Follow-up', state: 'done', note: 'reply ready, awaiting approval' } ] }],
];

export function runMock(apply, { loop = true } = {}) {
  const timers = [];
  const total = DEMO_SCRIPT[DEMO_SCRIPT.length - 1][0] + 6000;
  const once = () => {
    apply({ kind: 'clear' });
    for (const [t, msg] of DEMO_SCRIPT) timers.push(setTimeout(() => apply(msg), t));
    if (loop) timers.push(setTimeout(once, total));
  };
  once();
  return () => timers.forEach(clearTimeout);
}

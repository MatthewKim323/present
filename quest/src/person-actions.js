import { drawPersonCardPlus } from './devpanels.js';

export function personRequest(card, action) {
  const id = card?.person_id;
  if (typeof id !== 'string' || !/^[A-Za-z0-9_.:-]{1,80}$/.test(id)) throw new Error('this person needs a persistent identity first');
  if (action === 'adopt') return { entity_kind: 'person', entity_id: id, label: card.name };
  if (action === 'watch') return { match: { person_id: id, type: 'feature_request.detected' }, action: `Notify the wearer in WORLD when ${card.name || id} requests a feature. Summarize the request; do not implement it.`, once: false };
  throw new Error('unknown person action');
}

export function drawActionPerson(card, time) {
  const base = drawPersonCardPlus(card, time);
  if (!card.person_id) return base;
  const canvas = document.createElement('canvas');
  canvas.width = base.width; canvas.height = base.height + 96;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(base, 0, 0); ctx.scale(2, 2);
  const y = base.height / 2 + 7;
  canvas.localActions = ['adopt', 'watch'].map((action, i) => ({action, track: card.anchor_track_id, x: 10 + i * 145, y, w: 135, h: 32}));
  for (const [i, rect] of canvas.localActions.entries()) {
    ctx.beginPath(); ctx.roundRect(rect.x, rect.y, rect.w, rect.h, 9);
    ctx.fillStyle = 'rgba(20,20,20,.32)'; ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.stroke();
    ctx.fillStyle = '#ffffff'; ctx.font = '12px sans-serif'; ctx.textAlign = 'center';
    const state = card._actionState?.[rect.action];
    const label = state === 'pending' ? 'working…' : state === 'done' ? (i ? 'watch active' : 'agent ready') : (i ? 'watch feature requests' : 'give agent');
    ctx.fillText(label, rect.x + rect.w / 2, y + 20);
  }
  canvas.localActions = canvas.localActions.filter(rect => !card._actionState?.[rect.action]);
  return canvas;
}

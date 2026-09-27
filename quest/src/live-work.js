// Read-only synchronization for AR work cards. These are deliberately separate
// from hud.panels, which belongs to agent-authored world_panel commands.
const list = (value, key) => Array.isArray(value) ? value : Array.isArray(value?.[key]) ? value[key] : [];
const finite = value => typeof value === 'number' && Number.isFinite(value);
const duration = ms => finite(ms) ? `${Math.round(ms / 1000)}s` : '—';
const metric = value => finite(value) ? String(value) : '—';
const safeUrl = value => {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url.href : null; }
  catch { return null; }
};

// QM only exposes completed reports. Never infer running state from this route,
// or compare across owners/types. The live worker stream stays on agent_activity.
export function compareRuns(reports = []) {
  const ordered = reports.filter(r => finite(r.finishedAt) && r.total).sort((a, b) => a.finishedAt - b.finishedAt);
  for (let i = ordered.length - 1; i >= 0; i--) {
    const after = ordered[i];
    if (!after.recalled?.length) continue;
    const before = ordered.slice(0, i).reverse().find(r => r.type === after.type &&
      r.scopeId === after.scopeId && r.eventId !== after.eventId && !r.recalled?.length);
    if (before) return { before, after };
  }
  return null;
}

export function buildWorkPanels({ jobs = [], runs = [], watches = [], entities = [], activities = [], errors = {} } = {}) {
  const panels = [];
  const make = (id, view, data, source) => ({ id: `live:${id}`, view, type: 'status', ...data,
    ...(errors[source] ? { meta: 'Updates unavailable · showing last state' } : {}) });
  for (const [index, activity] of activities.entries()) {
    const workers = Array.isArray(activity.workers) ? activity.workers : [];
    // Pages keep every worker reachable while maintaining the four-row canvas.
    for (let offset = 0; offset < workers.length; offset += 4) {
      const page = workers.slice(offset, offset + 4);
      panels.push(make(`activity:${activity.event_id || activity.anchor_track_id || index}:${offset}`, 'agents', {
        eyebrow: 'Live swarm', title: (activity.hook || 'Agent activity').replaceAll('.', ' '),
        body: page.find(worker => worker.state === 'running' && worker.note)?.note || '',
        items: page.map(worker => ({ label: worker.name || 'Worker', value: worker.state || 'Unknown' })),
        meta: workers.some(worker => worker.state === 'running') ? 'Working' : 'Latest worker state',
      }, 'activity'));
    }
  }
  const sortedJobs = [...jobs].sort((a, b) => (b.created || 0) - (a.created || 0));
  const activeJobs = sortedJobs.filter(j => !['done', 'failed'].includes(j.state));
  const recentJobs = [...activeJobs, ...sortedJobs.filter(j => ['done', 'failed'].includes(j.state))];
  for (const job of recentJobs) {
    const links = [ ['pr', 'Open PR', job.pr_url], ['preview', 'Preview', job.preview_url],
      ['session', 'Session', job.session_url] ].filter(([, , url]) => safeUrl(url));
    panels.push(make(`job:${job.id}`, 'agents', {
      eyebrow: 'Builder', title: job.feature || job.spec?.feature || 'Build',
      body: job.error || job.note || job.repo, meta: job.state || 'queued',
      items: [
        { label: 'Status', value: job.state || 'queued' },
        ...(job.pr_number ? [{ label: 'Pull request', value: `#${job.pr_number}` }] : []),
        ...(finite(job.stats?.tool_calls) ? [{ label: 'Tool calls', value: metric(job.stats.tool_calls) }] : []),
        ...(finite(job.stats?.duration_ms) ? [{ label: 'Elapsed', value: duration(job.stats.duration_ms) }] : []),
      ],
      actions: links.slice(0, 1).map(([id, label, url]) => ({ id, label, url: safeUrl(url) })).concat({ id: 'details', label: 'Details', jobId: job.id }),
    }, 'jobs'));
    if (job.recalled || job.procedure) {
      panels.push(make(`procedure:${job.id}`, 'memories', {
        eyebrow: job.recalled ? 'Recalled procedure' : 'Procedure learning',
        title: job.recalled?.title || job.feature || 'Build procedure',
        body: job.procedure?.stored ? 'Procedure saved for the next similar request' : job.procedure?.reason || 'Reusing an earlier workflow',
        items: (Array.isArray(job.recalled?.steps) ? job.recalled.steps : []).slice(0, 4).map(step => ({ label: typeof step === 'string' ? step : step?.action || step?.command || 'Step' })),
        meta: job.procedure?.stored ? 'Learned' : job.recalled ? 'Recalled' : 'Not saved',
        actions: [{ id: 'details', label: 'Details', jobId: job.id }],
      }, 'jobs'));
    }
  }
  const ordered = [...runs].sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0));
  for (const run of ordered) {
    panels.push(make(`run:${run.fireKey || run.eventId}`, 'agents', {
      eyebrow: 'QM swarm · completed', title: (run.type || 'World event').replaceAll('.', ' '),
      body: run.total?.toolErrors ? `${run.total.toolErrors} tool errors recorded` : `${run.sessions?.length || 0} agent sessions`,
      items: [ { label: 'Tool calls', value: metric(run.total?.toolCalls) },
        { label: 'Turns', value: metric(run.total?.turns) },
        { label: 'Elapsed', value: duration(run.total?.wallMs) },
        { label: 'Procedures saved', value: metric(run.captured) } ],
      meta: run.captureError ? 'Procedure capture failed' : run.recalled?.length ? 'Used recalled procedure' : 'Completed',
      actions: [{ id: 'details', label: 'Run details', runId: run.eventId }],
    }, 'runs'));
  }
  const comparison = compareRuns(runs);
  if (comparison) {
    const { before, after } = comparison;
    panels.push(make('comparison', 'memories', {
      eyebrow: 'Measured runs · baseline → recall', title: 'Recalled procedure',
      body: after.recalled[0]?.title || after.type,
      items: [
        { label: 'Tool calls', value: `${metric(before.total.toolCalls)} → ${metric(after.total.toolCalls)}` },
        { label: 'Turns', value: `${metric(before.total.turns)} → ${metric(after.total.turns)}` },
        { label: 'Elapsed', value: `${duration(before.total.wallMs)} → ${duration(after.total.wallMs)}` },
      ], meta: 'Same event type and owner · observed totals',
      actions: [{ id: 'details', label: 'Run details', runId: after.eventId }],
    }, 'runs'));
  } else if (ordered[0]) {
    const run = ordered[0];
    panels.push(make('learning', 'memories', {
      eyebrow: 'Memorable', title: run.recalled?.[0]?.title || 'Learning from experience',
      body: run.captureError ? 'Procedure capture failed' : run.recalled?.length ? 'Recalled procedure' : `${run.captured || 0} procedures saved`,
      meta: 'Waiting for a comparable recalled run',
    }, 'runs'));
  }
  for (const watch of [...watches].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))) {
    const match = watch.match || {};
    panels.push(make(`watch:${watch.id}`, 'agents', {
      eyebrow: 'Standing watch', title: watch.instruction || watch.action || 'Watch',
      body: [match.person_id, match.project, match.type, ...(match.text_contains || [])].filter(Boolean).join(' · '),
      items: [{ label: 'Status', value: watch.active ? 'Watching' : 'Inactive' },
        { label: 'Triggered', value: metric(watch.fired) }, { label: 'Mode', value: watch.once ? 'Once' : 'Ongoing' }],
      actions: [{ id: 'remove', label: 'Remove watch', watchId: watch.id }],
    }, 'watches'));
  }
  for (const entity of [...entities].reverse()) {
    panels.push(make(`entity:${entity.key || entity.entityId}`, 'agents', {
      eyebrow: 'Personal agent', title: entity.label || entity.entityId,
      body: 'Agent assigned', items: [{ label: 'Events received', value: metric(entity.events) }],
      actions: [{ id: 'details', label: 'Agent details', entityId: entity.entityId }],
    }, 'entities'));
  }
  return panels;
}

export function createLiveWork({ api, hud, isLive = () => true, onError = () => {}, onChange = () => {}, intervalMs = 4000 }) {
  let running = false, timer, controller, inflight, generation = 0;
  let watchRevision = 0;
  let snapshot = { jobs: [], runs: [], watches: [], entities: [], errors: {} };
  const hidden = new Map(), pending = new Set();
  function models() {
    return buildWorkPanels({ ...snapshot, activities: [...(hud.activity?.values() || [])] });
  }
  function publish() {
    const panels = models();
    hud.workPanels = panels.filter(panel => hidden.get(panel.id) !== JSON.stringify(panel)).map(panel =>
      pending.has(panel.id) ? { ...panel, actions: [], meta: 'Removing watch…' } : panel);
    hud.workSummary = snapshot;
    hud.touch?.();
    onChange(snapshot);
  }
  async function refresh() {
    if (!isLive()) return;
    if (inflight) return inflight;
    const current = generation;
    const currentWatchRevision = watchRevision;
    controller = new AbortController();
    const signal = controller.signal;
    inflight = (async () => {
      const routes = [['jobs', 'jobs'], ['runs', 'qmRuns'], ['watches', 'qmWatches'], ['entities', 'qmEntities']];
      const results = await Promise.allSettled(routes.map(([, method]) => api[method]({ signal })));
      if (current !== generation || signal.aborted || !isLive()) return;
      const errors = {};
      results.forEach((result, index) => {
        const [key] = routes[index];
        if (key === 'watches' && currentWatchRevision !== watchRevision) return;
        if (result.status === 'fulfilled') snapshot = { ...snapshot, [key]: list(result.value, key) };
        else { errors[key] = result.reason?.message || 'Unavailable'; if (!snapshot.errors[key]) onError(result.reason); }
      });
      snapshot = { ...snapshot, errors, updatedAt: Date.now() };
      publish();
    })().finally(() => { if (current === generation) inflight = null; });
    return inflight;
  }
  async function tick() {
    const current = generation;
    await refresh();
    if (running && current === generation) timer = setTimeout(tick, intervalMs);
  }
  return {
    start() { if (!running) { running = true; void tick(); } },
    stop() { running = false; generation++; clearTimeout(timer); controller?.abort(); inflight = null;
      hud.workPanels = []; hud.touch?.(); onChange(snapshot); },
    refresh,
    dismiss(id) { const panel = models().find(p => p.id === id);
      if (panel) { hidden.set(id, JSON.stringify(panel)); publish(); } },
    async action(panelId, actionId) {
      const panel = models().find(p => p.id === panelId);
      const action = panel?.actions?.find(a => a.id === actionId);
      if (!action || !isLive() || pending.has(panelId)) return null;
      if (actionId !== 'remove') return action;
      pending.add(panelId); publish();
      try {
        await api.qmDeleteWatch(action.watchId);
        watchRevision++;
        snapshot = { ...snapshot, watches: snapshot.watches.filter(w => w.id !== action.watchId) };
        return { removed: action.watchId };
      } catch (error) { onError(error); throw error; }
      finally { pending.delete(panelId); publish(); }
    },
  };
}

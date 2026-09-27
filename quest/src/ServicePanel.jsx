import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createWorldApi } from './world-api.js';
import { PANEL_CATALOG } from './panel-catalog.js';
import './ServicePanel.css';
import { QmPanel } from './QmPanel.jsx';

const json = value => JSON.stringify(value, null, 2);
const display = value => value == null ? '—' : typeof value === 'object' ? JSON.stringify(value) : String(value);
const diagnostics = {
  utterance: { path: '/debug/utterance', body: { text: '', speaker: 'wearer' } },
  endConversation: { path: '/debug/end-conversation', body: {} },
  event: { path: '/events', body: { type: 'world.task_requested', source: 'manual', payload: { request: '' } } },
  hud: { path: '/hud', body: { kind: 'memory_event', text: '', detail: '' } },
  procedure: { path: '/procedures', body: { kind: 'learned', draft: { title: '', steps: [] }, origin: {} } },
};

function Raw({ value, label = 'response JSON' }) {
  if (value == null) return null;
  return <details className="service-raw"><summary>{label}</summary><pre>{json(value)}</pre></details>;
}

function Fields({ values }) {
  return <dl className="service-fields">{Object.entries(values || {}).map(([key, value]) => <React.Fragment key={key}><dt>{key.replaceAll('_', ' ')}</dt><dd>{display(value)}</dd></React.Fragment>)}</dl>;
}

function Link({ href, children }) {
  try {
    if (!['http:', 'https:'].includes(new URL(href).protocol)) return null;
  } catch { return null; }
  return <a href={href} target="_blank" rel="noopener noreferrer">{children} ↗</a>;
}

function Resource({ title, resource, refresh, children }) {
  return <section className="service-block" aria-label={title}>
    <div className="service-block-heading"><h3>{title}</h3><button onClick={refresh} disabled={resource?.loading}>refresh</button></div>
    {resource?.loading && <p role="status">loading…</p>}
    {resource?.error && <p role="alert" className="service-error">{resource.error}</p>}
    {resource?.data != null && children(resource.data)}
  </section>;
}

export function ServicePanel({ onClose, onConnect, target, api: providedApi }) {
  const api = useMemo(() => providedApi || createWorldApi(), [providedApi]);
  const [tab, setTab] = useState('overview');
  const [resources, setResources] = useState({});
  const versions = useRef({});
  const mounted = useRef(false);
  const mutationLock = useRef(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [jobId, setJobId] = useState(null);
  const [feature, setFeature] = useState('');
  const [request, setRequest] = useState('');
  const [repo, setRepo] = useState('');
  const [command, setCommand] = useState(() => json(PANEL_CATALOG.find(p => p.type === 'note').sample));
  const [after, setAfter] = useState('0');
  const [diagnostic, setDiagnostic] = useState('utterance');
  const [diagnosticBody, setDiagnosticBody] = useState(json(diagnostics.utterance.body));

  const read = useCallback(async (key, method = key, args = [], options = {}) => {
    const version = (versions.current[key] || 0) + 1;
    versions.current[key] = version;
    setResources(old => ({ ...old, [key]: { ...old[key], loading: true, error: null } }));
    try {
      const data = await api[method](...args, options);
      if (mounted.current && versions.current[key] === version) setResources(old => ({ ...old, [key]: { data, loading: false, error: null } }));
      return data;
    } catch (error) {
      if (mounted.current && versions.current[key] === version && !options.signal?.aborted) setResources(old => ({ ...old, [key]: { ...old[key], loading: false, error: error.message || 'request failed' } }));
      return null;
    }
  }, [api]);

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    for (const key of ['health', 'people', 'jobs', 'tools', 'panels']) void read(key, key, [], { signal: controller.signal });
    void read('panelActions', 'panelActions', [0], { signal: controller.signal });
    return () => { mounted.current = false; controller.abort(); };
  }, [read]);

  useEffect(() => {
    if (!target) return;
    setTab(target.jobId ? 'builds' : 'qm');
    if (target.jobId) {
      setJobId(target.jobId);
      void read('job', 'job', [target.jobId]);
    }
  }, [target, read]);

  async function mutate(label, task) {
    if (mutationLock.current) return;
    mutationLock.current = true;
    setBusy(true);
    setResult(null);
    try {
      const value = await task();
      if (mounted.current) setResult({ label, value });
    } catch (error) {
      if (mounted.current) setResult({ label, error: error.message || 'request failed' });
    } finally {
      mutationLock.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  function parse(text) {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('enter a JSON object');
    return value;
  }

  function selectJob(id) {
    setJobId(id);
    setResources(old => ({ ...old, job: {} }));
    void read('job', 'job', [id]);
  }

  return <aside className="service-panel" aria-label="WORLD backend services">
    <header className="service-heading"><div><span>WORLD / SERVICES</span><h2>connected to reality.</h2></div><button onClick={onClose} aria-label="Close services">close</button></header>
    <nav className="service-tabs" aria-label="Service views">{['overview', 'builds', 'qm', 'tools', 'diagnostics'].map(name => <button key={name} aria-pressed={name === tab} onClick={() => { setTab(name); setResult(null); }}>{name}</button>)}</nav>
    <div className="service-content">
      {tab === 'qm' && <QmPanel target={target} api={api} onConnect={onConnect} />}
      {tab === 'overview' && <>
        <p className="service-hint">live backend snapshots. refresh to fetch current state.</p>
        {onConnect && <button onClick={onConnect}>connect live HUD</button>}
        <Resource title="health" resource={resources.health} refresh={() => read('health')}>{data => <><Fields values={{ service: data.ok ? 'available' : 'unavailable', vision: data.vision ? 'ready' : 'unavailable', speech: data.asr, reasoning: data.llm ? 'ready' : 'unavailable', GBrain: data.gbrain?.backend ?? data.gbrain?.mode ?? data.gbrain, QM: data.qm_url ? 'configured' : 'not configured', 'HUD clients': data.hud_clients, 'frames processed': data.frames_done, 'events emitted': data.events_out }} /><Raw value={data} label="latency and full health" /></>}</Resource>
        <Resource title="people" resource={resources.people} refresh={() => read('people')}>{data => <>{Object.keys(data).length ? <ul className="service-list">{Object.entries(data).map(([id, person]) => <li key={id}><div><strong>{person.name}</strong><small>{id}</small></div><span>{person.samples} samples</span></li>)}</ul> : <p>no enrolled people.</p>}<p className="service-hint">enroll a visible person from the camera view.</p></>}</Resource>
      </>}
      {tab === 'builds' && <>
        <Resource title="builds" resource={resources.jobs} refresh={() => read('jobs')}>{data => <>{data.length ? <ul className="service-list">{data.map(job => <li key={job.id}><button className="service-job" aria-pressed={job.id === jobId} onClick={() => selectJob(job.id)}><strong>{job.feature || job.spec?.feature || job.id}</strong><small>{job.repo} · {job.state}</small></button></li>)}</ul> : <p>no builds yet.</p>}</>}</Resource>
        {jobId && <Resource title="build detail" resource={resources.job} refresh={() => read('job', 'job', [jobId])}>{job => <><h4>{job.feature}</h4><p>{job.note}</p>{job.error && <p className="service-error">{job.error}</p>}<Fields values={{ state: job.state, mode: job.mode, repository: job.repo, branch: job.branch }} /><div className="service-links"><Link href={job.pr_url}>pull request</Link><Link href={job.preview_url}>preview</Link><Link href={job.session_url}>session</Link></div>{job.recalled && <><h4>recalled procedure</h4><p>{job.recalled.title || 'procedure recalled'}</p><Raw value={job.recalled} label="procedure steps" /></>}{job.procedure && <><h4>learned procedure</h4><Raw value={job.procedure} label="learning result" /></>}<h4>run metrics</h4><Fields values={job.stats} /><h4>milestones · seconds from start</h4><Fields values={job.timings} /><Raw value={job} label="full build" /></>}</Resource>}
        <details className="service-block"><summary>start a build</summary><p className="service-hint">starts the configured coding agent and may create a real PR.</p><form onSubmit={event => { event.preventDefault(); void mutate('build dispatched', async () => { onConnect?.(); const value = await api.dispatch({ spec: { feature: feature.trim(), request: request.trim() || feature.trim() }, ...(repo.trim() ? { repo: repo.trim() } : {}) }); void read('jobs'); if (value.job_id) selectJob(value.job_id); return value; }); }}><label>feature<input required maxLength={80} value={feature} onChange={event => setFeature(event.target.value)} /></label><label>request<textarea value={request} onChange={event => setRequest(event.target.value)} placeholder="what should change?" /></label><label>repository · optional<input value={repo} onChange={event => setRepo(event.target.value)} placeholder="owner/repo · server default if blank" /></label><button disabled={busy || !feature.trim()} type="submit">{busy ? 'sending…' : 'start build'}</button></form></details>
      </>}
      {tab === 'tools' && <>
        <Resource title="agent tools" resource={resources.tools} refresh={() => read('tools')}>{data => <>{(data.tools || []).map((tool, index) => <div key={tool.function?.name || index}><h4>{tool.function?.name || tool.name}</h4><p>{tool.function?.description || tool.description}</p><Raw value={tool} label="tool schema" /></div>)}</>}</Resource>
        <section className="service-block"><h3>send a panel command</h3><p className="service-hint">agents can discover the schema at GET /tools and call POST /tools/world-panel. external agents must be configured with these routes.</p><p className="service-hint">changes live panels for connected viewers. selections are recorded as intent; they do not execute external work.</p><label>example · fictional content<select defaultValue="note" onChange={event => setCommand(json(PANEL_CATALOG.find(p => p.type === event.target.value).sample))}>{PANEL_CATALOG.map(panel => <option key={panel.type} value={panel.type}>{panel.label}</option>)}</select></label><form onSubmit={event => { event.preventDefault(); void mutate('panel command accepted', async () => { const body = parse(command); onConnect?.(); const value = await api.panel(body); void read('panels'); return value; }); }}><label>world_panel JSON<textarea className="service-code" value={command} onChange={event => setCommand(event.target.value)} spellCheck={false} rows={10} /></label><button disabled={busy} type="submit">{busy ? 'sending…' : 'send panel command'}</button></form></section>
        <Resource title="active panels" resource={resources.panels} refresh={() => read('panels')}>{data => <>{data.panels?.length ? <ul className="service-list">{data.panels.map(panel => <li key={panel.id}><div><strong>{panel.title || panel.id}</strong><small>{panel.type} · {panel.id}</small><button onClick={() => setCommand(json({ op: 'update', id: panel.id, title: panel.title || panel.id }))}>edit command</button></div><button disabled={busy} onClick={() => void mutate('panel dismissed', async () => { onConnect?.(); const value = await api.panel({ op: 'dismiss', id: panel.id }); void read('panels'); return value; })}>dismiss</button></li>)}</ul> : <p>no active panels.</p>}</>}</Resource>
        <section className="service-block"><h3>panel action queue</h3><form className="service-inline" onSubmit={event => { event.preventDefault(); void read('panelActions', 'panelActions', [Number(after)]); }}><label>after sequence<input type="number" min="0" step="1" required value={after} onChange={event => setAfter(event.target.value)} /></label><button disabled={resources.panelActions?.loading} type="submit">fetch actions</button></form>{resources.panelActions?.error && <p role="alert">{resources.panelActions.error}</p>}{resources.panelActions?.loading && <p role="status">loading…</p>}{resources.panelActions?.data && <><Fields values={{ cursor: resources.panelActions.data.cursor, 'oldest available': resources.panelActions.data.oldest_sequence }} />{resources.panelActions.data.actions?.length ? <ul className="service-list">{resources.panelActions.data.actions.map(action => <li key={action.sequence}><div><strong>{action.panel_id} / {action.action_id}</strong><small>sequence {action.sequence}</small><Raw value={action} label="action payload" /></div></li>)}</ul> : <p>no actions after this sequence.</p>}<button onClick={() => { const cursor = resources.panelActions.data.cursor; setAfter(String(cursor)); void read('panelActions', 'panelActions', [cursor]); }}>fetch after cursor</button></>}</section>
      </>}
      {tab === 'diagnostics' && <details className="service-block"><summary>event and procedure inputs</summary><p className="service-hint">these send real input to the backend. events and conversation input can wake agents; procedures can write memory.</p><label>endpoint<select value={diagnostic} onChange={event => { setDiagnostic(event.target.value); setDiagnosticBody(json(diagnostics[event.target.value].body)); setResult(null); }}>{Object.entries(diagnostics).map(([key, endpoint]) => <option key={key} value={key}>POST {endpoint.path}</option>)}</select></label><form onSubmit={event => { event.preventDefault(); void mutate(`POST ${diagnostics[diagnostic].path}`, () => { const body = diagnostic === 'endConversation' ? null : parse(diagnosticBody); onConnect?.(); return diagnostic === 'endConversation' ? api.endConversation() : api[diagnostic](body); }); }}>{diagnostic !== 'endConversation' && <label>request JSON<textarea className="service-code" rows={10} spellCheck={false} value={diagnosticBody} onChange={event => setDiagnosticBody(event.target.value)} /></label>}<button disabled={busy} type="submit">{busy ? 'sending…' : diagnostic === 'endConversation' ? 'end conversation and process' : 'send to backend'}</button></form></details>}
      {result && <section className="service-result" role={result.error ? 'alert' : 'status'}><strong>{result.error ? 'request failed' : result.label}</strong>{result.error ? <p>{result.error}</p> : <Raw value={result.value} />}</section>}
    </div>
  </aside>;
}

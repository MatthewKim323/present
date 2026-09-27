import React, { useEffect, useState, useRef } from 'react';
import { getQmAccessToken, setQmAccessToken } from './world-api.js';

const metric = value => Number.isFinite(value) ? value : '—';
const seconds = value => Number.isFinite(value) ? `${(value / 1000).toFixed(1)}s` : '—';
const date = value => value ? new Date(value).toLocaleString() : '—';

function Run({run, runs}) {
  // Compare only an earlier unrecalled run of this event type in the same scope.
  // This is an observed comparison, not proof that the tasks were identical.
  const baseline = run.recalled?.length ? runs.filter(other => other.type === run.type && other.scopeId === run.scopeId && other.finishedAt < run.startedAt && !other.recalled?.length).sort((a,b)=>b.finishedAt-a.finishedAt)[0] : null;
  return <article className="service-run">
    <strong>{run.type || 'agent run'}</strong>
    <small>{run.finishedAt ? `completed · ${date(run.finishedAt)}` : 'in progress'}</small>
    <dl className="service-fields"><dt>tool calls</dt><dd>{metric(run.total?.toolCalls)}</dd><dt>turns</dt><dd>{metric(run.total?.turns)}</dd><dt>elapsed</dt><dd>{seconds(run.total?.wallMs)}</dd><dt>tool errors</dt><dd>{metric(run.total?.toolErrors)}</dd><dt>procedures learned</dt><dd>{metric(run.captured)}</dd></dl>
    {run.recalled?.length > 0 && <><h4>recalled procedure</h4>{run.recalled.map((procedure,i)=><p key={i}>{procedure.title}<small>{procedure.steps} steps</small></p>)}</>}
    {run.captureError && <p className="service-error">procedure capture failed: {run.captureError}</p>}
    {baseline && <><h4>earlier run → this run</h4><p className="service-hint">same event type · baseline {date(baseline.finishedAt)}. task scope may differ.</p><dl className="service-fields"><dt>tool calls</dt><dd>{metric(baseline.total?.toolCalls)} → {metric(run.total?.toolCalls)}</dd><dt>turns</dt><dd>{metric(baseline.total?.turns)} → {metric(run.total?.turns)}</dd><dt>elapsed</dt><dd>{seconds(baseline.total?.wallMs)} → {seconds(run.total?.wallMs)}</dd></dl></>}
    {run.sessions?.length > 0 && <details><summary>{run.sessions.length} worker sessions</summary>{run.sessions.map(session=><div key={session.sessionId}><h4>{session.name}</h4><p>{metric(session.toolCalls)} tool calls · {metric(session.turns)} turns · {seconds(session.wallMs)} · {metric(session.toolErrors)} errors</p></div>)}</details>}
    <details className="service-raw"><summary>full run report</summary><pre>{JSON.stringify(run,null,2)}</pre></details>
  </article>;
}

export function QmPanel({api,onConnect,target}) {
  const [tokenInput, setTokenInput] = useState('');
  const [enabled, setEnabled] = useState(Boolean(getQmAccessToken()));
  const [data,setData]=useState({});
  const [errors,setErrors]=useState({});
  const [busy,setBusy]=useState(false);
  const [notice,setNotice]=useState('');
  const [action,setAction]=useState('');
  const [eventType,setEventType]=useState('feature_request.detected');
  const [personId,setPersonId]=useState('');
  const [project,setProject]=useState('');
  const [phrases,setPhrases]=useState('');
  const [once,setOnce]=useState(true);
  const [entityId,setEntityId]=useState('');
  const [entityLabel,setEntityLabel]=useState('');
  const [kind,setKind]=useState('person');
  const alive=useRef(true);
  const lock=useRef(false);
  const versions=useRef({});
  const controller=useRef(null);
  const focusedRecord=useRef(null);
  const lastFocusedTarget=useRef(null);
  const selectedRun = run => Boolean(target?.runId && [run.eventId, run.fireKey, run.id].includes(target.runId));
  const selectedEntity = entity => Boolean(target?.entityId && entity.entityId === target.entityId);
  useEffect(() => {
    if (!target || lastFocusedTarget.current === target || !focusedRecord.current) return;
    lastFocusedTarget.current = target;
    const record = focusedRecord.current;
    record.querySelectorAll('details').forEach(details => { details.open = true; });
    record.scrollIntoView({ block: 'nearest' });
    record.focus({ preventScroll: true });
  }, [target, data]);
  async function refresh(signal=controller.current?.signal) {
    await Promise.all(['qmRuns','qmWatches','qmEntities'].map(async key=>{
      const version=(versions.current[key]||0)+1;versions.current[key]=version;
      try { const value=await api[key]({signal});if(alive.current&&!signal?.aborted&&versions.current[key]===version){setData(old=>({...old,[key]:value}));setErrors(old=>({...old,[key]:null}));} }
      catch(e){if(alive.current&&!signal?.aborted&&versions.current[key]===version)setErrors(old=>({...old,[key]:e.message}));}
    }));
  }
  useEffect(()=>{
    if (!enabled) return;
    alive.current=true;const c=new AbortController();controller.current=c;let timer;
    async function tick(){if(!document.hidden)await refresh(c.signal);if(!c.signal.aborted)timer=setTimeout(tick,3000);}
    void tick();return()=>{alive.current=false;c.abort();clearTimeout(timer);};
  },[api, enabled]);
  async function mutate(task,message){
    if(lock.current)return;lock.current=true;setBusy(true);setNotice('');
    try{onConnect?.();await task();if(alive.current){setNotice(message);await refresh();}}
    catch(e){if(alive.current)setNotice(`request failed: ${e.message}`);}
    finally{lock.current=false;if(alive.current)setBusy(false);}
  }
  const list=(key,field,render)=><>{errors[key]&&<p role="alert">{errors[key]}{data[key]?' · showing last received state':''}</p>}{data[key]?data[key][field]?.length?<ul className="service-list">{data[key][field].map(render)}</ul>:<p>none yet.</p>:!errors[key]&&<p>loading…</p>}</>;
  if (!enabled) return <section className="service-block"><h3>QM access</h3><p className="service-hint">enter WORLD_QM_ACCESS_TOKEN to view runs and control watches or entity agents. the token stays in this page's memory.</p><form onSubmit={event => { event.preventDefault(); setQmAccessToken(tokenInput); setTokenInput(''); setEnabled(true); }}><label>access token<input type="password" autoComplete="off" required value={tokenInput} onChange={event => setTokenInput(event.target.value)} /></label><button type="submit" disabled={!tokenInput.trim()}>connect QM</button></form></section>;
  return <>
    <div className="service-block-heading"><h3>QM workforce</h3><button onClick={()=>void refresh()}>refresh</button></div>
    <button onClick={() => { setQmAccessToken(''); setEnabled(false); setData({}); }}>forget token</button>
    <p className="service-hint">updates every 3 seconds. watches and entity agents can start real agent work.</p>
    {notice&&<p role="status">{notice}</p>}
    {target?.runId && data.qmRuns && !data.qmRuns.runs?.some(selectedRun) && <p role="status">this run report is not available yet. waiting for the next update.</p>}
    {target?.entityId && data.qmEntities && !data.qmEntities.entities?.some(selectedEntity) && <p role="status">this entity agent is not in the current response.</p>}
    <section className="service-block"><h3>completed runs</h3><p className="service-hint">live worker progress appears in the HUD. measured reports arrive when a run finishes.</p>{list('qmRuns','runs',(run,i)=><li key={run.fireKey||run.eventId||i} ref={selectedRun(run)?focusedRecord:null} tabIndex={selectedRun(run)?-1:undefined} className={selectedRun(run)?"service-focused-record":undefined}><Run run={run} runs={data.qmRuns.runs}/></li>)}</section>
    <section className="service-block"><h3>standing watches</h3>{list('qmWatches','watches',(watch,i)=><li key={watch.id||i}><div><strong>{watch.action}</strong><small>{watch.active ? 'watching' : 'inactive'} · fired {watch.fired ?? 0} times · {watch.once ? 'once' : 'repeating'}</small><small>{Object.entries(watch.match||{}).map(([key,value])=>`${key}: ${Array.isArray(value)?value.join(', '):value}`).join(' · ')}</small>{watch.lastFiredAt&&<small>last fired {date(watch.lastFiredAt)}</small>}</div><button disabled={busy} onClick={()=>void mutate(()=>api.qmDeleteWatch(watch.id),'watch removed')}>remove</button></li>)}
      <details><summary>create a watch</summary><form onSubmit={e=>{e.preventDefault();const match={...(eventType.trim()?{type:eventType.trim()}:{}),...(personId.trim()?{person_id:personId.trim()}:{}),...(project.trim()?{project:project.trim()}:{}),...(phrases.trim()?{text_contains:phrases.split('\n').map(s=>s.trim()).filter(Boolean)}:{})};void mutate(()=>api.qmWatch({match,action:action.trim(),once}),'watch created');}}>
        <label>event type · optional<input value={eventType} onChange={e=>setEventType(e.target.value)}/></label>
        <label>person ID · optional<input value={personId} onChange={e=>setPersonId(e.target.value)} placeholder="matthew"/></label>
        <label>project · optional<input value={project} onChange={e=>setProject(e.target.value)} placeholder="opal"/></label>
        <label>required phrases · one per line, optional<textarea value={phrases} onChange={e=>setPhrases(e.target.value)}/></label>
        <label>agent instruction<textarea required value={action} onChange={e=>setAction(e.target.value)}/></label>
        <label className="service-checkbox"><input type="checkbox" checked={once} onChange={e=>setOnce(e.target.checked)}/>run once</label>
        <button disabled={busy||!action.trim()||!(eventType.trim()||personId.trim()||project.trim()||phrases.trim())}>create watch</button>
      </form></details>
    </section>
    <section className="service-block"><h3>entity agents</h3>{list('qmEntities','entities',(entity,i)=><li key={entity.key||i} ref={selectedEntity(entity)?focusedRecord:null} tabIndex={selectedEntity(entity)?-1:undefined} className={selectedEntity(entity)?"service-focused-record":undefined}><div><strong>{entity.label||entity.entityId}</strong><small>{entity.kind} · {entity.events ?? 0} events · adopted {date(entity.adoptedAt)}</small>{entity.lastEventAt&&<small>last event {date(entity.lastEventAt)}</small>}<details className="service-raw"><summary>agent identity</summary><p>{entity.threadRef}</p><small>{entity.entityId}</small></details></div></li>)}
      <details><summary>give an entity an agent</summary><form onSubmit={e=>{e.preventDefault();void mutate(()=>api.qmAdopt({entity_kind:kind,entity_id:entityId.trim(),...(entityLabel.trim()?{label:entityLabel.trim()}:{})}),'entity agent created');}}>
        <label>kind<select value={kind} onChange={e=>setKind(e.target.value)}><option value="person">person</option><option value="object">object</option></select></label>
        <label>entity ID<input required pattern="[A-Za-z0-9_.:-]{1,80}" value={entityId} onChange={e=>setEntityId(e.target.value)} placeholder="matthew"/></label>
        <label>label · optional<input value={entityLabel} onChange={e=>setEntityLabel(e.target.value)}/></label>
        <button disabled={busy||!entityId.trim()}>create entity agent</button>
      </form></details>
    </section>
  </>;
}

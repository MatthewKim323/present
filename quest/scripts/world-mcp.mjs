#!/usr/bin/env node
// Local stdio MCP adapter. Secrets stay in the world service, never in the HUD.
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { createWorldApi } from '../src/world-api.js';

const object = (properties = {}, required = []) => ({type:'object', properties, required, additionalProperties:false});
const string = {type:'string', minLength:1};
export function createToolServer(api, manifest) {
  const tools = [
    {name:'world_panel', description:manifest.tool.function.description, inputSchema:manifest.tool.function.parameters},
    {name:'world_panel_actions', description:'Read recorded user selections after a cursor. Selections are intent, not completed external work. Save the returned cursor; queue is bounded.', inputSchema:object({after:{type:'integer',minimum:0}})},
    {name:'world_panels', description:'List active spatial panels.', inputSchema:object()},
    {name:'world_status', description:'Read perception and integration health.', inputSchema:object()},
    {name:'world_people', description:'List enrolled people and sample counts.', inputSchema:object()},
    {name:'world_jobs', description:'List Builder jobs, including measured run statistics.', inputSchema:object()},
    {name:'world_job', description:'Read one Builder job and its PR, preview and learned procedure.', inputSchema:object({id:string},['id'])},
    {name:'world_dispatch', description:'Start a real Builder coding run. Only call when the user authorized that work. Creates a branch/PR; does not merge.', inputSchema:object({event_id:string,repo:string,person_id:string,anchor_track_id:{type:'integer'},spec:{type:'object',properties:{feature:string,request:string},required:['feature','request']}},['spec'])},
  ];
  const methods = {
    world_panel: args => api.panel(args),
    world_panel_actions: args => api.panelActions(args.after ?? 0),
    world_panels: () => api.panels(), world_status: () => api.health(),
    world_people: () => api.people(), world_jobs: () => api.jobs(),
    world_job: args => api.job(args.id), world_dispatch: args => api.dispatch(args),
  };
  return async function handle(request) {
    if (!request || request.jsonrpc !== '2.0' || typeof request.method !== 'string')
      return {jsonrpc:'2.0',id:request?.id??null,error:{code:-32600,message:'Invalid Request'}};
    if (request.id === undefined) return null;
    const reply = result => ({jsonrpc:'2.0',id:request.id,result});
    switch (request.method) {
      case 'initialize': return reply({protocolVersion:['2024-11-05','2025-03-26','2025-06-18'].includes(request.params?.protocolVersion)?request.params.protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'world',version:'1.0.0'}});
      case 'ping': return reply({});
      case 'tools/list': return reply({tools});
      case 'tools/call': {
        const name=request.params?.name, args=request.params?.arguments??{};
        if (!Object.hasOwn(methods,name)) return {jsonrpc:'2.0',id:request.id,error:{code:-32602,message:'Unknown tool'}};
        try {
          if (!args || typeof args!=='object' || Array.isArray(args)) throw Error('arguments must be an object');
          if (name==='world_job' && (typeof args.id!=='string'||!args.id.trim())) throw Error('id is required');
          if (name==='world_panel_actions' && args.after!==undefined && (!Number.isInteger(args.after)||args.after<0)) throw Error('after must be a nonnegative integer');
          const data=await methods[name](args);
          return reply({content:[{type:'text',text:JSON.stringify(data)}]});
        } catch(e) { return reply({isError:true,content:[{type:'text',text:e.message}]}); }
      }
      default: return {jsonrpc:'2.0',id:request.id,error:{code:-32601,message:'Method not found'}};
    }
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const base = new URL(process.env.WORLD_URL || 'http://127.0.0.1:8787');
  if (!['http:','https:'].includes(base.protocol)) throw Error('WORLD_URL must use HTTP(S)');
  const api = createWorldApi({fetchImpl:(path,options)=>fetch(new URL(path,base),options)});
  const manifest = JSON.parse(await readFile(new URL('../../contracts/PANELS.json',import.meta.url),'utf8'));
  const handle = createToolServer(api,manifest);
  const input = createInterface({input:process.stdin,crlfDelay:Infinity});
  for await (const line of input) {
    let result;
    try { result = await handle(JSON.parse(line)); }
    catch { result = {jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'}}; }
    if(result) process.stdout.write(JSON.stringify(result)+'\n');
  }
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createToolServer } from '../scripts/world-mcp.mjs';
const manifest=JSON.parse(await readFile(new URL('../../contracts/PANELS.json',import.meta.url)));
const req=(method,params)=>({jsonrpc:'2.0',id:1,method,params});
test('MCP discovers canonical panel tool and dispatches selections with cursor',async()=>{
  let command,cursor;
  const handle=createToolServer({panel:async c=>(command=c,{ok:true}),panelActions:async c=>(cursor=c,{actions:[],cursor:4})},manifest);
  const list=await handle(req('tools/list'));
  assert.deepEqual(list.result.tools[0].inputSchema,manifest.tool.function.parameters);
  await handle(req('tools/call',{name:'world_panel',arguments:{op:'show',id:'one',type:'note',title:'Hello'}}));
  assert.equal(command.id,'one');
  await handle(req('tools/call',{name:'world_panel_actions',arguments:{after:3}}));
  assert.equal(cursor,3);
  assert.equal(await handle({jsonrpc:'2.0',method:'notifications/initialized'}),null);
});
test('MCP rejects unknown tools and surfaces backend errors without retrying',async()=>{
  let calls=0;
  const handle=createToolServer({dispatch:async()=>{calls++;throw Error('builder unavailable');}},manifest);
  assert.equal((await handle(req('tools/call',{name:'toString'}))).error.code,-32602);
  const r=await handle(req('tools/call',{name:'world_dispatch',arguments:{spec:{feature:'x',request:'y'}}}));
  assert.equal(r.result.isError,true);assert.match(r.result.content[0].text,/builder unavailable/);assert.equal(calls,1);
});

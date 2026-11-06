// Exercise real view callbacks against the JSON boundary; native rendering is checked separately.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const buttons=new Map();
function element(){
  const target={};let id;
  const proxy=new Proxy(target,{get(_t,k){return (...args)=>{
    if(k==='id')id=args[0];
    if(k==='on_click')buttons.set(id,args[0]);
    if(k==='when' && args[0])args[1](proxy);
    return proxy;
  };}});return proxy;
}
const state=({value=''})=>({value:()=>value,set_value:v=>{value=v},on:()=>{}});
const calls=[],defs=[],runs=[];let ambiguous=false,counter=0;
async function request(q){
  calls.push(structuredClone(q));
  if(q.op==='status')return {providers:{codex:true,claude:true}};
  if(q.op==='list')return defs.map(({prompt,precheck,...d})=>({...d,recent:[]}));
  if(q.op==='get')return structuredClone(defs.find(d=>d.id===q.id));
  if(q.op==='create'){const d={...q.definition,id:'a1',revision:1,nextRunAt:1};defs.push(d);return d;}
  if(q.op==='update'){defs[0]={...q.definition,id:q.id,revision:q.revision+1};return defs[0];}
  if(q.op==='runNow'){if(ambiguous)throw Error('ambiguous timeout');return {id:'r1',phase:'queued'};}
  if(q.op==='runs')return runs.map(({snapshot,output,...r})=>r);
  if(q.op==='getRun')return structuredClone(runs.find(r=>r.id===q.id));
  if(q.op==='preview')return [1,2,3];
  if(q.op==='setEnabled'){defs[0].enabled=q.enabled;return defs[0];}
  if(q.op==='archive')return defs.pop();
  if(q.op==='openTerminal')return {address:'t99'};
  if(q.op==='closeTerminal')return {};
  throw Error('Unhandled '+q.op);
}
const runCalls=[];
const names={View:class{},div:element,v_flex:element,h_flex:element,
  InputState:{new:state},Input:{new:element},TextareaState:{new:state},Textarea:{new:element},
  theme:()=>({}),props:()=>({}),home:()=>'/tmp',focused:()=>({cwd:'/tmp'}),
  openOverlay:()=>{},closeOverlay:()=>{},run:(...x)=>runCalls.push(x),pickFolder:async()=>'/tmp/picked',shared:()=>null,
  spaces:()=>[],nextCommand:()=>new Promise(()=>{}),request,requestId:()=>`request-${++counter}`};
const model=fs.readFileSync(path.join(root,'mods/automations/model.js'),'utf8').replaceAll('export ','');
const exports=new Function(model+'\nreturn {phases,active,time,kinds,days,scheduleText};')();Object.assign(names,exports);
const source=fs.readFileSync(path.join(root,'mods/automations/main.js'),'utf8').replace(/^import .*;\n/gm,'').replace('export default class','return class');
const UI=new Function(...Object.keys(names),source)(...Object.values(names));
const cx={spawn:fn=>{fn(cx).catch(e=>{throw e})},notify:()=>{},timer:{every:()=>{}}};
const flush=async()=>{for(let i=0;i<4;i++)await new Promise(r=>setImmediate(r));};
const ui=new UI();ui.init({},cx);await flush();
const render=()=>{buttons.clear();ui.render();};
const click=async id=>{render();assert.ok(buttons.has(id),`Missing ${id}`);buttons.get(id)({},cx);await flush();render();};
await click('new');ui.inputs.name.set_value('Test');ui.prompt.set_value('Inspect');
await click('preview');assert.equal(ui.preview.length,3);
await click('save');assert.equal(defs.length,1);assert.equal(defs[0].enabled,false);
await click('edit-a1');assert.equal(ui.prompt.value(),'Inspect'); // summary was hydrated
ui.prompt.set_value('Edited');await click('save');assert.equal(defs[0].prompt,'Edited');
await click('toggle-a1');assert.equal(defs[0].enabled,true);
ambiguous=true;await click('run-a1');await click('confirm-action');assert.match(ui.error,/timeout/);
const first=calls.findLast(q=>q.op==='runNow').requestId;
ambiguous=false;await click('run-a1');await click('confirm-action');assert.equal(calls.findLast(q=>q.op==='runNow').requestId,first);
runs.push({id:'r1',automationId:'a1',phase:'succeeded',address:'t99',trigger:'manual',createdAt:1,scheduledFor:1,snapshot:defs[0],output:'DONE'});
await click('history-a1');await click('details-r1');assert.equal(ui.detail.output,'DONE');
await click('terminal-r1');assert.deepEqual(runCalls.at(-1),['terminal.peek',{terminal:'t99'}]);
await click('close-terminal-r1');await click('confirm-action');assert.equal(calls.findLast(q=>q.op==='closeTerminal').id,'r1');
await click('back-history');await click('archive-a1');await click('confirm-action');assert.equal(defs.length,0);
await click('all-history');assert.equal(ui.runs.length,1);
console.log('AUTOMATIONS_UI_ACTIONS_PASSED');

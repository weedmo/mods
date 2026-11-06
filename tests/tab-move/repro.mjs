import fs from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'../..');
const source=fs.readFileSync(root+'/mods/tabs-weed/main.js','utf8').replace(/^import .*;\n/gm,'').replace('export default class','return class');
let ps=[{pane:'p1',tab:'a',terminal:'t1'},{pane:'p2',tab:'b',terminal:'t2'}],queue=[],calls=[],warnings=[];
let failKeep=true;let now=1000;
const sharedState={};
const moves=fs.readFileSync(root+'/mods/tabs-weed/move.js','utf8').replaceAll('export ','');
const {MOVE_KEY,advanceMove}=new Function(moves+';return {MOVE_KEY,advanceMove};')();
const env={MOVE_KEY,advanceMove,Date:{now:()=>now},View:class{},div:()=>{},svg:()=>{},image:()=>{},h_flex:()=>{},
 spaces:()=>[{id:'s',active:true,tabs:[{id:'a'},{id:'b'}]}],panes:()=>ps,
 focused:()=>({space:'s',tab:'a',pane:'p1',terminal:'t1'}),
 run:(name,args)=>{calls.push([name,args]);if(name==='terminal.park')ps=ps.filter(p=>p.terminal!==args.terminal);
 if(name==='terminal.keep'){if(failKeep){failKeep=false;return null;}ps.push({pane:'restored',tab:'a',terminal:args.terminal});}return null;},
 notify:n=>warnings.push(n),setShared:(k,v)=>sharedState[k]=v,shared:k=>sharedState[k],
 openOverlay:()=>{},theme:()=>({}),window:()=>({active:true}),layout:()=>({}),settings:()=>({}),nextCommand:()=>new Promise(()=>{})};
const Tabs=new Function(...Object.keys(env),source)(...Object.values(env));
const tabs=new Tabs();tabs.lastDrop=null;
const cx={timer:{after:(_ms,fn)=>queue.push(fn)},notify:()=>{},spawn:()=>{}};
tabs.handleDrop({id:'move',tab:'b',place:'right'},cx);
for(let i=0;i<100;i++){now+=250;while(queue.length)queue.shift()(cx);tabs.progressMove(cx);}
assert.ok(ps.some(p=>p.terminal==='t2'),'BUG: t2 disappeared after park when keep did not attach it');
assert.equal(sharedState[MOVE_KEY],null,'move intent must clear only after a pane exists');
assert.equal(calls.filter(c=>c[0]==='terminal.park').length,1,'never detach twice');
assert.ok(calls.filter(c=>c[0]==='terminal.keep').length>=2,'retry the unacknowledged attachment');
// A removed explicit destination cancels before detaching the source.
ps=[{pane:'p1',tab:'a',terminal:'t1'},{pane:'p2',tab:'b',terminal:'t2'}];calls=[];
tabs.handleDrop({id:'missing',tab:'b',target:'removed',place:'right'},cx);
assert.equal(calls.length,0);
// Splitting a multi-pane tab must not secretly select just one terminal.
ps.push({pane:'p3',tab:'b',terminal:'t3'});calls=[];
tabs.handleDrop({id:'multi',tab:'b',place:'right'},cx);
assert.equal(calls.length,0);
// Recovery after a reload is driven by the persisted intent, not a captured Context.
let move={id:'reload',terminal:'t2',phase:'attaching',target:'removed',sourceSpace:'s',place:'right',started:0,next:0};
const result=advanceMove(move,{panes:[ps[0]],spaces:[{id:'s'}]},1000);
assert.deepEqual(result.commands.at(-1),['terminal.keep',{terminal:'t2',place:'tab'}]);
// Left/up swap is applied only after the new pane is visible in the captured target tab.
move={...move,target:'p1',targetTab:'a',swap:'left'};
const done=advanceMove(move,{panes:[ps[0],{pane:'new',tab:'a',terminal:'t2'}],spaces:[]},2000);
assert.ok(done.done);assert.deepEqual(done.commands.at(-1),['pane.swap',{direction:'left'}]);
console.log('TAB_MOVE_RECOVERY_PASSED');

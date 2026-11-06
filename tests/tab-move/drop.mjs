import fs from 'node:fs';
import assert from 'node:assert/strict';
const source=fs.readFileSync(new URL('../../mods/tab-drop/main.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,'').replace('export default class','return class');
const nodes=new Map();
function element(){const n={};const p=new Proxy(n,{get:(o,k)=> k==='handlers'?o:(...args)=>{if(k==='id')nodes.set(args[0],p);if(k.startsWith('on_'))o[k]=args.at(-1);return p;}});return p;}
let target='original',visible=true,drops=[],closed=0;
const env={View:class{},div:element,v_flex:element,h_flex:element,props:()=>({tab:'source',target}),panes:()=>visible?[{pane:'original',terminal:'t1'}]:[],focused:()=>({pane:'different'}),theme:()=>({}),closeOverlay:()=>closed++,setShared:(_k,v)=>drops.push(v),window:()=>({active:true})};
const Drop=new Function(...Object.keys(env),source)(...Object.values(env));
const cx={focus_handle:()=>({focus(){}}),stop_propagation(){},notify(){},timer:{after:(_ms,fn)=>fn()}};
function render(){nodes.clear();const d=new Drop();d.init({},cx);d.render(cx);return d;}
render();nodes.get('drop-left').handlers.on_mouse_up({},cx);
assert.equal(drops.length,1);assert.equal(drops[0].target,'original');assert.equal(drops[0].place,'left');
render();nodes.get('root').handlers.on_mouse_up({},cx);assert.equal(drops.length,1);
render();nodes.get('root').handlers.on_key_down({keystroke:'escape'},cx);assert.equal(closed,3);
const d=render();visible=false;d.finish('right');assert.equal(drops.length,1);
console.log('TAB_DROP_TARGET_AND_CANCEL_PASSED');

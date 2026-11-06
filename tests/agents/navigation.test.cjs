const fs = require('node:fs'), vm = require('node:vm'), assert = require('node:assert/strict');
const file = process.argv[2] || '/home/weed/.config/herdr-app/mods/agents-weed/main.js';
const source = fs.readFileSync(file, 'utf8');
const callbacks = [...source.matchAll(/\.on_click\(\(\) => (focusAgent\(a\)|run\("pane.focus", \{ pane: a.pane \}\))\)/g)];
assert.equal(callbacks.length, 2, 'Both expanded and collapsed rows must navigate');
const helper = source.match(/function focusAgent\(a\) \{[\s\S]*?\n\}/)?.[0] || '';
for (const address of ['t7','remote/t7']) {
 for (const callback of callbacks) {
  const calls = [];
  const a = {address, space:'target-space', tab:'target-tab', pane:'target-pane'};
  vm.runInNewContext(helper + '\n' + callback[1], {a, run:(name,args)=>calls.push([name,args])});
  assert(calls.some(([name,args]) => name === 'tab.select' && args.id === a.tab), 'Agent click must explicitly select its tab');
  assert(calls.some(([name,args]) => name === 'pane.focus' && args.pane === a.pane), 'Agent pane must receive keyboard focus');
 }
}
console.log('PASS: expanded/collapsed agent rows select target tab and pane locally and remotely');

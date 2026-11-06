const {readFileSync} = require('node:fs');
const {runInNewContext} = require('node:vm');
const assert = require('node:assert/strict');
const source = readFileSync(process.argv[2] || '/home/weed/.config/herdr-app/mods/space-folders/main.js', 'utf8');
const fn = source.slice(source.indexOf('async function newSpaceIn('), source.indexOf('// A rule of'));
(async () => {
  for (const machine of [null, 'remote-host']) {
    const calls = [];
    const context = {setShared(){}, spaces:()=>[], run:(...args)=>calls.push(args), Date};
    runInNewContext(fn + ';this.create = newSpaceIn;', context);
    await context.create(machine, null);
    assert.equal(calls[0][0], 'space.new');
    assert.equal(calls[0][1].machine, machine ?? '', 'Must target the clicked machine even when another machine is focused');
  }
  console.log('PASS: local and remote + buttons explicitly target their machine');
})();

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {simulate,snapshot,compilePlan,DEFAULT_CONFIG,DEFAULT_LAYOUT,STATIONS,MATERIALS,makeRecipe,parseRecipe,makeFrameSTL,validateConfig} from './engine.js';
const stockFor=n=>Object.fromEntries(MATERIALS.map(m=>[m.id,m.perCell*n]));
test('same input reproduces trace and state exactly',()=>{
  assert.deepEqual(simulate(),simulate());
  assert.notDeepEqual(simulate({seed:43}).events,simulate().events);
});
test('flow conservation at all sampled times; stock never negative',()=>{
  const r=simulate();
  for(let t=0;t<=r.durationSec;t+=13){const s=snapshot(r,t);
    const pending=s.jobs.filter(j=>j.status==='pending').length;
    assert.equal(pending+s.counts.blocked+s.counts.wip+s.counts.completed+s.counts.rejected,r.config.targetCells);
    assert.equal(s.counts.shipped+s.counts.installed+s.counts.pendingInstall,s.counts.completed);
    assert.ok(Object.values(s.stock).every(q=>q>=0));
  }
  assert.equal(r.summary.completed,8);
});
test('each resource schedules only one operation at a time after commissioning',()=>{
  const r=simulate({targetCells:20,stock:stockFor(20)});
  for(const resource of r.resources){const segments=r.jobs.flatMap(j=>j.segments).filter(s=>s.resourceId===resource.id).sort((a,b)=>a.start-b.start);
    for(let i=0;i<segments.length;i++){assert.ok(segments[i].start>=resource.onlineAt);if(i)assert.ok(segments[i].start>=segments[i-1].end);}
  }
});
test('new capacity requires finished cell and installation delay; replay never reveals future resources',()=>{
  const r=simulate();assert.ok(r.resources.length>STATIONS.length);
  for(const resource of r.resources.filter(r=>r.sourceJobId!==null)){const job=r.jobs.find(j=>j.id===resource.sourceJobId);
    assert.equal(resource.onlineAt,job.completedAt+r.config.commissionSec);
    assert.ok(!snapshot(r,resource.onlineAt-0.001).resources.some(x=>x.id===resource.id));
    assert.ok(snapshot(r,resource.onlineAt).resources.some(x=>x.id===resource.id));
  }
});
test('expansion changes actual completion time; disabling it creates no new resources',()=>{
  const c={targetCells:20,stock:stockFor(20),durationSec:2400,testFailureRate:0};
  const base=simulate({...c,reinvestEvery:0}),expanded=simulate({...c,reinvestEvery:3});
  assert.equal(base.resources.length,9);assert.equal(base.summary.installed,0);
  assert.ok(Math.max(...expanded.jobs.map(j=>j.completedAt))<Math.max(...base.jobs.map(j=>j.completedAt)));
});
test('missing purchased joints blocks jobs; replenishment is external and consumes once',()=>{
  const c={stock:{...DEFAULT_CONFIG.stock,joints:12}};
  const no=simulate(c);assert.equal(no.summary.completed,2);assert.equal(no.summary.blocked,6);
  const yes=simulate({...c,autoReplenish:true});assert.equal(yes.summary.completed,8);assert.equal(yes.summary.blocked,0);
  assert.equal(yes.events.filter(e=>e.type==='material_receive').length,1);
  assert.equal(yes.events.filter(e=>e.type==='material_consumed').length,8);
  assert.equal(yes.summary.materialRemaining.joints,0);
});
test('test failure performs electronics rework and second test before completing',()=>{
  const r=simulate({forceTestFailure:true,testFailureRate:0});const j=r.jobs.find(j=>j.id===2);
  assert.equal(j.segments.filter(s=>s.stageId==='test').length,2);
  assert.equal(j.segments.filter(s=>s.stageId==='electronics').length,2);
  assert.ok(j.segments.some(s=>s.attempt===1));assert.ok(j.completedAt>j.segments.filter(s=>s.stageId==='test').at(-1).end);
  assert.equal(r.events.filter(e=>e.type==='test_fail').length,1);
});
test('short horizon retains unfinished inventory and does not count future completion',()=>{
  const r=simulate({durationSec:120});assert.equal(r.summary.completed,0);assert.equal(r.summary.wip,8);
  assert.ok(r.jobs.some(j=>j.segments.some(s=>s.end>120)));assert.equal(snapshot(r,120).counts.completed,0);
});
test('persistent inspection failure quarantines parts; failed cell never becomes production resource',()=>{
  const r=simulate({targetCells:20,stock:stockFor(20),durationSec:2400,testFailureRate:0.6});
  assert.ok(r.summary.rejected>0);
  for(const j of r.jobs.filter(j=>j.failedAt!==null)){assert.equal(j.completedAt,null);assert.equal(j.installedAt,null);assert.ok(!r.resources.some(x=>x.sourceJobId===j.id));}
  assert.equal(r.summary.completed+r.summary.rejected+r.summary.wip+r.summary.blocked,20);
});
test('manual added capacity is scheduled, removal reduces it, and recipe round trips it',()=>{
  const extraCells=[{id:'manual-1',stationId:'arm'}],layout=[...DEFAULT_LAYOUT,{id:'manual-1',stationId:'arm',x:3.3,z:-7.2}];
  const c={targetCells:20,stock:stockFor(20),durationSec:2400,testFailureRate:0,reinvestEvery:0};
  const one=simulate(c),two=simulate({...c,extraCells});
  assert.ok(two.jobs.some(j=>j.segments.some(s=>s.resourceId==='manual-1')));
  assert.ok(Math.max(...two.jobs.map(j=>j.completedAt))<Math.max(...one.jobs.map(j=>j.completedAt)));
  const recipe=parseRecipe(JSON.stringify(makeRecipe({...c,extraCells},layout)));assert.equal(recipe.config.extraCells.length,1);assert.equal(recipe.layout.length,10);
  assert.throws(()=>validateConfig({extraCells:[{id:'bad',stationId:'arm'}]}));
  assert.throws(()=>validateConfig({extraCells:[{id:'manual-1',stationId:'print'}]}));
});
test('recipe validates IDs, bounds, schema and preserves deterministic results',()=>{
  const recipe=makeRecipe(DEFAULT_CONFIG,DEFAULT_LAYOUT),restored=parseRecipe(JSON.stringify(recipe));
  assert.deepEqual(restored,recipe);assert.deepEqual(simulate(restored.config),simulate(recipe.config));
  assert.throws(()=>parseRecipe('{"schema":"old"}'));
  assert.throws(()=>makeRecipe({},DEFAULT_LAYOUT.map(p=>({...p,id:'arm'}))));
  assert.throws(()=>makeRecipe({},DEFAULT_LAYOUT.map(p=>({...p,x:100}))));
  assert.throws(()=>validateConfig({targetCells:NaN}));assert.throws(()=>validateConfig({stock:{joints:-1}}));
  assert.equal(compilePlan({stock:{joints:12}}).shortages[0].missing,36);
});
test('frame STL exports finite mm geometry with closed individual beams',()=>{
  const s=makeFrameSTL();assert.ok(s.startsWith('solid cellforge_frame_mm'));
  assert.equal((s.match(/facet normal/g)||[]).length,16*12);
  assert.equal((s.match(/vertex /g)||[]).length,16*12*3);
  assert.ok(!/NaN|Infinity/.test(s));assert.ok(s.includes('1800'));
  assert.throws(()=>makeFrameSTL({height:0}));
});

// Partial self-expansion from purchased components. No hardware or LLM control.
export const STATIONS = Object.freeze([
  {id:'receive',name:'입고 · 개봉',duration:16,x:-6.6,z:-4.2,kind:'robot'},
  {id:'frame',name:'프레임 · 플레이트',duration:34,x:-3.3,z:-4.2,kind:'robot'},
  {id:'print',name:'지그 프린트',duration:44,x:0,z:-4.2,kind:'printer'},
  {id:'arm',name:'6축 암 스택',duration:58,x:3.3,z:-4.2,kind:'robot'},
  {id:'integrate',name:'암 통합',duration:38,x:6.6,z:-4.2,kind:'hoist'},
  {id:'tool',name:'엔드 이펙터',duration:28,x:6.6,z:4.2,kind:'robot'},
  {id:'electronics',name:'전자부 · 배선',duration:46,x:3.3,z:4.2,kind:'robot'},
  {id:'test',name:'교정 · 검사',duration:32,x:0,z:4.2,kind:'robot'},
  {id:'pack',name:'출하 · 편입',duration:20,x:-3.3,z:4.2,kind:'robot'}
]);
export const MATERIALS = Object.freeze([
  {id:'frameKit',name:'프레임 키트',unit:'세트',perCell:1},
  {id:'joints',name:'구동 관절',unit:'개',perCell:6},
  {id:'controller',name:'컨트롤러',unit:'개',perCell:1},
  {id:'sensors',name:'센서',unit:'개',perCell:2},
  {id:'gripper',name:'그리퍼',unit:'개',perCell:1},
  {id:'filament',name:'지그 원료',unit:'g',perCell:180}
]);
export const DEFAULT_CONFIG = Object.freeze({targetCells:8,reinvestEvery:3,durationSec:1200,
  seed:42,testFailureRate:0.12,forceTestFailure:false,commissionSec:45,autoReplenish:false,extraCells:Object.freeze([]),
  stock:Object.freeze({frameKit:8,joints:48,controller:8,sensors:16,gripper:8,filament:1440})});
export const DEFAULT_LAYOUT = STATIONS.map(({id,x,z})=>({id,x,z}));
const stageById = Object.fromEntries(STATIONS.map(s=>[s.id,s]));
const cloneStages = ['frame','arm','integrate','tool','electronics','test'];
const clone = value => JSON.parse(JSON.stringify(value));
function number(value,name,min,max,integer=false) {
  if(!Number.isFinite(value)||value<min||value>max||(integer&&!Number.isInteger(value)))
    throw new Error(`${name}: ${min}~${max}${integer?' 정수':''}를 입력하세요.`);
  return value;
}
export function validateConfig(input={}) {
  const c={...DEFAULT_CONFIG,...input,stock:{...DEFAULT_CONFIG.stock,...input.stock}};
  number(c.targetCells,'목표 셀',2,30,true);number(c.reinvestEvery,'공장 편입 주기',0,10,true);
  number(c.durationSec,'실험 시간',120,7200,true);number(c.seed,'시드',0,4294967295,true);
  number(c.testFailureRate,'검사 실패 확률',0,0.6);number(c.commissionSec,'셀 설치 시간',1,600);
  if(typeof c.forceTestFailure!=='boolean'||typeof c.autoReplenish!=='boolean')throw new Error('옵션은 참/거짓이어야 합니다.');
  for(const m of MATERIALS)number(c.stock[m.id],m.name,0,1000000,true);
  if(!Array.isArray(c.extraCells)||c.extraCells.length>12)throw new Error('추가 설비는 최대 12개입니다.');
  const extraSeen=new Set();
  const extraCells=c.extraCells.map(r=>{if(!/^manual-[0-9]{1,3}$/.test(r.id)||extraSeen.has(r.id)||!cloneStages.includes(r.stationId))throw new Error('추가 셀 ID·공정이 잘못되었거나 중복입니다.');extraSeen.add(r.id);return {id:r.id,stationId:r.stationId};});
  // Discard unknown properties in imported recipes rather than carry them into UI.
  return {targetCells:c.targetCells,reinvestEvery:c.reinvestEvery,durationSec:c.durationSec,seed:c.seed,
    testFailureRate:c.testFailureRate,forceTestFailure:c.forceTestFailure,commissionSec:c.commissionSec,
    autoReplenish:c.autoReplenish,extraCells,stock:Object.fromEntries(MATERIALS.map(m=>[m.id,c.stock[m.id]]))};
}
export function compilePlan(input={}) {
  const config=validateConfig(input);
  const required=MATERIALS.map(m=>({...m,required:m.perCell*config.targetCells,available:config.stock[m.id],missing:Math.max(0,m.perCell*config.targetCells-config.stock[m.id])}));
  return {config,required,shortages:required.filter(m=>m.missing>0),
    tasks:STATIONS.map((s,i)=>({...s,dependsOn:i?[STATIONS[i-1].id]:[],action:i===2?'지그 원료로 2종 고정구 제작':'구매 부품 조립·검증'})),
    externalDependencies:MATERIALS.map(m=>m.id),plannedReinvestment:config.reinvestEvery?Math.floor(config.targetCells/config.reinvestEvery):0};
}
function random(seed,job,stage,attempt) {
  let x=(seed^Math.imul(job+1,73856093)^Math.imul(stage+1,19349663)^Math.imul(attempt+1,83492791))>>>0;
  x=Math.imul(x^(x>>>16),2246822507);x=Math.imul(x^(x>>>13),3266489909);
  return ((x^(x>>>16))>>>0)/4294967296;
}
export function simulate(input={}) {
  const config=validateConfig(input),plan=compilePlan(config),durationSec=config.durationSec;
  const stock={...config.stock},events=[],pending=[],queues=STATIONS.map(()=>[]),blocked=[];
  const resources=[...STATIONS.map(s=>({id:`${s.id}-01`,stationId:s.id,onlineAt:0,sourceJobId:null,busy:false})),...config.extraCells.map(r=>({...r,onlineAt:0,sourceJobId:null,busy:false}))];
  const jobs=Array.from({length:config.targetCells},(_,i)=>({id:i+1,arrival:i*16,startedAt:null,segments:[],
    completedAt:null,failedAt:null,installStart:null,installedAt:null,everBlocked:false}));
  let order=0,completed=0,time=0;
  const schedule=(at,type,data={})=>pending.push({time:at,type,order:order++,...data});
  const log=(type,message,data={})=>events.push({time,type,message,...data});
  const consume=job=>{
    if(MATERIALS.some(m=>stock[m.id]<m.perCell))return false;
    for(const m of MATERIALS)stock[m.id]-=m.perCell;
    job.startedAt=time;
    log('material_consumed',`셀 ${job.id}의 부품·원료를 예약했습니다.`,{jobId:job.id,quantities:Object.fromEntries(MATERIALS.map(m=>[m.id,m.perCell]))});
    queues[0].push({jobId:job.id,stage:0,attempt:0});return true;
  };
  const dispatch=()=>{
    for(let i=0;i<STATIONS.length;i++) {
      for(const r of resources.filter(r=>r.stationId===STATIONS[i].id&&!r.busy&&r.onlineAt<=time)) {
        const work=queues[i].shift();if(!work)break;
        const job=jobs[work.jobId-1],d=STATIONS[i].duration*(0.9+random(config.seed,job.id,i,work.attempt)*0.2);
        r.busy=true;const segment={stageId:r.stationId,resourceId:r.id,start:time,end:time+d,attempt:work.attempt};job.segments.push(segment);
        log('start',`셀 ${job.id} · ${STATIONS[i].name}${work.attempt?' 재작업':''} 시작`,{jobId:job.id,stationId:r.stationId,resourceId:r.id});
        schedule(segment.end,'finish',{...work,resourceId:r.id});
      }
    }
  };
  for(const job of jobs)schedule(job.arrival,'arrival',{jobId:job.id});
  if(config.autoReplenish&&plan.shortages.length)schedule(240,'replenish',{quantities:Object.fromEntries(plan.shortages.map(m=>[m.id,m.missing]))});
  while(pending.length) {
    pending.sort((a,b)=>a.time-b.time||a.order-b.order);
    const e=pending.shift();if(e.time>durationSec)break;time=e.time;
    const job=e.jobId?jobs[e.jobId-1]:null;
    if(e.type==='arrival') {
      log('arrival',`셀 ${job.id} 생산 요청`,{jobId:job.id});
      if(!consume(job)){blocked.push(job.id);job.everBlocked=true;log('material_blocked',`셀 ${job.id} · 외부 부품 부족으로 대기`,{jobId:job.id});}
    } else if(e.type==='replenish') {
      for(const [id,qty] of Object.entries(e.quantities))stock[id]+=qty;
      log('material_receive','외부 공급사가 부족 부품·원료를 보충했습니다.',{quantities:e.quantities});
      for(let i=0;i<blocked.length;){if(consume(jobs[blocked[i]-1]))blocked.splice(i,1);else i++;}
    } else if(e.type==='commission') {
      const counts=id=>resources.filter(r=>r.stationId===id).length;
      const stageId=cloneStages.reduce((best,id)=>stageById[id].duration/counts(id)>stageById[best].duration/counts(best)?id:best,cloneStages[0]);
      const r={id:`${stageId}-${String(counts(stageId)+1).padStart(2,'0')}`,stationId:stageId,onlineAt:time,sourceJobId:job.id,busy:false};
      resources.push(r);job.installedAt=time;
      log('commissioned',`셀 ${job.id}를 ${stageById[stageId].name}에 편입 · ${r.id}`,{jobId:job.id,stationId:stageId,resourceId:r.id});
    } else if(e.type==='finish') {
      const r=resources.find(r=>r.id===e.resourceId);r.busy=false;
      log('finish',`셀 ${job.id} · ${STATIONS[e.stage].name} 완료`,{jobId:job.id,stationId:r.stationId,resourceId:r.id});
      const testFailed=e.stage===7&&((config.forceTestFailure&&job.id===2&&e.attempt===0)||random(config.seed+17,job.id,7,e.attempt)<config.testFailureRate);
      if(testFailed&&e.attempt===0) {
        log('test_fail',`셀 ${job.id} 검사 실패 · 전자부 점검 후 재검`,{jobId:job.id,stationId:'test'});
        queues[6].push({jobId:job.id,stage:6,attempt:1});
      } else if(testFailed) {
        job.failedAt=time;log('reject',`셀 ${job.id} 재검 실패 · 격리 보류`,{jobId:job.id,stationId:'test'});
      } else if(e.stage===STATIONS.length-1) {
        job.completedAt=time;completed++;
        log('complete',`셀 ${job.id} 조립·검사 완료`,{jobId:job.id,stationId:'pack'});
        if(config.reinvestEvery&&completed%config.reinvestEvery===0) {
          job.installStart=time;log('commission_start',`셀 ${job.id} 공장 편입을 위한 설치 시작`,{jobId:job.id});
          schedule(time+config.commissionSec,'commission',{jobId:job.id});
        }
      } else queues[e.stage+1].push({jobId:job.id,stage:e.stage+1,attempt:e.attempt});
    }
    dispatch();
  }
  const result={config,durationSec,resources:resources.map(({busy,...r})=>r),jobs,events,summary:null};
  const end=snapshot(result,durationSec);
  result.summary={...end.counts,materialRemaining:end.stock,capacityByStage:Object.fromEntries(STATIONS.map(s=>[s.id,end.resources.filter(r=>r.stationId===s.id).length]))};
  return result;
}
export function snapshot(result,inputTime) {
  if(!Number.isFinite(inputTime))throw new Error('재생 시점은 유한한 숫자여야 합니다.');
  const time=Math.max(0,Math.min(result.durationSec,inputTime));
  const stock={...result.config.stock},events=result.events.filter(e=>e.time<=time);
  for(const e of events) {
    if(e.type==='material_consumed')for(const [id,q] of Object.entries(e.quantities))stock[id]-=q;
    if(e.type==='material_receive')for(const [id,q] of Object.entries(e.quantities))stock[id]+=q;
  }
  const jobs=result.jobs.map(j=>{
    const active=j.segments.find(s=>s.start<=time&&s.end>time);
    let status='pending',stageId=null,resourceId=null,progress=0;
    if(j.arrival<=time) {
      if(j.startedAt===null||j.startedAt>time)status='blocked';
      else if(j.failedAt!==null&&j.failedAt<=time)status='rejected';
      else if(j.installedAt!==null&&j.installedAt<=time)status='installed';
      else if(j.installStart!==null&&j.installStart<=time)status='commissioning';
      else if(j.completedAt!==null&&j.completedAt<=time)status='complete';
      else if(active){status='processing';stageId=active.stageId;resourceId=active.resourceId;progress=(time-active.start)/(active.end-active.start);}
      else {
        status='queued';const next=j.segments.find(s=>s.start>time);
        if(next)stageId=next.stageId;
        else {const last=j.segments.filter(s=>s.end<=time).at(-1);stageId=last?STATIONS[Math.min(8,STATIONS.findIndex(s=>s.id===last.stageId)+1)].id:'receive';
          // A failed test returns to electronics; future trace may end before that rework can start.
          const lastFail=events.filter(e=>e.type==='test_fail'&&e.jobId===j.id).at(-1);
          if(lastFail&&(!last||last.end<=lastFail.time))stageId='electronics';}
      }
    }
    return {id:j.id,status,stageId,resourceId,progress,completedAt:j.completedAt,installedAt:j.installedAt};
  });
  const resources=result.resources.filter(r=>r.onlineAt<=time).map(r=>{
    const j=result.jobs.find(j=>j.segments.some(s=>s.resourceId===r.id&&s.start<=time&&s.end>time));
    const seg=j?.segments.find(s=>s.resourceId===r.id&&s.start<=time&&s.end>time);
    return {...r,active:seg?{jobId:j.id,progress:(time-seg.start)/(seg.end-seg.start),stageId:seg.stageId,attempt:seg.attempt}:null,
      queue:jobs.filter(j=>j.status==='queued'&&j.stageId===r.stationId).length};
  });
  const completed=jobs.filter(j=>['complete','commissioning','installed'].includes(j.status)).length;
  const installed=jobs.filter(j=>j.status==='installed').length,pendingInstall=jobs.filter(j=>j.status==='commissioning').length;
  return {time,resources,jobs,stock,events,counts:{completed,installed,pendingInstall,shipped:completed-installed-pendingInstall,
    wip:jobs.filter(j=>['queued','processing'].includes(j.status)).length,rejected:jobs.filter(j=>j.status==='rejected').length,blocked:jobs.filter(j=>j.status==='blocked').length}};
}
export function validateLayout(input,extraCells=[]) {
  if(!Array.isArray(input)||input.length!==STATIONS.length+extraCells.length)throw new Error('기본 공정 9개와 추가 셀의 배치가 필요합니다.');
  const extras=Object.fromEntries(extraCells.map(r=>[r.id,r.stationId]));
  const seen=new Set();
  return input.map(p=>{if((!stageById[p.id]&&!extras[p.id])||seen.has(p.id))throw new Error('공정 ID가 없거나 중복되었습니다.');seen.add(p.id);
    return {...(extras[p.id]?{stationId:extras[p.id]}:{}),id:p.id,x:number(p.x,'X 위치',-15,15),z:number(p.z,'Z 위치',-15,15)};});
}
export function makeRecipe(config,layout=DEFAULT_LAYOUT) {
  const c=validateConfig(config);
  return {schema:'cellforge.recipe.v2',scope:'synthetic partial self-expansion from purchased components',config:c,layout:validateLayout(layout,c.extraCells)};
}
export function parseRecipe(text) {
  if(typeof text!=='string'||text.length>100000)throw new Error('100KB 이하 작업 패키지 JSON을 선택하세요.');
  const parsed=JSON.parse(text);if(parsed.schema!=='cellforge.recipe.v2')throw new Error('CELLFORGE v2 작업 패키지가 아닙니다.');
  return makeRecipe(parsed.config,parsed.layout);
}
export function makeFrameSTL({width=1.2,depth=1,height=1.8,beam=0.045}={}) {
  number(width,'폭',0.4,4);number(depth,'깊이',0.4,4);number(height,'높이',0.5,4);number(beam,'기둥 폭',0.01,0.15);
  if(beam*2>=Math.min(width,depth,height))throw new Error('기둥 폭이 프레임보다 큽니다.');
  const boxes=[];
  for(const x of [0,width-beam])for(const z of [0,depth-beam])boxes.push([x,0,z,beam,height,beam]);
  for(const y of [0,height*0.4,height-beam]) {
    for(const z of [0,depth-beam])boxes.push([beam,y,z,width-2*beam,beam,beam]);
    for(const x of [0,width-beam])boxes.push([x,y,beam,beam,beam,depth-2*beam]);
  }
  const triangles=[];
  for(const [x,y,z,w,h,d] of boxes) {
    const v=[[x,y,z],[x+w,y,z],[x+w,y+h,z],[x,y+h,z],[x,y,z+d],[x+w,y,z+d],[x+w,y+h,z+d],[x,y+h,z+d]].map(v=>v.map(n=>n*1000));
    for(const [a,b,c] of [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[3,7,6],[3,6,2],[0,4,7],[0,7,3],[1,2,6],[1,6,5]]) {
      const u=v[b].map((n,i)=>n-v[a][i]),w2=v[c].map((n,i)=>n-v[a][i]);
      const n=[u[1]*w2[2]-u[2]*w2[1],u[2]*w2[0]-u[0]*w2[2],u[0]*w2[1]-u[1]*w2[0]],len=Math.hypot(...n);
      triangles.push(`facet normal ${n.map(x=>x/len).join(' ')}\n outer loop\n${[a,b,c].map(i=>'  vertex '+v[i].join(' ')).join('\n')}\n endloop\nendfacet`);
    }
  }
  return 'solid cellforge_frame_mm\n'+triangles.join('\n')+'\nendsolid cellforge_frame_mm\n';
}

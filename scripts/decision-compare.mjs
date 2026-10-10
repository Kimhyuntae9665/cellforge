import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { simulate, snapshot, MATERIALS, STATIONS } from '../engine.js';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const common = {
  targetCells: 20,
  stock: Object.fromEntries(MATERIALS.map(m => [m.id, m.perCell * 20])),
  durationSec: 1200, seed: 42, reinvestEvery: 0, testFailureRate: 0.12,
  commissionSec: 45, forceTestFailure: false, autoReplenish: false, extraCells: []
};
const scenarios = [
  { id: 'baseline', label: '기준 유지', patch: {}, expected: [15, 15, 0, 0, 5, 0] },
  { id: 'extra_arm', label: '초기 암 설비 1개 추가', patch: { extraCells: [{ id: 'manual-1', stationId: 'arm' }] }, expected: [18, 18, 0, 0, 2, 0] },
  { id: 'lower_failure', label: '검사 실패 확률 12%→6%', patch: { testFailureRate: 0.06 }, expected: [15, 15, 0, 0, 5, 0] },
  { id: 'reinvest_3', label: '완료 3개마다 내부 편입', patch: { reinvestEvery: 3 }, expected: [19, 13, 6, 0, 1, 0] }
];
const metric = result => ({
  completed: result.summary.completed, shippable: result.summary.shipped,
  installed: result.summary.installed, pendingInstall: result.summary.pendingInstall,
  wip: result.summary.wip, quarantined: result.summary.rejected,
  blocked: result.summary.blocked,
  pendingRequests: snapshot(result, result.durationSec).jobs.filter(j => j.status === 'pending').length
});
let sampledSnapshots = 0;
function verifyConservation(result) {
  for (const time of [...Array.from({ length: Math.floor(result.durationSec / 13) + 1 }, (_, i) => i * 13), result.durationSec]) {
    const frame = snapshot(result, time), c = frame.counts;
    const pending = frame.jobs.filter(j => j.status === 'pending').length;
    assert.equal(pending + c.blocked + c.wip + c.rejected + c.completed, result.config.targetCells);
    assert.equal(c.shipped + c.installed + c.pendingInstall, c.completed);
    for (const material of MATERIALS) {
      const consumed = frame.events.filter(e => e.type === 'material_consumed').reduce((sum, e) => sum + e.quantities[material.id], 0);
      const received = frame.events.filter(e => e.type === 'material_receive').reduce((sum, e) => sum + (e.quantities[material.id] ?? 0), 0);
      assert.equal(frame.stock[material.id], result.config.stock[material.id] + received - consumed);
      assert.ok(frame.stock[material.id] >= 0);
    }
    sampledSnapshots++;
  }
}
const rows = scenarios.map(scenario => {
  const result = simulate({ ...common, ...scenario.patch });
  verifyConservation(result);
  assert.deepEqual(result, simulate(result.config));
  const metrics = metric(result);
  assert.deepEqual(['completed', 'shippable', 'installed', 'pendingInstall', 'wip', 'quarantined'].map(k => metrics[k]), scenario.expected);
  const initialResources = result.resources.filter(r => r.sourceJobId === null && r.onlineAt === 0);
  return {
    id: scenario.id, label: scenario.label,
    inputDifferences: Object.fromEntries(Object.keys(scenario.patch).map(key => [key, { baseline: common[key], scenario: result.config[key] }])),
    config: result.config, metrics,
    initialResources: { count: initialResources.length, byStage: Object.fromEntries(STATIONS.map(s => [s.id, initialResources.filter(r => r.stationId === s.id).length])), resources: initialResources },
    endCapacityByStage: result.summary.capacityByStage,
    materialRemaining: result.summary.materialRemaining,
    traceEventCounts: { firstInspectionFailures: result.events.filter(e => e.type === 'test_fail').length, quarantines: result.events.filter(e => e.type === 'reject').length }
  };
});
const paired = Array.from({ length: 30 }, (_, i) => {
  const seed = i + 1;
  const results = Object.fromEntries(scenarios.map(s => [s.id, metric(simulate({ ...common, ...s.patch, seed }))]));
  const deltas = Object.fromEntries(scenarios.slice(1).map(s => [s.id, {
    completed: results[s.id].completed - results.baseline.completed,
    shippable: results[s.id].shippable - results.baseline.shippable
  }]));
  return { seed, results, deltas };
});
const aggregate = Object.fromEntries(scenarios.slice(1).map(s => [s.id, Object.fromEntries(['completed', 'shippable'].map(key => {
  const values = paired.map(p => p.deltas[s.id][key]);
  return [key, { min: Math.min(...values), mean: values.reduce((sum, v) => sum + v, 0) / values.length, max: Math.max(...values) }];
}))]));
const fortyMinuteAllocation = [0, 3].map(reinvestEvery => {
  const result = simulate({ ...common, reinvestEvery, durationSec: 2400 });
  verifyConservation(result);
  return { reinvestEvery, durationSec: 2400, targetCells: 20, metrics: metric(result) };
});
const report = {
  schema: 'cellforge.decision-comparison.v1', analysisDate: '2026-10-10',
  evidence: { label: 'verified_local_source', engineSHA256: createHash('sha256').update(await readFile(join(repoRoot, 'engine.js'))).digest('hex'), reproduction: 'node scripts/decision-compare.mjs' },
  scope: 'Synthetic fixed-order comparison. No field performance, ROI, procurement approval, or personal test-execution claim.',
  roleMapping: { label: 'derived', source: 'https://lselectric.recruiter.co.kr/career/jobs/129138', duties: ['AI/Digital 기반 업무, 운영 혁신 과제 발굴 및 기획', 'AX를 위한 업무 프로세스 최적화 및 거버넌스 구축'], application: 'Choose an operational objective, compare constrained alternatives, and define field verification gates before approval.' },
  commonInput: common, scenarios: rows,
  recommendation: { objective: 'Maximize shippable units for a 20-cell order at 1200 seconds.', nextFieldValidationCandidate: 'extra_arm', operatingDecision: 'Keep the baseline until real data, capex/operating cost, space, safety, availability, and reliability are verified.', reason: 'Seed 42 produces 18 shippable cells with added initial arm capacity versus 15 baseline; internal reinvestment produces 19 completed but only 13 shippable cells.', qualityDecision: 'Defer under this short-term shipping objective. No shipping gain at seed 42 does not establish no quality benefit; quality costs and field failure mechanisms are absent.' },
  sensitivity: { scope: 'Paired seeds 1..30; model sensitivity only, no confidence interval or field-effect estimate.', aggregate, paired },
  fortyMinuteAllocation: { scope: 'Same fixed 20-cell order; allocation comparison, not long-run throughput evidence.', results: fortyMinuteAllocation },
  validation: { exactScenarioAssertions: 'passed', deterministicReplay: 'passed', conservation: 'passed', sampledSnapshots, waitingStatistics: 'omitted: no additional waiting-time metric is needed for this decision' },
  attribution: { user: 'Factory topic/reference direction and requirement to explain company relevance, usefulness, readable titles, large captures, and marked screenshot areas.', codex: 'Scenario comparison design, script execution, conservation checks, and conditional interpretation in this report.' },
  limitations: ['Additional arm capacity is online from time zero; procurement, installation downtime and investment costs are not represented.', 'Lower testFailureRate is an assumed input change, not an implemented quality improvement.', 'No logistics, worker constraints, buffer blocking, mixed product flow, physical safety or failure availability model.', 'Shippable means completed products not allocated to internal installation; no dispatch or customer delivery event is modeled.', 'Scenario recommendation depends on the short-term shipping objective and does not establish a universally best policy.']
};
const pairedText = scenarios.slice(1).map(s => {
  const a = aggregate[s.id];
  return `| ${s.label} | ${a.completed.min} / ${a.completed.mean.toFixed(2)} / ${a.completed.max} | ${a.shippable.min} / ${a.shippable.mean.toFixed(2)} / ${a.shippable.max} |`;
}).join('\n');
const fortyText = fortyMinuteAllocation.map(r => `| ${r.reinvestEvery ? '3개마다 편입' : '편입 없음'} | ${r.metrics.completed} | ${r.metrics.shippable} | ${r.metrics.installed} | ${r.metrics.pendingInstall} | ${r.metrics.wip} | ${r.metrics.quarantined} |`).join('\n');
const markdown = `# 단기 출하 목표로 개선 대안 고르기

공고의 ‘AI/Digital 기반 업무, 운영 혁신 과제 발굴 및 기획’과 ‘AX를 위한 업무 프로세스 최적화 및 거버넌스 구축’에 활용할 수 있는 가상 생산 셀 시뮬레이터를 구현한 경험입니다. 직무 연결은 [LS ELECTRIC 공고](https://lselectric.recruiter.co.kr/career/jobs/129138)에 근거한 해석(derived)이며, 회사의 실제 공장 문제를 관찰하거나 해결했다는 주장이 아닙니다.

## 문제와 판단 기준

가상 주문 20개를 20분 내 처리할 때, 완료한 제품을 고객 출하용으로 남길지 내부 설비로 편입할지에 따라 성과가 달라집니다. 이번 판단 기준은 **20분 종료 시 출하 가능한 제품 수**입니다. 총 완료량과 내부 설비 증가량은 별도로 확인합니다.

## 같은 조건에서 비교

공통 입력: 주문 20개, BOM 20개분 재고(프레임 20세트·관절 120개·컨트롤러 20개·센서 40개·그리퍼 20개·지그 원료 3,600g), 실험 1,200초, 시드 42, 검사 실패 확률 0.12, 설치 45초, 자동 보충·강제 실패 끔. 기본 초기 설비는 9개 공정에 각 1개입니다.

| 대안 | 기준 대비 정확한 입력 변경 | 초기 설비 | 완료 | 출하 가능 | 편입 완료 | 설치 중 | 재공 | 격리 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${rows.map(r => `| ${r.label} | ${r.id === 'baseline' ? '없음: reinvestEvery=0, extraCells=[]' : r.id === 'extra_arm' ? 'extraCells=[{id:manual-1, stationId:arm}]' : r.id === 'lower_failure' ? 'testFailureRate=0.06' : 'reinvestEvery=3'} | ${r.initialResources.count} | ${r.metrics.completed} | ${r.metrics.shippable} | ${r.metrics.installed} | ${r.metrics.pendingInstall} | ${r.metrics.wip} | ${r.metrics.quarantined} |`).join('\n')}

모든 대안의 미도착 요청·자재 대기는 0개입니다. ‘출하 가능’은 엔진의 shipped 값으로, 조립·검사 완료품 중 내부 설치용으로 배분하지 않은 제품입니다. 실제 배송 완료가 아닙니다. 추가 암 설비는 구매 후 이미 설치되어 시간 0부터 가동하는 가정이며 생산 완료량에 더하지 않습니다. 검사 확률 변경은 품질 개선을 구현한 결과가 아니라 가정값을 낮춘 실험입니다.

## 조건부 제안

**초기 암 설비 1개 추가를 다음 현장 검증 후보로 제안합니다.** 시드 42에서 출하 가능량이 기준 15개에서 18개로 늘고 재공은 5개에서 2개로 줄었습니다. 다만 구매·배치 승인은 보류하고, 실제 공정시간·재검 기록·수요를 수집해 반복 비교한 뒤 투자비·운영비, 공간·안전, 가용성·신뢰성을 확인할 때까지 기준 운영을 유지합니다.

완료 3개마다 편입하는 안은 완료 19개로 가장 많지만 6개가 내부 설비에 배분되어 출하 가능량은 13개입니다. 그래서 이번 단기 출하 목표에서는 선택하지 않습니다. 검사 실패 확률 6% 안은 시드 42에서 출하 가능량이 그대로 15개여서 출하량만으로 우선순위를 올리지 않습니다. 재검·불량 비용과 현장 품질 원인을 계산하지 않았으므로 품질 개선의 가치가 없다는 결론은 아닙니다.

## 시드 민감도와 긴 관찰창

시드 1~30에 같은 시드를 짝지어 실행한 기준 대비 변화(최소 / 평균 / 최대):

| 대안 | 완료 변화 | 출하 가능 변화 |
| --- | --- | --- |
${pairedText}

이 값은 합성 모델의 시드 민감도이며 현장 개선 효과·신뢰구간·보장치가 아닙니다. 각 시드의 전체 값은 JSON에 보존했습니다.

같은 고정 주문 20개를 40분 관찰한 결과:

| 대안 | 완료 | 출하 가능 | 편입 완료 | 설치 중 | 재공 | 격리 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
${fortyText}

신규 주문을 계속 공급하는 실험이 아니므로 40분 결과는 제품 배분 비교이며 장기 처리량의 증명이 아닙니다.

## 재현·검증·기여 경계

저장소에서 \`node scripts/decision-compare.mjs\` 실행. 경로는 실행 위치가 아니라 스크립트 파일 위치로 계산하며 이 Markdown과 \`docs/decision-comparison.json\`을 다시 생성합니다. 엔진 SHA-256: \`${report.evidence.engineSHA256}\`.

4개 대안의 정확한 결과, 동일 입력의 전체 기록 재현, ${sampledSnapshots}개 시점의 주문·완료 배분·자재 보존을 확인했습니다. 기존 엔진과 UI는 변경하지 않았습니다. 이 비교는 모델 내부 검증이며 CI 실행이나 물리 설비 검증이 아닙니다.

사용자가 확인한 기여: 공장 주제·레퍼런스 방향을 제안하고 공고·회사와의 관련성 및 활용성을 확인하도록 요구했으며, 이해하기 쉬운 제목·큰 화면·영역 설명과 연결선 등 표현 방향을 검토했습니다. 이번 4대안 설계·시드 실행·보존 검증·조건부 결론 정리는 Codex가 지원했습니다. 사용자가 직접 이 실험이나 테스트를 수행한 것으로 쓰지 않습니다.

모델은 물류·작업자·버퍼 막힘·혼류·설비 고장·설치 중단·투자비·품질 비용을 다루지 않습니다. 실제 공장의 디지털 트윈 구축·운영 또는 회사 성과로 표현하지 않습니다.
`;
await mkdir(join(repoRoot, 'docs'), { recursive: true });
await writeFile(join(repoRoot, 'docs', 'decision-comparison.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
await writeFile(join(repoRoot, 'docs', 'DECISION_COMPARISON.md'), markdown, 'utf8');
console.table(rows.map(r => ({ scenario: r.id, initialResources: r.initialResources.count, ...r.metrics })));
console.log(`Exact outcomes, deterministic replay and ${sampledSnapshots} conservation snapshots passed.`);
console.log('Wrote docs/decision-comparison.json and docs/DECISION_COMPARISON.md.');

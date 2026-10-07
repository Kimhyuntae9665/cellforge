import { simulate, MATERIALS } from '../engine.js';

// Match the browser's default plan, rather than the engine's 8-cell default.
const stock = Object.fromEntries(MATERIALS.map(m => [m.id, m.perCell * 20]));
const run = (seed, reinvestEvery, durationSec = 1200) => {
  const { summary } = simulate({ targetCells: 20, stock, seed, reinvestEvery, durationSec });
  return Object.fromEntries(['completed', 'installed', 'shipped', 'wip'].map(k => [k, summary[k]]));
};
const baseline = run(42, 0), expansion = run(42, 3);
console.log('Synthetic model only: 20 requested cells, 20 minutes, seed 42.');
console.table({ baseline, expansion });
const paired = Array.from({ length: 30 }, (_, i) => {
  const seed = i + 1, a = run(seed, 0), b = run(seed, 3);
  return { seed, completedDelta: b.completed - a.completed, shippedDelta: b.shipped - a.shipped };
});
console.log('Paired seeds 1–30: expansion minus baseline (model sensitivity, not field validation).');
console.table(paired);
for (const key of ['completedDelta', 'shippedDelta']) {
  const values = paired.map(row => row[key]);
  console.log(`${key}: min=${Math.min(...values)}, mean=${values.reduce((a,b)=>a+b,0)/values.length}, max=${Math.max(...values)}`);
}
console.log('Seed 42, fixed order count, different horizons:');
console.table([600,1200,2400].flatMap(durationSec => [0,3].map(reinvestEvery => ({
  minutes: durationSec/60, reinvestEvery, ...run(42,reinvestEvery,durationSec)
}))));

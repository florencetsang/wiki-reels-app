import { makeSimUsers, simulate, syntheticCatalog } from "./sim.ts";

const sc = syntheticCatalog(1);
const users = makeSimUsers(sc, Number(process.argv[2] ?? 40), 3);
const t0 = performance.now();
for (const policy of ["random", "popular", "reco"] as const) {
  const r = simulate(sc, users, policy);
  console.log(
    `${policy.padEnd(8)} early=${r.earlyEngagement.toFixed(3)} late=${r.lateEngagement.toFixed(3)} ` +
      `likes=${r.likeRate.toFixed(3)} fields/10=${r.fieldsPer10.toFixed(2)} drops/user=${r.drops.toFixed(1)}`,
  );
}
console.log(`${(performance.now() - t0).toFixed(0)} ms`);

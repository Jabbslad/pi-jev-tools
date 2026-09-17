import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { calibration, score, type Arm, type ScoredPrediction } from "./direct-core.ts";

const dir = process.argv[2];
if (!dir) throw new Error("Pass the direct benchmark result directory. No API calls are made.");
type Row = ScoredPrediction & { id: string; gold: string; category: string; sourceRow: number };
type Run = {
  name: string; arm: Arm; repeat: number; batchIndex: number; seconds: number; usd: number | null;
  structureValid: boolean; error?: string; rows: Row[]; usage: { reasoning?: number };
};
const runs = JSON.parse(readFileSync(resolve(dir, "results.json"), "utf8")) as Run[];
const manifest = JSON.parse(readFileSync(resolve(dir, "manifest.json"), "utf8"));
const labels = manifest.categories.map((_: string, i: number) => `c${String(i).padStart(3, "0")}`);
const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
const median = (xs: number[]) => {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
};
const rawChoices = new Map<string, string>();
for (const run of runs) {
  const raw = JSON.parse(readFileSync(resolve(dir, `${run.name}.raw.json`), "utf8")).raw;
  const answers = run.arm === "jev" ? raw.answers : raw.content.find((c: { type: string }) => c.type === "toolCall")?.arguments?.answers;
  run.rows = run.rows.map(row => {
    const choice = answers?.[row.id]?.choice;
    if (typeof choice === "string") rawChoices.set(`${run.arm}:${run.repeat}:${row.id}`, choice);
    return { id: row.id, gold: row.gold, category: row.category, sourceRow: row.sourceRow,
      ...score(run.structureValid && !run.error ? answers?.[row.id] : undefined, row.gold, labels, run.arm !== "llm-labels") };
  });
}
// Preserve original run-time scores. Recompute from raw responses to correct only
// binary-floating-point treatment of the predeclared inclusive 0.05 boundary.
writeFileSync(resolve(dir, "rescored-results.json"), JSON.stringify(runs, null, 2));

const arms = (["jev", "llm-probabilities", "llm-labels"] as Arm[]).map(arm => {
  const selected = runs.filter(r => r.arm === arm);
  const rows = selected.flatMap(r => r.rows);
  const probabilityRows = rows.filter(r => r.valid && r.brier !== undefined);
  const byRepeat = [1, 2].map(repeat => {
    const rr = selected.filter(r => r.repeat === repeat);
    const predictions = rr.flatMap(r => r.rows);
    const p = predictions.filter(r => r.valid && r.brier !== undefined);
    return { repeat, examples: predictions.length, correct: predictions.filter(r => r.correct).length,
      valid: predictions.filter(r => r.valid).length,
      rawChoiceCorrectDiagnostic: predictions.filter(r => rawChoices.get(`${arm}:${repeat}:${r.id}`) === r.gold).length,
      brier: mean(p.map(r => r.brier!)), logLoss: mean(p.map(r => r.logLoss!)), calibration: calibration(p),
      usd: rr.reduce((n, r) => n + (r.usd ?? 0), 0), meanSeconds: mean(rr.map(r => r.seconds)) };
  });
  const ids = selected.filter(r => r.repeat === 1).flatMap(r => r.rows.map(row => row.id));
  const agreement = ids.filter(id => rawChoices.has(`${arm}:1:${id}`) && rawChoices.get(`${arm}:1:${id}`) === rawChoices.get(`${arm}:2:${id}`)).length;
  return {
    arm, calls: selected.length, structurallyValidCalls: selected.filter(r => r.structureValid).length,
    examplesIncludingRepeats: rows.length, correct: rows.filter(r => r.correct).length,
    validPredictions: rows.filter(r => r.valid).length,
    accuracy: rows.filter(r => r.correct).length / rows.length,
    rawChoiceCorrectDiagnostic: selected.reduce((n, run) => n + run.rows.filter(row => rawChoices.get(`${arm}:${run.repeat}:${row.id}`) === row.gold).length, 0),
    validProbabilityRows: probabilityRows.length, brier: mean(probabilityRows.map(r => r.brier!)),
    logLoss: mean(probabilityRows.map(r => r.logLoss!)), calibration: calibration(probabilityRows),
    highProbabilityErrors: probabilityRows.filter(r => r.topProbability! >= 0.9 && !r.correct).length,
    highProbabilityPredictions: probabilityRows.filter(r => r.topProbability! >= 0.9).length,
    probabilitySumRange: probabilityRows.length ? [Math.min(...probabilityRows.map(r => r.probabilitySum!)), Math.max(...probabilityRows.map(r => r.probabilitySum!))] : null,
    meanSeconds: mean(selected.map(r => r.seconds)), medianSeconds: median(selected.map(r => r.seconds)),
    secondsRange: [Math.min(...selected.map(r => r.seconds)), Math.max(...selected.map(r => r.seconds))],
    usd: selected.reduce((n, r) => n + (r.usd ?? 0), 0), unknownCosts: selected.filter(r => r.usd === null).length,
    reportedReasoningTokens: selected.reduce((n, r) => n + (r.usage?.reasoning ?? 0), 0),
    crossRepeatLabelAgreement: { agree: agreement, uniqueExamples: ids.length }, byRepeat,
  };
});

// Compare probability metrics only on the same valid example/repeat pairs as well
// as the per-arm valid subsets, to avoid hiding missing-output selection effects.
const paired: { jev: Row; llm: Row }[] = [];
for (const run of runs.filter(r => r.arm === "jev")) {
  const other = runs.find(r => r.arm === "llm-probabilities" && r.repeat === run.repeat && r.batchIndex === run.batchIndex)!;
  for (const row of run.rows) {
    const partner = other.rows.find(r => r.id === row.id)!;
    if (row.valid && partner.valid) paired.push({ jev: row, llm: partner });
  }
}
const matchedProbabilityMetrics = Object.fromEntries((["jev", "llm"] as const).map(key => [key, {
  rows: paired.length, correct: paired.filter(p => p[key].correct).length,
  brier: mean(paired.map(p => p[key].brier!)), logLoss: mean(paired.map(p => p[key].logLoss!)),
  calibration: calibration(paired.map(p => p[key])),
}]));
const pairedLabelComparisons = [1, 2].map(repeat => {
  const jev = runs.filter(r => r.arm === "jev" && r.repeat === repeat).flatMap(r => r.rows);
  const llm = runs.filter(r => r.arm === "llm-labels" && r.repeat === repeat).flatMap(r => r.rows);
  return { repeat, bothCorrect: jev.filter((r, i) => r.correct && llm[i].correct).length,
    jevOnlyCorrect: jev.filter((r, i) => r.correct && !llm[i].correct).length,
    llmOnlyCorrect: jev.filter((r, i) => !r.correct && llm[i].correct).length,
    bothIncorrect: jev.filter((r, i) => !r.correct && !llm[i].correct).length };
});
const pairedTiming = (["llm-probabilities", "llm-labels"] as Arm[]).map(arm => {
  const ratios = runs.filter(r => r.arm === "jev").map(jev => {
    const other = runs.find(r => r.arm === arm && r.repeat === jev.repeat && r.batchIndex === jev.batchIndex)!;
    return other.seconds / jev.seconds;
  });
  return { arm, medianPairedLatencyRatio: median(ratios), ratioRange: [Math.min(...ratios), Math.max(...ratios)] };
});
const summary = { resultDirectory: dir, scoringNote: "Recomputed offline with 1e-12 numerical epsilon at the unchanged inclusive 0.05 sum tolerance. Original run-time results preserved.", arms, matchedProbabilityMetrics, pairedLabelComparisons, pairedTiming,
  caveat: "77 unique examples repeated twice; no significance or general calibration claim. Raw-choice accuracy is post-hoc diagnostic only; it does not repair invalid distributions." };
writeFileSync(resolve(dir, "aggregate.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));

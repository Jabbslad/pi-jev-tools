import { createHash } from "node:crypto";
import { Type, StringEnum } from "@earendil-works/pi-ai";
import type { Questions } from "@typesafe-ai/sdk";

export const hash = (text: string) => createHash("sha256").update(text).digest("hex");
export const SEED = "pi-typesafe-banking77-pilot-v1";
export type Example = { id: string; text: string; category: string; sourceRow: number };
export type Arm = "jev" | "llm-probabilities" | "llm-labels";
export type Prediction = { choice?: unknown; probabilities?: unknown };

export function sample(rows: { text: string; category: string }[], categories: string[]): Example[] {
  const indexed = rows.map((r, sourceRow) => ({ ...r, sourceRow }));
  const selected = [...categories].sort().map(category => {
    const candidates = indexed.filter(r => r.category === category);
    candidates.sort((a, b) => hash(`${SEED}:${a.sourceRow}`).localeCompare(hash(`${SEED}:${b.sourceRow}`)));
    if (!candidates[0]) throw new Error(`No examples for ${category}`);
    return candidates[0];
  });
  selected.sort((a, b) => hash(`${SEED}:order:${a.sourceRow}`).localeCompare(hash(`${SEED}:order:${b.sourceRow}`)));
  return selected.map((r, i) => ({ ...r, id: `q${String(i).padStart(3, "0")}` }));
}

export function makeRequest(batch: Example[], categories: string[]) {
  const criteria = Object.fromEntries([...categories].sort().map((c, i) => [
    `c${String(i).padStart(3, "0")}`, c.replaceAll("_", " "),
  ]));
  const questions: Questions = Object.fromEntries(batch.map(row => [row.id, {
    type: "choice",
    instructions: `Which single banking intent best describes ONLY state.messages.${row.id}? Select the closest intent using only the supplied message.`,
    criteria,
  }]));
  return {
    state: { messages: Object.fromEntries(batch.map(row => [row.id, row.text])) },
    questions,
  };
}

export function answerSchema(ids: string[], labels: string[], probabilities: boolean) {
  const answer = Type.Object({
    choice: StringEnum(labels),
    ...(probabilities ? { probabilities: Type.Object(Object.fromEntries(labels.map(label => [
      label, Type.Number({ minimum: 0, maximum: 1 }),
    ])), { additionalProperties: false }) } : {}),
  }, { additionalProperties: false });
  return Type.Object({ answers: Type.Object(Object.fromEntries(ids.map(id => [id, answer])), {
    additionalProperties: false,
  }) }, { additionalProperties: false });
}

export type ScoredPrediction = {
  valid: boolean; correct: boolean; reason?: string; choice?: string;
  probabilitySum?: number; topProbability?: number; brier?: number; logLoss?: number;
};
export const PROBABILITY_SUM_TOLERANCE = 0.05;
export function score(prediction: Prediction | undefined, gold: string, labels: string[], withProbabilities: boolean): ScoredPrediction {
  const invalid = (reason: string) => ({ valid: false, correct: false, reason });
  if (!prediction || typeof prediction.choice !== "string" || !labels.includes(prediction.choice)) {
    return invalid("Missing or invalid choice");
  }
  if (!withProbabilities) return { valid: true, correct: prediction.choice === gold, choice: prediction.choice };
  const p = prediction.probabilities;
  if (!p || typeof p !== "object" || Array.isArray(p)) return invalid("Missing probability map");
  const map = p as Record<string, unknown>;
  if (Object.keys(map).length !== labels.length || labels.some(k => typeof map[k] !== "number" ||
    !Number.isFinite(map[k]) || (map[k] as number) < 0 || (map[k] as number) > 1)) {
    return invalid("Probability keys or values invalid");
  }
  const values = labels.map(k => map[k] as number);
  const sum = values.reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 1) > PROBABILITY_SUM_TOLERANCE + 1e-12) return invalid("Probabilities do not sum approximately to one");
  const max = Math.max(...values);
  if ((map[prediction.choice] as number) < max - 1e-8) return invalid("Choice is not an argmax");
  // Normalize only within the predeclared rounding tolerance; preserve raw sums.
  const normalized = values.map(v => v / sum);
  const goldIndex = labels.indexOf(gold);
  if (goldIndex < 0) throw new Error("Gold label absent from choices");
  return {
    valid: true, correct: prediction.choice === gold, choice: prediction.choice,
    probabilitySum: sum, topProbability: max / sum,
    brier: normalized.reduce((n, v, i) => n + (v - Number(i === goldIndex)) ** 2, 0),
    logLoss: -Math.log(Math.max(1e-15, normalized[goldIndex])),
  };
}

export function calibration(rows: ReturnType<typeof score>[]) {
  const valid = rows.filter(r => r.valid && r.topProbability !== undefined);
  const bins = Array.from({ length: 5 }, (_, i) => {
    const items = valid.filter(r => Math.min(4, Math.floor(r.topProbability! * 5)) === i);
    return { lower: i / 5, upper: (i + 1) / 5, count: items.length,
      accuracy: items.length ? items.filter(r => r.correct).length / items.length : null,
      meanProbability: items.length ? items.reduce((s, r) => s + r.topProbability!, 0) / items.length : null };
  });
  return { bins, ece: valid.length ? bins.reduce((s, b) => s + b.count * Math.abs((b.accuracy ?? 0) - (b.meanProbability ?? 0)), 0) / valid.length : null };
}

import assert from "node:assert/strict";
import { test } from "node:test";
import { Check } from "typebox/value";
import { answerSchema, calibration, makeRequest, sample, score } from "../scripts/direct-core.ts";

const labels = ["c000", "c001"];
test("direct sample is deterministic and includes one independent source row per category", () => {
  const rows = [{ text: "A", category: "a" }, { text: "B", category: "b" }, { text: "C", category: "a" }];
  const selected = sample(rows, ["a", "b"]);
  assert.deepEqual(sample(rows, ["b", "a"]), selected);
  assert.equal(selected.length, 2);
  assert.equal(new Set(selected.map(r => r.sourceRow)).size, 2);
});

test("fixed requests explicitly target each item and omit gold labels", () => {
  const request = makeRequest([{ id: "q0", text: "hello", category: "PRIVATE_GOLD", sourceRow: 8 }], ["a", "b"]);
  assert.deepEqual(request.state, { messages: { q0: "hello" } });
  assert.match(String(request.questions.q0.instructions), /state.messages.q0/);
  assert.ok(!JSON.stringify(request).includes("PRIVATE_GOLD"));
});

test("structured contract requires every option and answer with no extras", () => {
  const schema = answerSchema(["q0"], labels, true);
  assert.ok(Check(schema, { answers: { q0: { choice: "c000", probabilities: { c000: 0.8, c001: 0.2 } } } }));
  assert.ok(!Check(schema, { answers: { q0: { choice: "c000", probabilities: { c000: 1 } } } }));
  assert.ok(!Check(schema, { answers: {} }));
  assert.ok(Check(answerSchema(["q0"], labels, false), { answers: { q0: { choice: "c001" } } }));
});

test("direct metrics use class probabilities, not a separate confidence statistic", () => {
  const result = score({ choice: "c000", probabilities: { c000: 0.8, c001: 0.2 } }, "c000", labels, true);
  assert.equal(result.valid, true);
  assert.equal(result.correct, true);
  assert.ok(Math.abs(result.brier! - 0.08) < 1e-10);
  assert.ok(Math.abs(result.logLoss! + Math.log(0.8)) < 1e-10);
  assert.equal(result.topProbability, 0.8);
});

test("invalid distributions fail rather than being repaired silently", () => {
  for (const probabilities of [{ c000: 1 }, { c000: 0.2, c001: 0.3 }, { c000: NaN, c001: 1 }, { c000: -0.2, c001: 1.2 }]) {
    assert.equal(score({ choice: "c000", probabilities }, "c000", labels, true).valid, false);
  }
  assert.equal(score({ choice: "c000", probabilities: { c000: 0.2, c001: 0.8 } }, "c000", labels, true).valid, false);
  assert.equal(score(undefined, "c000", labels, false).correct, false);
});

test("rounding normalization is bounded, reported, and ties are accepted", () => {
  const result = score({ choice: "c000", probabilities: { c000: 0.5, c001: 0.49 } }, "c000", labels, true);
  assert.equal(result.probabilitySum, 0.99);
  assert.equal(result.topProbability, 0.5 / 0.99);
  assert.equal(score({ choice: "c000", probabilities: { c000: 0.9, c001: 0.05 } }, "c000", labels, true).valid, true);
  assert.equal(score({ choice: "c000", probabilities: { c000: 0.89, c001: 0.05 } }, "c000", labels, true).valid, false);
  assert.equal(score({ choice: "c001", probabilities: { c000: 0.5, c001: 0.5 } }, "c000", labels, true).valid, true);
});

test("calibration bins include probability one and exclude invalid rows", () => {
  const rows = [score({ choice: "c000", probabilities: { c000: 1, c001: 0 } }, "c000", labels, true),
    score({ choice: "c000", probabilities: { c000: 0.8, c001: 0.2 } }, "c001", labels, true),
    score(undefined, "c000", labels, true)];
  const result = calibration(rows);
  assert.equal(result.bins[4].count, 2);
  assert.equal(result.bins[4].accuracy, 0.5);
  assert.ok(Math.abs(result.ece! - 0.4) < 1e-10);
});

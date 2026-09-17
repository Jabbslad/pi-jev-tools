import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { clientConfig } from "../src/client.ts";
import { createRankTool, createClassifyTool, planRequests } from "../src/decisions.ts";

const ctx = {} as ExtensionContext;
const scoreAnswer = (score = 2, confidence = 0.9) => ({ type: "score", score, confidence,
  probabilities: { "0": score === 0 ? 1 : 0, "1": score === 1 ? 1 : 0, "2": score === 2 ? 1 : 0 } });
function mockClient(answer: (body: any) => Record<string, unknown>) {
  return () => new TypeSafeClient({ ...clientConfig, apiKey: "test", retry: { maxRetries: 0 },
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      return Response.json({ model: "jev-1.13.0", answers: answer(body), usage: { input_tokens: 100, output_tokens: 10 } });
    },
  });
}

test("rank constructs targeted Score questions, batches and sums usage", async () => {
  let calls = 0;
  const tool = createRankTool(mockClient(body => {
    calls++;
    assert.equal(body.state.query, "token refresh");
    assert.ok(Object.keys(body.questions).length <= 12);
    for (const [key, question] of Object.entries(body.questions) as [string, any][]) {
      assert.equal(question.type, "score");
      assert.ok(question.criteria.every((c: unknown) => typeof c === "string"));
      assert.ok(question.instructions.includes(`state.items.${key}.text`));
      assert.ok(body.state.items[key].text);
    }
    return Object.fromEntries(Object.keys(body.questions).map(k => [k, scoreAnswer()]));
  }));
  const result = await tool.execute("id", {
    query: "token refresh", candidates: Array.from({ length: 25 }, (_, i) => ({ id: `c${i}`, text: `candidate ${i}` })), top_k: 2,
  }, undefined, undefined, ctx);
  assert.equal(calls, 3);
  assert.equal(result.usage?.input, 300);
  assert.equal(result.usage?.totalTokens, 330);
  assert.deepEqual(result.details.results.map(r => r.id), ["c0", "c1"]);
  assert.equal(result.details.omitted_count, 23);
  assert.equal(result.details.boundary?.omitted_ties, 23);
  assert.equal(result.details.all_ratings.length, 25);
});

test("rank retains low-confidence and zero-score candidates, with caller-only review flags", async () => {
  const tool = createRankTool(mockClient(() => ({ item_0: scoreAnswer(2, 0.1), item_1: scoreAnswer(0, 1) })));
  const result = await tool.execute("id", { query: "q", candidates: [{ id: "uncertain", text: "a" }, { id: "irrelevant", text: "b" }], review_below_confidence: 0.8 }, undefined, undefined, ctx);
  assert.equal(result.details.results.length, 2);
  assert.equal(result.details.results[0].review, "below_caller_threshold");
  assert.equal(result.details.results[1].review, "meets_caller_threshold");
  assert.equal(result.details.review_policy.validated, false);
});

test("classification builds code-owned categories and preserves IDs and uncertainty", async () => {
  const tool = createClassifyTool(mockClient(body => {
    assert.equal(body.questions.item_0.type, "choice");
    assert.match(body.questions.item_1.instructions, /state\.items\.item_1\.text/);
    assert.equal(Object.keys(body.questions.item_0.criteria).length, 3);
    assert.match(body.questions.item_0.criteria.category_2, /Insufficient evidence/);
    return {
      item_0: { type: "choice", choice: "category_0", confidence: 0.9, probabilities: { category_0: 0.9, category_1: 0.05, category_2: 0.05 } },
      item_1: { type: "choice", choice: "category_2", confidence: 0.5, probabilities: { category_0: 0.2, category_1: 0.2, category_2: 0.6 } },
    };
  }));
  const result = await tool.execute("id", { items: [{ id: "__proto__", text: "Refund" }, { id: "b", text: "It broke" }], categories: { billing: "Payments", technical: "Software" } }, undefined, undefined, ctx);
  assert.deepEqual(result.details.results.map(r => [r.id, r.category]), [["__proto__", "billing"], ["b", "__unclear__"]]);
  assert.equal(result.details.results[0].probabilities.billing, 0.9);
  assert.equal(result.details.results[0].review, "not_configured");
  assert.equal(result.details.results[1].review, "unclear_requires_review");
  assert.equal(result.details.review_policy.threshold, null);
});

test("duplicate IDs and reserved/oversized categories fail before network", async () => {
  let calls = 0;
  const factory = mockClient(() => { calls++; return {}; });
  await assert.rejects(createRankTool(factory).execute("id", { query: "q", candidates: [{ id: "x", text: "a" }, { id: "x", text: "b" }] }, undefined, undefined, ctx), /unique/);
  for (const categories of [{ __unclear__: "Bad", other: "Other" }, { ["a".repeat(49)]: "Too long", other: "Other" }]) {
    await assert.rejects(createClassifyTool(factory).execute("id", { items: [{ id: "a", text: "x" }], categories }, undefined, undefined, ctx));
  }
  assert.equal(calls, 0);
});

test("planner enforces byte budget and fails before any evaluation for oversized items", () => {
  const items = [{ id: "a", text: "a".repeat(15000) }, { id: "b", text: "b".repeat(15000) }];
  const build = (group: { key: string; item: { text: string } }[]) => ({
    state: Object.fromEntries(group.map(e => [e.key, e.item.text])), questions: { q: { type: "noul" as const, instructions: "Yes?" } },
  });
  assert.equal(planRequests(items, build).length, 2);
  assert.throws(() => planRequests([{ id: "x", text: "界".repeat(9000) }], build), /24 KB/);
});

for (const [name, answers] of Object.entries({
  missing: {},
  extra: { item_0: scoreAnswer(), extra: scoreAnswer() },
  "bad score": { item_0: { ...scoreAnswer(), score: 3 } },
  "bad distribution": { item_0: { ...scoreAnswer(), probabilities: { "0": 0, "1": 0, "2": 0.2 } } },
})) {
  test(`rank rejects ${name} API answers`, async () => {
    await assert.rejects(createRankTool(mockClient(() => answers)).execute("id", { query: "q", candidates: [{ id: "a", text: "a" }] }, undefined, undefined, ctx), /TypeSafe returned/);
  });
}

test("answers from another batch cannot overwrite a previously valid rating", async () => {
  const tool = createRankTool(mockClient(body => ({
    ...Object.fromEntries(Object.keys(body.questions).map(k => [k, scoreAnswer()])), item_0: scoreAnswer(),
  })));
  await assert.rejects(tool.execute("id", { query: "q", candidates: Array.from({ length: 13 }, (_, i) => ({ id: `${i}`, text: "text" })) }, undefined, undefined, ctx), /extra answers in a batch/);
});

test("classification rejects a choice inconsistent with its probabilities", async () => {
  const tool = createClassifyTool(mockClient(() => ({ item_0: { type: "choice", choice: "category_1", confidence: 0.9,
    probabilities: { category_0: 0.9, category_1: 0.05, category_2: 0.05 } } })));
  await assert.rejects(tool.execute("id", { items: [{ id: "x", text: "x" }], categories: { a: "A", b: "B" } }, undefined, undefined, ctx), /inconsistent/);
});

test("large category sets preserve full probabilities in details while bounding model context", async () => {
  const categories = Object.fromEntries(Array.from({ length: 128 }, (_, i) => [`category_${i}_${"x".repeat(25)}`, "A category"]));
  const tool = createClassifyTool(mockClient(body => Object.fromEntries(Object.entries(body.questions).map(([key, q]: [string, any]) => [key, {
    type: "choice", choice: "category_0", confidence: 0,
    probabilities: Object.fromEntries(Object.keys(q.criteria).map(k => [k, 1 / 129])),
  }]))));
  const result = await tool.execute("id", { items: Array.from({ length: 32 }, (_, i) => ({ id: `item${i}`, text: "example" })), categories }, undefined, undefined, ctx);
  assert.ok(result.content[0].type === "text");
  const output = JSON.parse(result.content[0].text);
  assert.equal(output.probabilities_in_details_only, true);
  assert.ok(Buffer.byteLength(result.content[0].text) < 48_000);
  assert.equal(Object.keys(result.details.results[0].probabilities).length, 129);
  assert.equal(output.results[0].selected_probability, 1 / 129);
});

test("specialized tools honor cancellation before contacting TypeSafe", async () => {
  let calls = 0;
  const factory = mockClient(() => { calls++; return {}; });
  await assert.rejects(createRankTool(factory).execute("id", { query: "q", candidates: [{ id: "a", text: "a" }] }, AbortSignal.abort(), undefined, ctx));
  assert.equal(calls, 0);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { discoverAndLoadExtensions, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { TypeSafeClient, type Fetch } from "@typesafe-ai/sdk";
import { Check } from "typebox/value";
import extension from "../index.ts";
import { createEvaluateTool, clientConfig } from "../src/tool.ts";
import { parameters, type EvaluateParams } from "../src/schema.ts";

const params: EvaluateParams = {
  state: { message: "Please refund my duplicate charge." },
  questions: {
    category: { type: "choice", instructions: "Which category?", criteria: { billing: "Payments", other: null } },
    urgency: { type: "score", instructions: "How urgent?", criteria: ["Routine", "Urgent"] },
    refund: { type: "noul", instructions: "Is a refund requested?" },
  },
};
const response = {
  model: "jev-1.13.0",
  answers: {
    category: { type: "choice", choice: "billing", probabilities: { billing: 0.9, other: 0.1 }, confidence: 0.7 },
    urgency: { type: "score", score: 0.2, legend: { 0: "Routine", 1: "Urgent" }, probabilities: { 0: 0.8, 1: 0.2 }, confidence: 0.5 },
    refund: { type: "noul", noul: 0.95 },
  },
  usage: { input_tokens: 1000, output_tokens: 50 },
};
function toolWithFetch(fetch: Fetch, deadlineMs?: number) {
  return createEvaluateTool(() => new TypeSafeClient({
    ...clientConfig,
    apiKey: "test-key",
    fetch,
    retry: { maxRetries: 2, backoffInitialMs: 0, backoffMaxMs: 0, backoffJitter: 0 },
  }), deadlineMs);
}
function run(tool: ReturnType<typeof createEvaluateTool>, input = params, signal?: AbortSignal) {
  return tool.execute("test-call", input, signal, undefined, {} as ExtensionContext);
}

test("extension registers four tools without constructing an authenticated client", () => {
  const registered: string[] = [];
  extension({ registerTool: (tool) => { registered.push(tool.name); } } as ExtensionAPI);
  assert.deepEqual(registered, ["typesafe_evaluate", "jev_rank", "jev_classify", "jev_search"]);
});

test("Pi's actual loader loads the extension from its entry point", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-typesafe-test-"));
  try {
    const loaded = await discoverAndLoadExtensions([resolve("index.ts")], dir, dir);
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.extensions.length, 1);
    for (const name of ["typesafe_evaluate", "jev_rank", "jev_classify", "jev_search"]) {
      assert.ok(loaded.extensions[0].tools.has(name));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("sends one batch, preserves all answers, and reports nested usage", async () => {
  let calls = 0;
  const tool = toolWithFetch(async (url, init) => {
    calls++;
    assert.equal(url, "https://api.typesafe.ai/v1/systemone");
    assert.equal(init?.method, "POST");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-key");
    assert.deepEqual(JSON.parse(String(init?.body)), { ...params, model: "jev-latest" });
    return Response.json(response);
  });
  const result = await run(tool);
  assert.equal(calls, 1);
  assert.deepEqual(result.details, response);
  const content = result.content[0];
  assert.equal(content.type, "text");
  assert.ok(content.type === "text");
  assert.deepEqual(JSON.parse(content.text), response);
  assert.ok(result.usage);
  assert.equal(result.usage.totalTokens, 1050);
  assert.equal(result.usage.cost.input, 0.000042);
  assert.equal(result.usage.cost.output, 0);
});

test("Pi prepares missing types for unambiguous Choice, Score, and Noul questions", async () => {
  const tool = toolWithFetch(async (_url, init) => {
    assert.deepEqual(JSON.parse(String(init?.body)), { ...params, model: "jev-latest" });
    return Response.json(response);
  });
  const missing = { ...params, questions: {
    category: { instructions: "Which category?", criteria: { billing: "Payments", other: null } },
    urgency: { instructions: "How urgent?", criteria: ["Routine", "Urgent"] },
    refund: { instructions: "Is a refund requested?" },
  } };
  const prepared = tool.prepareArguments!(missing);
  assert.deepEqual(prepared, params);
  assert.ok(Check(parameters, prepared));
  await run(tool, prepared);
  assert.deepEqual(missing.questions.category, { instructions: "Which category?", criteria: { billing: "Payments", other: null } });
});

test("Pi leaves ambiguous and explicit question types for strict validation", () => {
  const tool = createEvaluateTool();
  const ambiguous = { ...params, questions: { q: { instructions: "Which?", criteria: { true: "Yes", false: "No" } } } };
  assert.deepEqual(tool.prepareArguments!(ambiguous), ambiguous);
  assert.equal(Check(parameters, tool.prepareArguments!(ambiguous)), false);
  const oneNoulCriterion = { ...params, questions: { q: { instructions: "Is it true?", criteria: { true: "Yes" } } } };
  assert.equal(tool.prepareArguments!(oneNoulCriterion).questions.q.type, "noul");
  const missingChoice = { ...params, questions: { q: { instructions: "Pick", criteria: { billing: "Payments" } } } };
  assert.equal(Check(parameters, tool.prepareArguments!(missingChoice)), false);
  const explicit = { ...params, questions: { q: { type: "noul", instructions: "Yes?", criteria: { maybe: "Perhaps" } } } };
  assert.deepEqual(tool.prepareArguments!(explicit), explicit);
  assert.equal(Check(parameters, tool.prepareArguments!(explicit)), false);
});

test("accepts a pinned model and array state", async () => {
  const tool = toolWithFetch(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, "jev-1.13.0");
    assert.deepEqual(body.state, ["first", "second"]);
    return Response.json(response);
  });
  await run(tool, { ...params, state: ["first", "second"], model: "jev-1.13.0" });
});

for (const [name, input] of Object.entries({
  "empty questions": { ...params, questions: {} },
  "unknown primitive": { ...params, questions: { q: { type: "text", instructions: "Generate" } } },
  "missing instructions": { ...params, questions: { q: { type: "noul" } } },
  "empty instructions": { ...params, questions: { q: { type: "noul", instructions: "" } } },
  "one score level": { ...params, questions: { q: { type: "score", instructions: "Rate", criteria: ["Low"] } } },
  "named score levels": { ...params, questions: { q: { type: "score", instructions: "Rate", criteria: { low: "Low", high: "High" } } } },
  "object score levels": { ...params, questions: { q: { type: "score", instructions: "Rate", criteria: [{ name: "Low" }, { name: "High" }] } } },
  "empty choices": { ...params, questions: { q: { type: "choice", instructions: "Pick", criteria: {} } } },
  "invalid noul criteria": { ...params, questions: { q: { type: "noul", instructions: "Yes?", criteria: { maybe: "Perhaps" } } } },
  "null state": { ...params, state: null },
  "unknown model": { ...params, model: "not-a-supported-model" },
})) {
  test(`rejects ${name} before contacting the service`, async () => {
    let calls = 0;
    const tool = toolWithFetch(async () => { calls++; return Response.json(response); });
    await assert.rejects(run(tool, input as EvaluateParams), /Validation failed/);
    assert.equal(calls, 0);
  });
}

test("missing key fails only when called", async (t) => {
  const saved = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected network request"); });
  try {
    const tool = createEvaluateTool();
    await assert.rejects(run(tool), /No API key was provided/);
  } finally {
    if (saved !== undefined) process.env.TYPESAFE_API_KEY = saved;
  }
});

for (const status of [401, 422, 429, 529]) {
  test(`HTTP ${status} is actionable, bounded, and does not echo server body`, async () => {
    let calls = 0;
    const tool = toolWithFetch(async () => {
      calls++;
      return Response.json({ detail: "private-state-do-not-echo" }, { status });
    });
    await assert.rejects(run(tool), (error: Error) => {
      assert.match(error.message, new RegExp(`HTTP ${status}`));
      assert.doesNotMatch(error.message, /private-state/);
      return true;
    });
    assert.equal(calls, status === 429 || status === 529 ? 3 : 1);
  });
}

test("recovers from a transient overload", async () => {
  let calls = 0;
  const tool = toolWithFetch(async () => ++calls === 1
    ? Response.json({}, { status: 529 })
    : Response.json(response));
  await run(tool);
  assert.equal(calls, 2);
});

test("already aborted calls do not construct a client", async () => {
  let constructed = false;
  const tool = createEvaluateTool(() => { constructed = true; throw new Error("unexpected"); });
  await assert.rejects(run(tool, params, AbortSignal.abort()), /abort/i);
  assert.equal(constructed, false);
});

test("in-flight cancellation reaches the SDK fetch", async () => {
  const controller = new AbortController();
  const tool = toolWithFetch(async (_url, init) => new Promise((_resolve, reject) => {
    init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
    controller.abort();
  }));
  await assert.rejects(run(tool, params, controller.signal), /cancelled/);
});

test("total deadline aborts a pending request", async () => {
  const tool = toolWithFetch(async (_url, init) => new Promise((_resolve, reject) => {
    init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
  }), 20);
  await assert.rejects(run(tool), /total request deadline/);
});

test("cancellation interrupts a server-directed retry delay", async () => {
  const controller = new AbortController();
  let calls = 0;
  const tool = toolWithFetch(async () => {
    calls++;
    setTimeout(() => controller.abort(), 20);
    return Response.json({}, { status: 429, headers: { "retry-after": "60" } });
  });
  await assert.rejects(run(tool, params, controller.signal), /cancelled/);
  assert.equal(calls, 1);
});

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "csv-parse/sync";
import { Check } from "typebox/value";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import type { Model } from "@earendil-works/pi-ai";
import { answerSchema, hash, makeRequest, sample, score, SEED, type Arm, type Example, type Prediction } from "./direct-core.ts";

const REVISION = "57ec275d8078af65b7731c2a98be812d844a6d6b";
const BASE = `https://raw.githubusercontent.com/PolyAI-LDN/task-specific-datasets/${REVISION}`;
const DATA = resolve("evals/results/banking77-pilot");
const INPUT = `${DATA}/sample.json`;
const mode = process.argv[2];
if (!["--prepare", "--run"].includes(mode)) throw new Error("Use --prepare (download/freeze public data) or --run (66 billable API calls).");

if (mode === "--prepare") {
  mkdirSync(DATA, { recursive: true });
  const sources: Record<string, string> = {};
  for (const file of ["banking_data/test.csv", "banking_data/categories.json", "LICENSE", "README.md"]) {
    const response = await fetch(`${BASE}/${file}`, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Download failed: ${file} ${response.status}`);
    sources[file] = await response.text();
  }
  const rows = parse(sources["banking_data/test.csv"], { columns: true, skip_empty_lines: true }) as { text: string; category: string }[];
  const categories = (JSON.parse(sources["banking_data/categories.json"]) as string[]).sort();
  if (rows.length !== 3080 || categories.length !== 77) throw new Error("Unexpected source dataset shape");
  const selected = sample(rows, categories);
  writeFileSync(INPUT, JSON.stringify({ revision: REVISION, seed: SEED, categories, selected,
    sourceHashes: Object.fromEntries(Object.entries(sources).map(([k, v]) => [k, hash(v)])),
  }, null, 2), { flag: "wx" });
  writeFileSync(`${DATA}/LICENSE`, sources.LICENSE);
  console.log(`Frozen ${selected.length} examples in ${INPUT}. No model calls made.`);
} else {
  if (!process.env.TYPESAFE_API_KEY?.trim()) throw new Error("Set TYPESAFE_API_KEY before --run.");
  const frozen = JSON.parse(readFileSync(INPUT, "utf8")) as { categories: string[]; selected: Example[] };
  const runtime = await ModelRuntime.create({ allowModelNetwork: false, refreshOnCreate: false });
  const model = runtime.getModel("zai", "glm-5.3-flash");
  if (!model || model.api !== "openai-completions") throw new Error("Configured zai/glm-5.3-flash model unavailable");
  const zaiModel = model as Model<"openai-completions">;
  const client = new TypeSafeClient({
    baseURL: "https://api.typesafe.ai", defaultModel: "jev-1.13.0", logLevel: "off",
    timeout: 180_000, retry: { maxRetries: 0 },
  });
  const dir = `${DATA}/${new Date().toISOString().replaceAll(":", "-")}`;
  mkdirSync(dir);
  const labels = frozen.categories.map((_, i) => `c${String(i).padStart(3, "0")}`);
  const probabilityPrompt = "Evaluate the supplied state against every fixed Choice question. Do not rewrite questions. Return the selected option and a probability for EVERY option (including zeros), summing to one. The selected option must have maximal probability. Report genuine uncertainty. Call submit_answers once with all answers; no explanation or other tools.";
  const labelPrompt = "Evaluate the supplied state against every fixed Choice question. Do not rewrite questions. Return the selected option for each question. Call submit_answers once with all answers; no explanation or other tools.";
  writeFileSync(`${dir}/manifest.json`, JSON.stringify({
    startedAt: new Date().toISOString(), revision: REVISION, seed: SEED,
    sampleHash: hash(readFileSync(INPUT, "utf8")), categories: frozen.categories,
    sourceHashes: Object.fromEntries(["scripts/direct-core.ts", "scripts/direct-benchmark.ts", "package-lock.json"].map(p => [p, hash(readFileSync(p, "utf8"))])),
    mainModel: { id: model.id, provider: model.provider, cost: model.cost }, typesafeModel: "jev-1.13.0",
    temperature: 0, thinking: "disabled", maxOutputTokens: 16384,
    retries: 0, timeoutMs: 180000, batchSize: 7, repeats: 2,
    probabilityPrompt, labelPrompt,
    notes: "No agent loop, no repairs; labels-only is a separate output-cost control. Raw rounding tolerance 0.05, then normalize for probability metrics.",
  }, null, 2));
  console.log(`Results: ${dir}`);
  const records: object[] = [];
  const arms: Arm[] = ["jev", "llm-probabilities", "llm-labels"];
  for (let repeat = 1; repeat <= 2; repeat++) {
    for (let start = 0; start < frozen.selected.length; start += 7) {
      const batch = frozen.selected.slice(start, start + 7);
      const batchIndex = start / 7;
      const request = makeRequest(batch, frozen.categories);
      writeFileSync(`${dir}/batch-${batchIndex}.request.json`, JSON.stringify(request, null, 2));
      // Rotate the first arm and reverse on repetition 2 to reduce fixed-order bias.
      const order = [...arms.slice(batchIndex % 3), ...arms.slice(0, batchIndex % 3)];
      if (repeat === 2) order.reverse();
      for (const arm of order) {
        const name = `${arm}.${batchIndex}.${repeat}`;
        const schema = answerSchema(batch.map(r => r.id), labels, arm !== "llm-labels");
        let answers: Record<string, Prediction> = {};
        let usd: number | null = null;
        let usage: unknown;
        let actualModel: string | undefined;
        let error: string | undefined;
        let raw: unknown;
        let structureValid = false;
        const began = performance.now();
        try {
          if (arm === "jev") {
            const response = await client.systemOne({ ...request, model: "jev-1.13.0" }, { signal: AbortSignal.timeout(180_000) });
            raw = response;
            actualModel = response.model;
            usage = response.usage;
            usd = response.usage.input_tokens * 0.042 / 1_000_000;
            answers = Object.fromEntries(Object.entries(response.answers).map(([k, v]) => {
              if (v.type !== "choice") throw new Error("Unexpected answer primitive");
              return [k, { choice: v.choice, probabilities: v.probabilities }];
            }));
            structureValid = Check(schema, { answers });
          } else {
            const response = await runtime.complete(zaiModel, {
              systemPrompt: arm === "llm-probabilities" ? probabilityPrompt : labelPrompt,
              messages: [{ role: "user", content: JSON.stringify(request), timestamp: Date.now() }],
              tools: [{ name: "submit_answers", description: "Submit the answers to all supplied questions.", parameters: schema }],
            }, {
              temperature: 0, maxTokens: 16384, maxRetries: 0, signal: AbortSignal.timeout(180_000),
              toolChoice: { type: "function", function: { name: "submit_answers" } },
              onPayload(payload) {
                // Explicit provider setting; unlike the agent runs, no hidden reasoning is requested.
                return { ...(payload as object), thinking: { type: "disabled" } };
              },
            });
            raw = response;
            actualModel = response.model;
            usage = response.usage;
            usd = response.usage.cost.total;
            if (["error", "aborted", "length"].includes(response.stopReason)) {
              throw new Error(response.errorMessage ?? `Model stopped: ${response.stopReason}`);
            }
            const calls = response.content.filter(c => c.type === "toolCall");
            if (calls.length !== 1 || calls[0].name !== "submit_answers") throw new Error("Expected one submit_answers call");
            structureValid = Check(schema, calls[0].arguments);
            answers = (calls[0].arguments as { answers?: Record<string, Prediction> }).answers ?? {};
          }
        } catch (e) {
          error = e instanceof Error ? e.message : String(e);
        }
        const seconds = (performance.now() - began) / 1000;
        writeFileSync(`${dir}/${name}.raw.json`, JSON.stringify({ raw, error }, null, 2));
        const rows = batch.map(row => {
          const gold = labels[frozen.categories.indexOf(row.category)];
          return { id: row.id, sourceRow: row.sourceRow, gold, category: row.category,
            ...score(structureValid && !error ? answers[row.id] : undefined, gold, labels, arm !== "llm-labels") };
        });
        const record = { name, arm, batchIndex, repeat, seconds, usd, usage, actualModel, structureValid, error, rows };
        records.push(record);
        writeFileSync(`${dir}/results.json`, JSON.stringify(records, null, 2));
        console.log(`${name}: ${seconds.toFixed(2)}s, ${rows.filter(r => r.correct).length}/${rows.length} correct, structure=${structureValid}, $${usd?.toFixed(6) ?? "unknown"}${error ? ` ERROR: ${error}` : ""}`);
        if (error) throw new Error(`Stopped after failed call; evidence preserved in ${dir}`);
      }
    }
  }
  console.log("Completed 66 direct calls. Aggregate results separately; do not retune the frozen test.");
}

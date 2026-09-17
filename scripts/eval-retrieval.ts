// Opt-in live retrieval and autonomous end-to-end A/B evaluation on synthetic files.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createRetrievalFixture, retrievalCases } from "../evals/retrieval-fixture.ts";
import { createSearchTool } from "../src/search.ts";
import { retrieve } from "../src/retrieval.ts";
import { hash } from "./direct-core.ts";

if (!process.argv.includes("--run")) throw new Error("Pass --run for billable retrieval checks and 16 agent sessions.");
if (!process.env.TYPESAFE_API_KEY?.trim()) throw new Error("Set TYPESAFE_API_KEY.");
const project = process.cwd();
const dir = resolve("evals/results", `retrieval-${new Date().toISOString().replaceAll(":", "-")}`);
const workspace = `${dir}/workspace`;
mkdirSync(workspace, { recursive: true });
await createRetrievalFixture(workspace);
writeFileSync(`${dir}/manifest.json`, JSON.stringify({
  mainModel: "zai/glm-5.3-flash", thinking: "off", jevModel: "jev-1.13.0", repeats: 2,
  cases: retrievalCases, sourceHashes: Object.fromEntries([
    "src/search.ts", "src/retrieval.ts", "src/decisions.ts", "src/client.ts", "evals/retrieval-fixture.ts", "scripts/eval-retrieval.ts",
  ].map(path => [path, hash(readFileSync(path, "utf8"))])),
  protocol: "Synthetic fixture labels fixed before model calls. Two independent stages: direct lexical-vs-ranked recall, then autonomous same-prompt A/B (Jev search available, not forced). Read/grep/find/ls in both arms. No tool/question tuning after outcomes.",
}, null, 2));
console.log(`Results: ${dir}`);
const recall = (paths: string[], relevant: readonly string[]) => relevant.filter(p => paths.includes(p)).length / relevant.length;
const retrievalResults = [];
for (const item of retrievalCases) {
  const params = { query: item.query, terms: [...item.terms], scope: ".", candidate_limit: 64, top_k: 5, model: "jev-1.13.0" as const };
  const local = await retrieve(params, workspace);
  const began = performance.now();
  const result = await createSearchTool().execute("eval", params, undefined, undefined, { cwd: workspace } as ExtensionContext);
  if (result.content[0].type !== "text") throw new Error("Expected JSON result");
  const data = JSON.parse(result.content[0].text);
  const record = { case: item.id, seconds: (performance.now() - began) / 1000,
    candidateRecall: recall(local.candidates.map(c => c.path), item.relevant),
    lexicalRecallAt5: recall(local.candidates.slice(0, 5).map(c => c.path), item.relevant),
    rankedRecallAt5: recall(data.results.map((c: { path: string }) => c.path), item.relevant),
    usage: result.usage, data };
  retrievalResults.push(record);
  writeFileSync(`${dir}/retrieval.json`, JSON.stringify(retrievalResults, null, 2));
  console.log(`Retrieval ${item.id}: candidate=${record.candidateRecall}, lexical@5=${record.lexicalRecallAt5}, Jev@5=${record.rankedRecallAt5}`);
}

const sessions = [];
for (let repeat = 1; repeat <= 2; repeat++) {
  for (const item of retrievalCases) {
    for (const arm of repeat === 1 ? ["baseline", "jev"] : ["jev", "baseline"]) {
      const name = `${item.id}.${arm}.${repeat}`;
      const prompt = `Using only this project, answer the following question. Discover the relevant code/documents, verify the evidence with read, and cite paths and line numbers. Do not modify files or assume archived examples are current.\n\n${item.query}`;
      const args = ["--offline", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-session",
        ...(arm === "jev" ? ["-e", resolve(project, "index.ts")] : []),
        "--tools", `read,grep,find,ls${arm === "jev" ? ",jev_search" : ""}`,
        "--model", "zai/glm-5.3-flash", "--thinking", "off", "--mode", "json", "-p",
        "--append-system-prompt", "If invoking jev_search, use model jev-1.13.0. Stay within the current project directory.", prompt];
      const start = Date.now();
      const result = spawnSync("pi", args, { cwd: workspace, encoding: "utf8", timeout: 180000, maxBuffer: 20 * 1024 * 1024 });
      const seconds = (Date.now() - start) / 1000;
      writeFileSync(`${dir}/${name}.jsonl`, result.stdout ?? "");
      writeFileSync(`${dir}/${name}.stderr`, result.stderr ?? "");
      const events = (result.stdout ?? "").split("\n").filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return {}; } });
      const messages = events.filter(e => e.type === "message_end").map(e => e.message);
      const assistants = messages.filter(m => m.role === "assistant");
      const tools = messages.filter(m => m.role === "toolResult");
      const calls = assistants.flatMap(m => m.content.filter((c: { type: string }) => c.type === "toolCall"));
      const final = assistants.at(-1)?.content.filter((c: { type: string }) => c.type === "text").map((c: { text: string }) => c.text).join("\n") ?? "";
      const readPaths = calls.filter(c => c.name === "read").map(c => String(c.arguments.path).replace(workspace + "/", "").replace(/^\.\//, ""));
      const usage = (list: typeof messages) => list.reduce((n, m) => ({
        tokens: n.tokens + (m.usage?.totalTokens ?? 0),
        contextTokens: n.contextTokens + (m.usage?.input ?? 0) + (m.usage?.cacheRead ?? 0) + (m.usage?.cacheWrite ?? 0),
        usd: n.usd + (m.usage?.cost?.total ?? 0),
      }), { tokens: 0, contextTokens: 0, usd: 0 });
      const record = { name, case: item.id, arm, repeat, seconds, exit: result.status,
        mainUsage: usage(assistants), nestedUsage: usage(tools),
        toolTextBytes: tools.reduce((n, m) => n + Buffer.byteLength(m.content.filter((c: { type: string }) => c.type === "text").map((c: { text: string }) => c.text).join("\n")), 0),
        toolErrors: tools.filter(t => t.isError).length, jevCalls: calls.filter(c => c.name === "jev_search").length,
        toolCalls: calls.map(c => ({ name: c.name, arguments: c.arguments })), readRecall: recall(readPaths, item.relevant),
        factChecks: item.facts.map(pattern => ({ pattern, found: new RegExp(pattern, "i").test(final) })), final };
      sessions.push(record);
      writeFileSync(`${dir}/sessions.json`, JSON.stringify(sessions, null, 2));
      console.log(`${name}: ${seconds}s, Jev calls ${record.jevCalls}, read recall ${record.readRecall}, $${(record.mainUsage.usd + record.nestedUsage.usd).toFixed(6)}`);
      if (result.status !== 0 || !events.some(e => e.type === "agent_end") || assistants.some(m => ["error", "aborted"].includes(m.stopReason))) {
        throw new Error(`Session failed: ${name}. Evidence retained.`);
      }
    }
  }
}
console.log("Complete. Fact regexes are screening checks, not semantic correctness scores; review final answers and evidence manually.");

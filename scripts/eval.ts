// Opt-in development evals. Raw transcripts and summaries stay gitignored.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

if (!process.argv.includes("--run") || !process.env.MAIN_MODEL) {
  throw new Error("Billable evals: set MAIN_MODEL=provider/model and pass --run. Runs 42 development sessions; holdout is untouched.");
}
if (!process.env.TYPESAFE_API_KEY?.trim()) throw new Error("Set TYPESAFE_API_KEY first.");
const model = process.env.MAIN_MODEL;
const dir = resolve("evals/results", new Date().toISOString().replaceAll(":", "-"));
mkdirSync(dir, { recursive: true });
const cases = JSON.parse(readFileSync("evals/cases.json", "utf8")) as {
  id: string; split: string; mode: string; prompt: string;
}[];
const requested = process.env.EVAL_CASES?.split(",");
const selected = cases.filter(c => c.split === "development" && (!requested || requested.includes(c.id)));
if (!selected.length || requested?.some(id => !selected.some(c => c.id === id))) {
  throw new Error("EVAL_CASES must name existing development cases only.");
}
const files = ["index.ts", "src/tool.ts", "src/client.ts", "src/schema.ts", "evals/cases.json", "scripts/eval.ts", "package-lock.json"];
const hashes = Object.fromEntries(files.map(path => [path, createHash("sha256").update(readFileSync(path)).digest("hex")]));
writeFileSync(`${dir}/manifest.json`, JSON.stringify({
  startedAt: new Date().toISOString(), model, thinking: "off", typesafeModel: "jev-1.13.0",
  repeats: 3, split: "development", cases: selected.map(c => c.id), concurrency: 1, timeoutMs: 120000, hashes,
  piVersion: spawnSync("pi", ["--version"], { encoding: "utf8" }).stdout.trim(),
}, null, 2));
console.log(`Results: ${dir}`);
const summaries: object[] = [];
for (let repeat = 1; repeat <= 3; repeat++) {
  for (const item of selected) {
    const arms = item.mode === "guided" ? ["typesafe"]
      : repeat % 2 ? ["baseline", "typesafe"] : ["typesafe", "baseline"];
    for (const arm of arms) {
      const name = `${item.id}.${arm}.${repeat}`;
      const args = ["--offline", "--no-extensions", "--no-skills", "--no-prompt-templates",
        "--no-context-files", "--no-builtin-tools", "--no-session",
        ...(arm === "typesafe" ? ["-e", resolve("index.ts"), "--tools", "typesafe_evaluate"] : []),
        "--model", model, "--thinking", "off", "--mode", "json", "-p",
        "--append-system-prompt", "If invoking typesafe_evaluate, use model jev-1.13.0.", item.prompt];
      const started = Date.now();
      const result = spawnSync("pi", args, { encoding: "utf8", timeout: 120000, maxBuffer: 20 * 1024 * 1024 });
      const seconds = (Date.now() - started) / 1000;
      writeFileSync(`${dir}/${name}.jsonl`, result.stdout ?? "");
      writeFileSync(`${dir}/${name}.stderr`, result.stderr ?? "");
      // Read only final message events to avoid double-counting streaming updates,
      // tool_execution_end events, and the repeated messages in agent_end.
      const events = (result.stdout ?? "").split("\n").filter(Boolean).map(line => {
        try { return JSON.parse(line); } catch { return { type: "unparsed", line }; }
      });
      const messages = events.filter(e => e.type === "message_end").map(e => e.message);
      const assistants = messages.filter(m => m.role === "assistant");
      const tools = messages.filter(m => m.role === "toolResult");
      const calls = assistants.flatMap(m => m.content.filter((c: { type: string }) => c.type === "toolCall"));
      const sumUsage = (items: typeof messages) => items.reduce((sum, m) => ({
        input: sum.input + (m.usage?.input ?? 0),
        output: sum.output + (m.usage?.output ?? 0),
        cacheRead: sum.cacheRead + (m.usage?.cacheRead ?? 0),
        cacheWrite: sum.cacheWrite + (m.usage?.cacheWrite ?? 0),
        totalTokens: sum.totalTokens + (m.usage?.totalTokens ?? 0),
        usd: sum.usd + (m.usage?.cost?.total ?? 0),
      }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, usd: 0 });
      const errors = assistants.filter(m => ["error", "aborted"].includes(m.stopReason)).map(m => m.errorMessage ?? m.stopReason);
      const summary = {
        name, case: item.id, arm, repeat, seconds, exitCode: result.status,
        processError: result.error?.message, errors,
        hasAgentEnd: events.some(e => e.type === "agent_end"),
        assistantCalls: assistants.length, toolCalls: calls.length,
        toolErrors: tools.filter(t => t.isError).length,
        mainUsage: sumUsage(assistants), typesafeUsage: sumUsage(tools),
        actualMainModels: [...new Set(assistants.map(m => `${m.provider}/${m.model}`))],
        actualTypeSafeModels: [...new Set(tools.map(m => m.details?.model).filter(Boolean))],
        calls,
        results: tools.map(m => ({ isError: m.isError ?? false, details: m.details, content: m.content })),
        final: assistants.at(-1)?.content.filter((c: { type: string }) => c.type === "text").map((c: { text: string }) => c.text).join("\n") ?? "",
      };
      summaries.push(summary);
      writeFileSync(`${dir}/summary.json`, JSON.stringify(summaries, null, 2));
      console.log(`${name}: ${seconds}s, ${summary.toolCalls} tool calls, ${summary.toolErrors} tool errors, $${(summary.mainUsage.usd + summary.typesafeUsage.usd).toFixed(6)}`);
      if (result.status !== 0 || errors.length || !summary.hasAgentEnd) {
        throw new Error(`Stopped after infrastructure/model failure in ${name}; results preserved in ${dir}`);
      }
    }
  }
}
console.log(`Finished ${summaries.length} sessions. Semantic scoring is manual; see evals/README.md.`);

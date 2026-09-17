import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { clientConfig } from "../src/client.ts";
import { retrieve, SEARCH_LIMITS, clipUtf8 } from "../src/retrieval.ts";
import { createSearchTool } from "../src/search.ts";
import { createRetrievalFixture, retrievalCases } from "../evals/retrieval-fixture.ts";

async function workspace(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), "jev-search-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "src"));
  await mkdir(join(root, "docs"));
  await writeFile(join(root, "src", "refresh.ts"), "export function refreshToken() { return exchangeRefreshToken(); }\n");
  await writeFile(join(root, "docs", "refresh.md"), "# Token refresh\nA refresh token obtains a new access token.\n");
  return root;
}

test("retrieval includes code and documents with real paths and line ranges", async t => {
  const root = await workspace(t);
  const result = await retrieve({ query: "token refresh", scope: "." }, root);
  assert.deepEqual(new Set(result.candidates.map(c => c.path)), new Set(["src/refresh.ts", "docs/refresh.md"]));
  assert.ok(result.candidates.every(c => c.start_line === 1 && c.end_line >= 2));
});

test("scope and glob filters narrow search without overriding gitignore", async t => {
  const root = await workspace(t);
  await writeFile(join(root, ".gitignore"), "ignored.md\nignored/\n");
  await writeFile(join(root, "ignored.md"), "refresh token secret internal document");
  await mkdir(join(root, "ignored"));
  await writeFile(join(root, "ignored", "note.md"), "refresh token");
  const docs = await retrieve({ query: "refresh", scope: "docs", file_filters: ["**/*.md"] }, root);
  assert.deepEqual(docs.candidates.map(c => c.path), ["docs/refresh.md"]);
  const override = await retrieve({ query: "refresh", scope: ".", file_filters: ["ignored.md"] }, root);
  assert.equal(override.candidates.length, 0);
  const ignoredScope = await retrieve({ query: "refresh", scope: "ignored" }, root);
  assert.equal(ignoredScope.candidates.length, 0);
});

test("hidden, dependency, credential, binary and private-key files are not candidates", async t => {
  const root = await workspace(t);
  for (const name of [".env", "credentials.json", "client.key", "secrets.yaml", "unsupported.pdf"]) {
    await writeFile(join(root, name), "refresh token");
  }
  await mkdir(join(root, "node_modules"));
  await writeFile(join(root, "node_modules", "lib.ts"), "refresh token");
  await writeFile(join(root, "binary.txt"), Buffer.from("refresh\0token"));
  await writeFile(join(root, "leak.md"), "refresh token\n-----BEGIN PRIVATE KEY-----\nprivate");
  await writeFile(join(root, "key.md"), "refresh token sk-proj-" + "a".repeat(40));
  const result = await retrieve({ query: "refresh token", scope: ".", file_filters: ["**/*"] }, root);
  assert.deepEqual(new Set(result.candidates.map(c => c.path)), new Set(["src/refresh.ts", "docs/refresh.md"]));
  assert.equal(result.retrieval.skipped.binary, 1);
  assert.equal(result.retrieval.skipped.credential_like, 2);
});

test("search cannot escape the project or follow file/directory symlinks", async t => {
  const root = await workspace(t);
  const outside = await mkdtemp(join(tmpdir(), "jev-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, "outside.md"), "refresh token outside");
  await symlink(join(outside, "outside.md"), join(root, "linked.md"));
  await symlink(outside, join(root, "linked-dir"));
  await symlink(join(root, "docs"), join(root, "internal-link"));
  for (const scope of ["..", outside, "linked-dir", "internal-link"]) {
    await assert.rejects(retrieve({ query: "refresh", scope }, root), /inside|symlinks/);
  }
  const result = await retrieve({ query: "refresh", scope: "." }, root);
  assert.ok(result.candidates.every(c => !c.path.includes("linked")));
});

test("retrieval reports candidate truncation, bounded snippets and oversized exclusions", async t => {
  const root = await workspace(t);
  await writeFile(join(root, "too-large.md"), "x".repeat(SEARCH_LIMITS.fileBytes + 1));
  await writeFile(join(root, "long.md"), "refresh " + "界".repeat(2000));
  const result = await retrieve({ query: "refresh", scope: ".", candidate_limit: 1 }, root);
  assert.equal(result.candidates.length, 1);
  assert.ok(result.retrieval.limits_reached.includes("candidates"));
  assert.equal(result.retrieval.skipped.oversized, 1);
  const all = await retrieve({ query: "refresh", scope: "." }, root);
  assert.ok(all.candidates.every(c => Buffer.byteLength(c.snippet) <= SEARCH_LIMITS.snippetBytes));
  assert.ok(all.candidates.some(c => c.path === "long.md" && c.snippet_truncated));
  assert.equal(clipUtf8("界界", 4), "界");
});

test("empty results and cancelled retrieval make no API calls", async t => {
  const root = await workspace(t);
  let calls = 0;
  const tool = createSearchTool(() => { calls++; throw new Error("Unexpected API call"); });
  const ctx = { cwd: root } as ExtensionContext;
  const empty = await tool.execute("id", { query: "absentneedle", scope: "." }, undefined, undefined, ctx);
  assert.ok(empty.content[0].type === "text");
  assert.equal(JSON.parse(empty.content[0].text).results.length, 0);
  assert.equal(empty.usage, undefined);
  await assert.rejects(tool.execute("id", { query: "refresh", scope: "." }, AbortSignal.abort(), undefined, ctx));
  await assert.rejects(tool.execute("id", { query: "refresh", scope: ".", top_k: 10, candidate_limit: 1 }, undefined, undefined, ctx));
  assert.equal(calls, 0);
});

test("search ranks before returning snippets, preserves scores/usage, and does not leak omitted text", async t => {
  const root = await workspace(t);
  await writeFile(join(root, "docs", "decoy.md"), "refresh token OMITTED_SNIPPET_MARKER");
  let sent = "";
  const tool = createSearchTool(() => new TypeSafeClient({ ...clientConfig, apiKey: "test", fetch: async (_url, init) => {
    sent = String(init?.body);
    const body = JSON.parse(sent);
    const answers = Object.fromEntries(Object.entries(body.state.items).map(([key, item]: [string, any]) => {
      const score = item.text.includes("Path: src/refresh.ts") ? 2 : 0;
      return [key, { type: "score", score, confidence: 0.2, probabilities: { "0": score === 0 ? 1 : 0, "1": 0, "2": score === 2 ? 1 : 0 } }];
    }));
    return Response.json({ model: "jev-1.13.0", answers, usage: { input_tokens: 200, output_tokens: 30 } });
  } }));
  const result = await tool.execute("id", { query: "refresh token", scope: ".", top_k: 1 }, undefined, undefined, { cwd: root } as ExtensionContext);
  assert.ok(sent.includes("OMITTED_SNIPPET_MARKER"));
  assert.ok(result.content[0].type === "text");
  const details = JSON.parse(result.content[0].text);
  assert.equal(details.results[0].path, "src/refresh.ts");
  assert.equal(details.results.length, 1);
  assert.equal(details.omitted_count, 2);
  assert.ok(!JSON.stringify(result).includes("OMITTED_SNIPPET_MARKER"));
  assert.equal(result.usage?.totalTokens, 230);
  assert.equal(details.results[0].confidence, 0.2);
});

test("JSON escaping cannot expand returned snippets beyond the context budget", async t => {
  const root = await workspace(t);
  let folder = root;
  for (let i = 0; i < 4; i++) { folder = join(folder, '"'.repeat(190)); await mkdir(folder); }
  for (let i = 0; i < 10; i++) await writeFile(join(folder, `${i}${'"'.repeat(180)}.txt`), "needle" + "\t".repeat(1990));
  const tool = createSearchTool(() => new TypeSafeClient({ ...clientConfig, apiKey: "test", fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    return Response.json({ model: "jev-1.13.0", answers: Object.fromEntries(Object.keys(body.questions).map(key => [key, {
      type: "score", score: 1, confidence: 1, probabilities: { "0": 0, "1": 1, "2": 0 },
    }])), usage: { input_tokens: 10, output_tokens: 10 } });
  } }));
  const result = await tool.execute("id", { query: "needle", scope: ".", top_k: 10 }, undefined, undefined, { cwd: root } as ExtensionContext);
  assert.ok(result.content[0].type === "text");
  assert.ok(Buffer.byteLength(result.content[0].text) <= 48_000);
  assert.ok(JSON.parse(result.content[0].text).results.some((r: { snippet_truncated: boolean }) => r.snippet_truncated));
});

test("file and per-file chunk limits are explicit rather than silently exhaustive", async t => {
  const root = await workspace(t);
  await mkdir(join(root, "many"));
  await Promise.all(Array.from({ length: 505 }, (_, i) => writeFile(join(root, "many", `${i}.md`), "needle")));
  const capped = await retrieve({ query: "needle", scope: "many" }, root);
  assert.equal(capped.retrieval.examined_files, 500);
  assert.ok(capped.retrieval.limits_reached.includes("files"));
  await writeFile(join(root, "docs", "long-match.md"), Array(60).fill("needle").join("\n"));
  const chunks = await retrieve({ query: "needle", scope: "docs" }, root);
  assert.equal(chunks.retrieval.discarded_matching_chunks, 2);
  assert.ok(chunks.retrieval.limits_reached.includes("chunks_per_file"));
});

test("frozen workflow fixtures retrieve every labeled relevant file in the expanded candidate pool", async t => {
  const root = await workspace(t);
  await createRetrievalFixture(root);
  for (const item of retrievalCases) {
    const result = await retrieve({ query: item.query, terms: [...item.terms], scope: ".", candidate_limit: 64 }, root);
    for (const path of item.relevant) assert.ok(result.candidates.some(c => c.path === path), `${item.id}: missing ${path}`);
  }
});

test("explicit literal terms are not interpreted as shell commands or regex", async t => {
  const root = await workspace(t);
  await writeFile(join(root, "docs", "literal.md"), "Text has literal [a-z] pattern\n");
  const found = await retrieve({ query: "pattern", terms: ["[a-z]"], scope: "." }, root);
  assert.deepEqual(found.candidates.map(c => c.path), ["docs/literal.md"]);
  await assert.rejects(retrieve({ query: "the and", scope: "." }, root), /No lexical/);
});

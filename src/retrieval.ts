import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { minimatch } from "minimatch";

export const SEARCH_LIMITS = { files: 500, fileBytes: 256 * 1024, totalBytes: 8 * 1024 * 1024, listingBytes: 2 * 1024 * 1024, snippetBytes: 2000 };
const TEXT_EXTENSIONS = new Set(".ts .tsx .js .jsx .mjs .cjs .json .jsonc .py .rs .go .java .kt .kts .c .h .cc .cpp .hpp .cs .rb .php .swift .sh .bash .zsh .fish .sql .graphql .proto .css .scss .html .vue .svelte .md .mdx .txt .rst .adoc .yaml .yml .toml .ini .cfg .xml .csv".split(" "));
const EXCLUDED_DIRS = new Set(["node_modules", "vendor", "dist", "build", "coverage", "secrets", "credentials"]);
const STOP_WORDS = new Set("a an and are as at be by can code do does file files find for from how i in is it me of on or that the this to use used uses using what when where which with would".split(" "));

export type SearchOptions = { query: string; scope: string; file_filters?: string[]; terms?: string[]; candidate_limit?: number };
export type Candidate = { id: string; path: string; start_line: number; end_line: number; snippet: string; snippet_truncated: boolean; lexical_score: number };
function within(root: string, path: string) {
  const rel = relative(root, path);
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}
export function searchTerms(query: string) {
  return [...new Set(query.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [])]
    .filter(t => t.length >= 2 && !STOP_WORDS.has(t)).slice(0, 12);
}
export function safeTextPath(path: string) {
  const parts = path.replaceAll("\\", "/").split("/");
  if (parts.some(p => p.startsWith(".") || EXCLUDED_DIRS.has(p.toLowerCase()))) return false;
  const name = parts.at(-1)!;
  if (/(?:^|[._-])(?:secret|secrets|credential|credentials)(?:$|[._-])/i.test(name) || /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$)/i.test(name)) return false;
  if (/\.(?:pem|key|p12|pfx|keystore|log|sqlite|db)$/i.test(name)) return false;
  return TEXT_EXTENSIONS.has(extname(name).toLowerCase()) || /^(?:readme|license|copying|dockerfile|makefile|justfile)$/i.test(name);
}
function credentialLike(text: string) {
  return /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}|\bgh[pousr]_[A-Za-z0-9]{30,}|\bAKIA[0-9A-Z]{16}\b/.test(text);
}
export function clipUtf8(text: string, bytes: number) {
  const buffer = Buffer.from(text, "utf8");
  return buffer.length <= bytes ? text : buffer.subarray(0, bytes).toString("utf8").replace(/\uFFFD$/, "");
}

// No shell and no caller-supplied rg flags. List from project root, then filter
// scope locally so an explicit ignored directory cannot override ignore rules.
function listFiles(root: string, signal?: AbortSignal): Promise<string[]> {
  signal?.throwIfAborted();
  return new Promise((accept, reject) => {
    const args = ["--no-config", "--files", "--null", "--no-require-git"];
    for (const dir of EXCLUDED_DIRS) args.push("--glob", `!**/${dir}/**`);
    const child = spawn("rg", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failure: Error | undefined;
    const stop = (error: Error) => { failure ??= error; child.kill("SIGKILL"); };
    const abort = () => stop(new Error("Local search cancelled."));
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => stop(new Error("Local file listing exceeded 10 seconds; start Pi in a smaller project directory.")), 10_000);
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > SEARCH_LIMITS.listingBytes) stop(new Error("Project file listing exceeded 2 MB; start Pi in a smaller project directory."));
      else chunks.push(chunk);
    });
    // Drain, but do not echo arbitrary filenames or environment-dependent stderr.
    child.stderr.resume();
    child.on("error", () => { failure = new Error("Could not start ripgrep (rg). Install ripgrep and ensure it is on PATH."); });
    child.on("close", code => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else if (code !== 0 && code !== 1) reject(new Error("ripgrep could not list this project."));
      else accept(Buffer.concat(chunks).toString("utf8").split("\0").filter(Boolean));
    });
    if (signal?.aborted) abort();
  });
}

export async function retrieve(options: SearchOptions, cwd: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const root = await realpath(cwd);
  const requestedScope = resolve(root, options.scope.replace(/^@/, ""));
  if (!within(root, requestedScope)) throw new Error("Search scope must stay inside the current project directory.");
  const scope = await realpath(requestedScope);
  if (!within(root, scope) || scope !== requestedScope) throw new Error("Search scope must not traverse symlinks.");
  if (!(await stat(scope)).isDirectory()) throw new Error("Search scope must be a directory.");
  const terms = options.terms?.map(t => t.trim().toLowerCase()).filter(Boolean) ?? searchTerms(options.query);
  if (!terms.length) throw new Error("No lexical search terms found. Supply explicit terms or a more specific query.");
  const listed = await listFiles(root, signal);
  const eligible = listed.filter(path => {
    const absolute = resolve(root, path);
    return Buffer.byteLength(path, "utf8") <= 1024 && within(root, absolute) && within(scope, absolute) && safeTextPath(path) &&
      (!options.file_filters?.length || options.file_filters.some(pattern => minimatch(path.replaceAll("\\", "/"), pattern, {
        matchBase: true, nonegate: true, nocomment: true, dot: false,
      })));
  });
  const lexicalScore = (text: string, path: string) => {
    const lower = text.toLowerCase();
    return terms.reduce((n, term) => n + Number(lower.includes(term)) * 3 + Number(path.toLowerCase().includes(term)) * 2, 0);
  };
  eligible.sort((a, b) => lexicalScore("", b) - lexicalScore("", a) || a.localeCompare(b));
  const metadata = {
    scope: relative(root, scope).replaceAll("\\", "/") || ".", terms,
    listed_files: listed.length, eligible_files: eligible.length, examined_files: 0, read_bytes: 0,
    skipped: { inaccessible_or_symlink: 0, oversized: 0, binary: 0, credential_like: 0 },
    discarded_matching_chunks: 0,
    limits_reached: [] as string[],
  };
  if (eligible.length > SEARCH_LIMITS.files) metadata.limits_reached.push("files");
  const pool: Omit<Candidate, "id">[] = [];
  for (const path of eligible.slice(0, SEARCH_LIMITS.files)) {
    signal?.throwIfAborted();
    const absolute = resolve(root, path);
    metadata.examined_files++;
    let content: string;
    try {
      if (await realpath(absolute) !== absolute) { metadata.skipped.inaccessible_or_symlink++; continue; }
      const file = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const info = await file.stat();
        if (!info.isFile()) { metadata.skipped.inaccessible_or_symlink++; continue; }
        if (info.size > SEARCH_LIMITS.fileBytes) { metadata.skipped.oversized++; continue; }
        if (metadata.read_bytes + info.size > SEARCH_LIMITS.totalBytes) { metadata.limits_reached.push("total_bytes"); break; }
        const buffer = Buffer.alloc(Math.min(SEARCH_LIMITS.fileBytes + 1, SEARCH_LIMITS.totalBytes - metadata.read_bytes));
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        metadata.read_bytes += bytesRead;
        if (bytesRead > SEARCH_LIMITS.fileBytes) { metadata.skipped.oversized++; continue; }
        const data = buffer.subarray(0, bytesRead);
        if (data.includes(0)) { metadata.skipped.binary++; continue; }
        content = data.toString("utf8");
      } finally { await file.close(); }
    } catch { metadata.skipped.inaccessible_or_symlink++; continue; }
    if (credentialLike(content)) { metadata.skipped.credential_like++; continue; }
    const lines = content.split(/\r?\n/);
    const chunks: Omit<Candidate, "id">[] = [];
    for (let start = 0; start < lines.length; start += 12) {
      const text = lines.slice(start, start + 12).join("\n");
      const snippet = clipUtf8(text, SEARCH_LIMITS.snippetBytes);
      const score = lexicalScore(snippet, path);
      if (score > 0) chunks.push({ path: path.replaceAll("\\", "/"), start_line: start + 1,
        end_line: Math.min(start + 12, lines.length), snippet, snippet_truncated: text !== snippet, lexical_score: score });
    }
    // Prevent a long file from monopolizing the lexical shortlist.
    chunks.sort((a, b) => b.lexical_score - a.lexical_score || a.start_line - b.start_line);
    if (chunks.length > 3) {
      metadata.discarded_matching_chunks += chunks.length - 3;
      if (!metadata.limits_reached.includes("chunks_per_file")) metadata.limits_reached.push("chunks_per_file");
    }
    pool.push(...chunks.slice(0, 3));
  }
  signal?.throwIfAborted();
  pool.sort((a, b) => b.lexical_score - a.lexical_score || a.path.localeCompare(b.path) || a.start_line - b.start_line);
  const limit = options.candidate_limit ?? 40;
  if (pool.length > limit) metadata.limits_reached.push("candidates");
  return { candidates: pool.slice(0, limit).map((c, i) => ({ id: `hit_${i}`, ...c })),
    retrieval: { ...metadata, matching_chunks: pool.length, candidate_count: Math.min(pool.length, limit),
      limits: SEARCH_LIMITS, max_chunks_per_file: 3,
      warning: "Lexical retrieval can miss synonyms or files outside the candidate pool. Ignore rules, file filters and safety exclusions apply. A shortlist is not an exhaustive search." } };
}

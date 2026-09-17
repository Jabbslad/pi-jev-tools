import { Type, type Static } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import { defaultClient, type ClientFactory } from "./client.ts";
import { modelParameter, rankItems, reviewParameter, reviewPolicy, RELEVANCE_RUBRIC, selectRanked } from "./decisions.ts";
import { clipUtf8, retrieve } from "./retrieval.ts";

export const searchParameters = Type.Object({
  query: Type.String({ minLength: 1, maxLength: 1000, description: "Information need for relevance ranking. Use specific domain terms." }),
  scope: Type.String({ minLength: 1, maxLength: 512, description: "Required directory inside Pi's current project, e.g. src, docs or .; no symlinks or outside paths." }),
  file_filters: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { minItems: 1, maxItems: 10,
    description: "Include globs relative to the project root, e.g. **/*.ts, **/*.md. Applied AFTER ignore rules; cannot override ignored/hidden/sensitive files. Basename globs such as *.py are supported.",
  })),
  terms: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 80 }), { minItems: 1, maxItems: 12,
    description: "Optional literal OR terms for local retrieval, e.g. [refresh, token]. Otherwise terms are extracted from query. No regex, semantic index or automatic synonym expansion.",
  })),
  candidate_limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 64, description: "Maximum local candidates to rank; default 40. Increasing it may improve recall but sends more snippets to TypeSafe." })),
  top_k: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, description: "Maximum snippets returned to Pi, default 5. No score/confidence filtering; cutoff ties and omitted count are reported." })),
  review_below_confidence: reviewParameter,
  model: modelParameter,
}, { additionalProperties: false });
export type SearchParams = Static<typeof searchParameters>;

export function createSearchTool(createClient: ClientFactory = defaultClient) {
  return defineTool({
    name: "jev_search", label: "Jev Search", parameters: searchParameters,
    description: "Retrieve and rank local code/text-document snippets before the main model reads them. Requires ripgrep. Lexical candidate retrieval is local; only the candidate snippets, relative paths and query go to TypeSafe. Scope is limited to the current project. Respects ignore rules, skips hidden/ignored files, symlinks, common credential files and some credential-like contents; these checks are NOT comprehensive secret detection or a sandbox. Use only where external processing is allowed. Fixed code-built Score questions rank candidates; returns a bounded shortlist with source line ranges, distributions, confidence, cutoff information and retrieval limits. Scores are advisory, not proof. Useful for broad semantic lookup with many lexical matches; use ordinary search for exact matches or exhaustive coverage. Retrieval can miss synonyms; empty output or low scores never prove absence. Increase candidate_limit/change terms/scope when recall matters. PDF/binary documents are unsupported.",
    promptSnippet: "Search scoped local code/documents and send only a Jev-ranked shortlist to the agent.",
    async execute(_id, params, signal, _onUpdate, ctx) {
      if (!Check(searchParameters, params)) throw new Error("Invalid jev_search arguments.");
      if ((params.top_k ?? 5) > (params.candidate_limit ?? 40)) throw new Error("top_k must not exceed candidate_limit.");
      const { candidates, retrieval } = await retrieve(params, ctx.cwd, signal);
      if (!candidates.length) {
        const data = { results: [], omitted_count: 0, boundary: null, models: [], batches: 0, retrieval,
          warning: "No lexical candidates found. This does not establish absence: try other terms, filters or scope. No TypeSafe call was made." };
        return { content: [{ type: "text" as const, text: JSON.stringify(data) }], details: data };
      }
      const { ranked, usage, ...meta } = await rankItems({ query: params.query,
        candidates: candidates.map(c => ({ id: c.id, text: `Path: ${c.path}\nLines: ${c.start_line}-${c.end_line}\n${c.snippet}` })),
        model: params.model, review_below_confidence: params.review_below_confidence,
      }, signal, createClient);
      const selected = selectRanked(ranked, params.top_k ?? 5);
      const results = selected.results.map(rating => ({ ...candidates.find(c => c.id === rating.id)!, ...rating }));
      const data = { ...meta, ...selected, results, retrieval, rubric: RELEVANCE_RUBRIC,
        review_policy: reviewPolicy(params.review_below_confidence),
        context_bytes: { candidate_snippets: candidates.reduce((n, c) => n + Buffer.byteLength(c.snippet), 0),
          returned_snippets: results.reduce((n, c) => n + Buffer.byteLength(c.snippet), 0) },
        warning: "Only a shortlist is shown, not exhaustive evidence. Read cited files to verify. Snippet-byte reduction is not a measured token/cost saving." };
      let text = JSON.stringify(data);
      if (Buffer.byteLength(text, "utf8") > 48_000) {
        data.warning += " Returned snippets were further shortened to fit the context-output budget.";
        do {
          data.results = data.results.map(c => ({ ...c, snippet: clipUtf8(c.snippet, Math.floor(Buffer.byteLength(c.snippet) / 2)), snippet_truncated: true }));
          data.context_bytes.returned_snippets = data.results.reduce((n, c) => n + Buffer.byteLength(c.snippet), 0);
          text = JSON.stringify(data);
        } while (Buffer.byteLength(text, "utf8") > 48_000 && data.results.some(c => c.snippet.length));
        if (Buffer.byteLength(text, "utf8") > 48_000) throw new Error("Search result metadata exceeds the output budget; reduce top_k.");
      }
      return { content: [{ type: "text" as const, text }],
        details: { ...data, all_ratings: ranked.map(r => ({ ...r, path: candidates.find(c => c.id === r.id)!.path })) }, usage };
    },
  });
}

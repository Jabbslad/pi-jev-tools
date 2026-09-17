# pi-jev-tools

A Pi extension exposing **`jev_rank`**, **`jev_classify`**, **`jev_search`**, and the advanced **`typesafe_evaluate`** tool, powered by [TypeSafe](https://docs.typesafe.ai/introduction.md).

This is a **tool extension, not a main-model provider**. Keep your normal coding model selected. Jev supplies narrow judgments; the coding model explains results, writes code, and runs tests. No skill is required for basic use: tool/schema descriptions carry essential usage guidance, with additional active-tool prompt guidelines under Pi's default system prompt. A custom `SYSTEM.md` suppresses Pi's default guidelines section, so essential instructions must not live there alone. Guidance does not guarantee correct tool use.

## Try it

Requires Node.js 22+ and Pi. `jev_search` also requires `rg` (ripgrep) on PATH. Tested against `@earendil-works/pi-coding-agent` **0.85.1**; older Pi releases using the `@mariozechner` package names are not supported by this version.

```sh
npm ci
# Set TYPESAFE_API_KEY in your shell or secret manager; don't commit it.
export TYPESAFE_API_KEY='your-key'
pi -e ./index.ts
```

The extension does not load `.env` files. Missing credentials do not prevent startup; they produce an error when an API evaluation is needed.

For persistent local installation, run `pi install /absolute/path/to/pi-jev-tools`. This changes your Pi package settings; it is not required to try the extension. No global configuration is changed by this project's tests.

Example prompt:

> Use TypeSafe to classify these tickets as billing, technical, or other, and check which ones explicitly request a refund. Batch the independent questions into one call.

## Specialized tools

These tools construct explicitly targeted, independent questions in code instead of asking the coding model to invent Jev schemas. They validate IDs and responses, and batch at most 12 questions / 24 KB of serialized request data. All batches are planned before network calls. This byte budget is conservative, not a Jev tokenizer.

### `jev_rank`

```json
{
  "query": "Which candidate explains token refresh?",
  "candidates": [
    { "id": "auth", "text": "refreshAccessToken exchanges the refresh token for an access token." },
    { "id": "theme", "text": "The navigation bar background is blue." }
  ],
  "top_k": 2
}
```

Ranks up to 64 supplied candidates using a fixed three-level relevance rubric: unrelated, supporting, directly relevant. Returns weighted scores (0–2), distributions and confidence separately. `top_k` defaults to 5, maximum 20. Stable ties preserve original order; omitted counts and cutoff ties are reported. Full ratings, without duplicated candidate text, remain in tool details. This tool does **not** save context already spent reading the candidates.

### `jev_classify`

```json
{
  "items": [{ "id": "ticket", "text": "I was charged twice; please refund the duplicate." }],
  "categories": {
    "billing": "Charges, invoices, refunds",
    "technical": "Software malfunctions"
  }
}
```

Classifies up to 32 items into 2–128 named categories. Names are mapped safely to internal keys, then restored. The reserved `__unclear__` option is added for insufficient evidence/no fitting category and always receives a review flag, even with high confidence. Category names are limited to 48 UTF-8 bytes, definitions to 500 characters; large definitions may exceed the per-request byte budget. Complete distributions remain in tool details. If the JSON text exceeds 48 KB, the model instead receives explicitly labeled selected probabilities; use smaller item batches for full distributions in context.

Both tools accept optional `model` and `review_below_confidence`. Thresholds are caller-supplied and **unvalidated**, not calibrated defaults or permission to act. Scores/confidence never authorize actions, and low-confidence or zero-score candidates are not silently discarded before top-k selection. Item/candidate text is limited to 6,000 characters.

### `jev_search`: local code and text documents

```json
{
  "query": "Where do concurrent token refresh requests get deduplicated?",
  "scope": ".",
  "file_filters": ["src/**/*.ts", "docs/**/*.md"],
  "terms": ["refresh", "token"],
  "top_k": 5
}
```

Retrieves locally, sends a bounded snippet pool to Jev, and returns ranked snippets with paths/line ranges **before the main model sees the full pool**. `scope` is a required directory inside Pi's current working directory; filters are optional include globs applied after ignore rules. This covers common source formats and plain-text documents such as Markdown, reStructuredText and text; not PDF/Office extraction or semantic indexing.

- Uses literal OR terms (optional explicit `terms`, otherwise query words), weighted lexical preselection, then Jev ranking. Ordinary grep/find remain better for exact symbols and paths.
- Respects ripgrep ignore rules, skips hidden/generated/dependency paths and common credential files, and refuses scopes that escape the project or traverse symlinks. Opens files without following final-component symlinks, checks real paths, skips NUL-containing files and some credential-like content. **Not a comprehensive secret detector or filesystem sandbox**; do not use on untrusted concurrently modified trees or files disallowed from external processing.
- No shell execution or writes. Requires `rg`; a missing executable is an error, not an unsafe fallback.
- Limits: 500 examined files, 256 KB/file, 8 MB total reads, 2 MB project file listing and 10-second listing deadline; three matching chunks/file, 12 lines and 2,000 UTF-8 bytes/snippet. Additional output clipping keeps JSON text within 48 KB and is reported.
- Candidate pool defaults to 40, maximum 64; top-k defaults to 5, maximum 10. No API call when the pool is empty. Full nonreturned ratings/paths are in tool details, not omitted snippet contents.
- Reports caps, truncation, cutoff ties and snippet byte counts. These are **not token-savings estimates**. Lexical retrieval, file limits and chunking can miss relevant evidence; narrow scope, adjust terms/filters, increase candidate/top-k limits or use normal search. A missing result is never proof of absence.

Example prompt: “Use jev_search under src and docs to locate the refresh guard, then read the source to verify it.” Use `scope: "."` with include filters when searching multiple directories.

## Advanced: `typesafe_evaluate`

```json
{
  "state": {
    "ticket": "I was charged twice. Please refund the duplicate payment."
  },
  "questions": {
    "category": {
      "type": "choice",
      "instructions": "What is the ticket about?",
      "criteria": {
        "billing": "Charges, invoices, and refunds",
        "technical": "Software malfunctions",
        "other": "Something else or insufficient information"
      }
    },
    "urgency": {
      "type": "score",
      "instructions": "How explicitly urgent is the request?",
      "criteria": ["No urgency stated", "Some urgency", "Immediate deadline"]
    },
    "refund": {
      "type": "noul",
      "instructions": "Is a refund explicitly requested?"
    }
  },
  "model": "jev-1.13.0"
}
```

- **Choice:** at least two named options, with string descriptions or `null`. Returns `choice`, `probabilities`, and `confidence`.
- **Score:** at least two ordered, nonempty string descriptions. Returns a weighted `score` between 0 and levels−1 (possibly fractional), `legend`, `probabilities`, and `confidence`. Not an exact numeric measurement.
- **Noul:** yes/no question; optional `criteria.true` / `criteria.false` descriptions. Returns `noul`, the probability of yes, not a boolean. No separate confidence field.
- **State:** string, JSON object, or JSON array. Only supplied state/questions are sent by this generic tool; it does not read files or automatically attach the conversation.
- **Instructions:** nonempty strings in v1. The underlying API has additional structured-instruction options that this tool intentionally does not expose.
- **Model:** `jev-latest` (default), `jev-preview`, or pinned `jev-1.13.0`. Pin for reproducible evaluations. Aliases can change.

All questions share the state but are evaluated independently. Answers preserve the question IDs; the IDs themselves do not communicate instructions to Jev. Dependent questions require sequential calls or independent speculative evaluations followed by selection in code.

The full API response is returned as JSON text to the main model and preserved in tool details, including answer distributions, model, and token usage. The tool does not automatically execute actions based on an answer. Normal Pi tool rendering is used; no custom UI or command is installed.

## Reliability, cost, and privacy

- Uses the official `@typesafe-ai/sdk`, with a 10-second per-attempt timeout, at most two retries after the initial attempt, and a **30-second total API-phase deadline** across batches, including retry delays. SDK backoff honors retry headers within that deadline.
- Pi cancellation aborts requests and retry waits. Errors are thrown so Pi marks the tool call as failed. HTTP error bodies are not echoed, because they may contain private state.
- API endpoint is fixed to `https://api.typesafe.ai`. SDK body logging is disabled. SDK environment overrides `TYPESAFE_BASE_URL`, `TYPESAFE_DEFAULT_MODEL`, and `TYPESAFE_LOG_LEVEL` are intentionally ignored.
- Successful calls report nested token usage and estimated USD cost to Pi. Estimate: **$0.042 per million input tokens; output free**, the documented Jev 1.13 price when implemented. Alias price changes can make this estimate stale; it is not a billing ledger and does not account for potentially billed failed/retried requests.
- Data goes to an external service. Exclude secrets and unrelated context. Successful results appear in the conversation; Pi can persist tool arguments/results in session files. Disabling SDK logging does not disable Pi's session history.
- Documented context limits: 64k tokens across state and questions, and 32k for state plus the longest question. This extension has no Jev tokenizer, so the service enforces these limits; oversized requests may fail rather than being silently truncated.
- No images, free-text generation, arbitrary tool calling, or exact arithmetic. Confidence is not proof of correctness. Jev can be influenced by adversarial state; never use it alone as a security boundary or authorization for destructive actions.
- Sending search results the main model already read does **not** recover those input-token costs. `jev_search` retrieves and ranks internally, but actual end-to-end savings still depend on tool adoption, query quality, verification steps and schema overhead.

## Verification

```sh
npm test             # Local tests with mocked transport; no API key needed
npm run typecheck
npm run test:live    # Opt-in real TypeSafe request; requires key and incurs API usage
```

Tests cover Pi's actual extension loader, mixed batches, code-built targeted questions, uncertainty/ties, response validation, bounded outputs, code/document retrieval, ignore/secret/symlink protections, credentials, cancellation, deadlines, bounded retries, safe HTTP errors, and usage reporting. The live smoke test checks the response shape, not model quality.

See [evals/README.md](evals/README.md) for **20 draft synthetic agent-evaluation cases**, an opt-in runner, and an A/B protocol. [Development results](evals/DEVELOPMENT-RESULTS.md) cover 42 initial sessions and 15 targeted retests using `zai/glm-5.3-flash`. Clearer guidance improved some calls, but invalid calls and interpretation errors remain; the small classification A/B showed no quality gain and higher cost/latency. The original agent holdout remains unrun. Neither unit tests nor the successful live smoke test demonstrates that the tool improves an agent.

A separate [direct BANKING77 pilot](evals/DIRECT-RESULTS.md) used 77 independently labeled examples, fixed questions, and 66 direct calls. Jev was much faster than GLM and structurally reliable, with similar label accuracy; the small sample did not establish superior calibration. This is evidence about the decision API, not a proven improvement to Pi. Reproduction instructions and attribution are in [DIRECT-PROTOCOL.md](evals/DIRECT-PROTOCOL.md).

A new [retrieval workflow pilot](evals/RETRIEVAL-RESULTS.md) covers four fixed synthetic code/document tasks and 16 full Pi sessions. Direct top-five relevant-file recall improved from 50% lexical to 100% ranked, but autonomous Pi used Jev in only 1/8 enabled sessions. Core answer facts were correct in both arms; cost/context increased and mean elapsed time was essentially unchanged. This does **not** establish an out-of-the-box workflow benefit. [Protocol and runner](evals/RETRIEVAL-PROTOCOL.md) are available from a source checkout.

## References

- [HTTP API](https://docs.typesafe.ai/api.md)
- [JavaScript SDK](https://docs.typesafe.ai/sdk/javascript.md)
- [Models and pricing](https://docs.typesafe.ai/models.md)
- [Known limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13.md)
- [Confidence](https://docs.typesafe.ai/confidence.md)

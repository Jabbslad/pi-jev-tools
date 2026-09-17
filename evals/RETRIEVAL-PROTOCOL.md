# Retrieval workflow pilot

Frozen before running the new tools against Jev or the main model. This is a **synthetic development diagnostic**, not an independently sourced production benchmark. Fixtures and labels are authored from source code/documents by the implementation author, not generated from model answers.

## Fixture

`retrieval-fixture.ts` creates an isolated project with eight current source/doc files and 36 archived, keyword-heavy distractor documents. Four questions cover retry policy, concurrent token refresh, rollback procedure, and port configuration. Each has two predeclared relevant files and factual checks derived from their contents. Expectations are outside the agent's workspace.

Only this synthetic project is sent to models. No user repository data or secrets are used. The fixture does not measure adversarial prompt injection or secret-detection completeness; separate unit tests cover basic path and exclusion protections.

## Stage 1: retrieval and ranking

For each question, retrieve up to 64 candidates using the fixed literal terms in the fixture and return top five after Jev scoring, pinned to `jev-1.13.0`. Measure relevant-file recall in the candidate pool, lexical top five, and Jev top five; also record the actual snippets, model scores/distributions, bytes and usage. This stage isolates whether ranking loses or improves known relevant files; one run per case.

This is not an exact baseline for the agent stage: agents choose their own query/terms and default candidate limits. Increasing the fixed candidate limit to 64 tests whether relevant information exists in the retrievable pool, not whether every autonomous query will retrieve it.

## Stage 2: end-to-end autonomous A/B

Four identical user questions, two repetitions, two arms: **16 fresh Pi sessions**.

- Main model: `zai/glm-5.3-flash`; requested thinking off; same local custom system prompt and instructions in both arms.
- Baseline tools: read, grep, find, ls.
- Extension arm: the same tools plus jev_search; Jev is available but **not forced**.
- Pin Jev to 1.13.0 via identical appended instruction in both arms. No other extensions/skills/context files or write/exec tools. Stay in the fixture directory.
- Ask for source-backed answers with path/line citations, verified with read. Warn both arms that archives are not current policy.
- Sequential execution, reverse arm order for repetition two, 180-second session deadline. Stop and retain evidence on fatal process/model failure. No tuning/replacement based on outcomes.

Metrics:
- Actual tool calls and validation failures, particularly whether the model uses Jev at all.
- Recall of labeled relevant files explicitly opened with read. This is **read recall**, not a claim that unseen files cannot have been inferred from other evidence.
- Total main-model context tokens including cache reads/writes, full model tokens, nested Jev usage/cost, wall-clock session time, and tool-result text bytes.
- Regex fact checks are only screening aids. Review final answers for correct facts, precedence/conditions, current versus archived authority, and citations. Do not label regex matches as task success automatically.

A reduction in returned snippet bytes is not automatically a token/cost saving. Judge the whole session, including the additional tool schema and orchestration. This comparison enables only jev_search, not all four extension tools; loading all of them adds schema overhead not measured here. Small sample, synthetic distractors, cache behavior and one main model limit generalization.

## Run

```sh
# Requires rg, TYPESAFE_API_KEY and configured main-model credentials.
node --import tsx scripts/eval-retrieval.ts --run
```

The runner writes a source-hash manifest, retrieval outputs, raw event transcripts and session summaries under gitignored `evals/results/retrieval-<timestamp>/`. Neither this nor other live evals run during `npm test`.

# Retrieval workflow pilot results

## Bottom line

The new search tool successfully kept relevant code/documents in its shortlist while hiding most candidate text from the main model. **An autonomous Pi workflow benefit was not demonstrated.** Merely making the tool available did not cause consistent adoption, lower whole-session cost, or better core answers.

These are four synthetic development tasks, not independent production evidence. The current/archived distinctions are deliberately explicit; fixture code is illustrative rather than a runnable application. Do not generalize the recall numbers to real repositories.

## Direct retrieval and ranking

Pinned Jev 1.13.0; fixed lexical terms; candidate limit 64; top five. Two relevant files per task, declared before model calls.

| Task | Candidate recall | Lexical recall@5 | Jev recall@5 | Search elapsed |
|---|---:|---:|---:|---:|
| Retry policy | 100% | 0% | 100% | 1.981 s |
| Token refresh | 100% | 50% | 100% | 1.395 s |
| Rollback docs | 100% | 100% | 100% | 2.172 s |
| Port precedence | 100% | 50% | 100% | 1.982 s |

Overall: **4/8 relevant files in lexical top-five lists versus 8/8 after ranking**. Four API batches per search, 16 total. Estimated Jev cost: **$0.002954**. Each search returned approximately 5.6–5.9 KB of snippet content from a 62.8–64.0 KB pool (~91% less snippet content). This excludes response metadata and is not a measured token/cost saving against ordinary Pi search.

Live standalone ranking also placed a token-refresh description above an unrelated CSS candidate. Live classification selected billing for a duplicate-charge ticket and `__unclear__` for a vague item. These are smoke checks, not classification-accuracy estimates.

## Autonomous end-to-end comparison

16 fresh sessions: four tasks × two repeats × baseline/extension arms. Main model `zai/glm-5.3-flash`, requested thinking off. Same prompts and read/grep/find/ls tools; only the extension arm additionally enabled `jev_search`. No forced tool use. Arm order reversed in repeat two. All processes completed; no tool validation failures occurred.

| Metric | Normal Pi search | Jev search available |
|---|---:|---:|
| Sessions | 8 | 8 |
| Sessions calling Jev | 0 | **1** |
| Correct core answer facts, manually reviewed | 8/8 | 8/8 |
| Mean read recall of two labeled files | 87.5% | 81.25% |
| Mean elapsed time | 19.977 s | 19.969 s |
| Mean main-model context tokens, including cache | 14,985 | 26,008 |
| Mean tool-result text bytes | 21,747 | 36,681 |
| Mean estimated total cost, including Jev | $0.000564 | $0.001018 |

All answers gave the required core facts and distinguished archives from current behavior. **Not all citations were accurate**: for example, several retry answers cited the delay cap at line 6 or 7, whereas it is at line 8; a refresh answer placed the retry call at line 8 instead of 7. This is core-fact correctness, not flawless task completion. The manual review was performed by the implementation assistant, not an independent adjudicator.

Read recall is not answer correctness: one file sometimes contained all required facts, and grep also supplied evidence. The extension arm's only Jev user was rollback repetition one; it subsequently used grep and read both source documents. Most extension sessions still relied exclusively on ordinary search. Larger grep contexts and varying discovery steps contributed to higher context volumes; this small uncontrolled strategy sample cannot assign all extra cost to the tool schema. Cache/order effects also matter. Mean time was effectively unchanged, while estimated cost was ~1.81× higher.

Total agent-session cost: **$0.012658**. Including direct retrieval checks: **$0.015612**, excluding standalone smoke requests and subsequent verification calls. Estimates use provider-reported main-model usage and documented Jev pricing, not a billing ledger.

## Interpretation and limits

- Ranking worked on the frozen fixture; adoption and end-to-end efficiency remain the harder problems.
- Do not automatically route every search through Jev. Exact symbols/paths often favor ordinary tools; explicitly requested broad ranking remains the clearest use case.
- Only jev_search was enabled for this A/B. The other three tools' additional prompt overhead was not measured.
- Four distinct synthetic tasks, not 16 independent tasks; no coding edits, builds, or real-project resolution were assessed.
- Original agent holdout cases remain untouched. This new fixture is development evidence; do not reuse it as an independent test set after tuning.
- After the recorded run, response validation/output-budget guards, larger classification category support, explicit unclear review flags and per-file truncation metadata were hardened. No retrieval/ranking prompts, relevance labels, sampling or ranking thresholds were tuned against these results. The saved manifest identifies the exact evaluated source hashes. Final live checks also passed after hardening (rank order, unclear review flag, and multi-batch code/document search); these verification calls are not substituted into the benchmark metrics.

## Reproduction and evidence

- [Protocol](RETRIEVAL-PROTOCOL.md)
- [Metrics, per-session usage and manifest](retrieval-metrics.json)
- Fixture: `evals/retrieval-fixture.ts`
- Runner: `scripts/eval-retrieval.ts --run` (via tsx, from source checkout)
- Gitignored raw evidence: `evals/results/retrieval-2026-09-17T22-27-21.400Z/`

Metrics are computed from saved raw outputs. Regex fact checks in the runner are only screening aids; the correctness observations above additionally used review of every final answer and fixture source.

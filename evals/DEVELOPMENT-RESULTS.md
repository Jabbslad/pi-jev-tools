# Development eval results — 2026-09-17

## Verdict

The extension works live, but **these evaluations do not demonstrate a net benefit over the main model alone**. They exposed question-construction problems that unit tests could not detect. Clearer tool instructions improved ranking and mixed-question calls, but did not eliminate invalid calls, unnecessary delegation, or overconfident interpretation.

**Do not treat this as a passed quality benchmark.** This is an assistant-reviewed development diagnostic on synthetic examples, not an independently scored public benchmark. Holdout cases have not been run.

## Setup and artifacts

- Main model: `zai/glm-5.3-flash`, Pi 0.85.1; requested thinking `off` in both arms. Some provider responses still reported reasoning tokens, so this is not a guarantee of zero reasoning.
- TypeSafe: requested and returned `jev-1.13.0`.
- Initial: all 10 development cases, three repeats each; four autonomous cases had both baseline and extension arms. **42 sessions**.
- Revised: ticket classification, ranking, release-note checks, and mixed questions, three repeats; ticket classification retained both arms. **15 sessions**.
- One separate mixed-question preflight is excluded from the tables.
- Fresh sessions, no built-in tools/skills/context files/other extensions. Sequential execution; autonomous arm order alternated by repeat.
- The user's custom `SYSTEM.md` remained in both arms. Inspection of the actual system messages and Pi source confirmed that this replaces the default rules section, omitting extension `promptGuidelines`. Tool descriptions and schemas remain visible.
- Exact instructions sent to models, tool arguments/results, usage and errors are in gitignored `evals/results/2026-09-17T21-04-02.689Z/` (initial) and `evals/results/2026-09-17T21-14-31.452Z/` (revised). Each directory includes a manifest with source hashes. `preflight.jsonl` is separate.
- [development-metrics.json](development-metrics.json) preserves per-run metrics without raw prompts/transcripts. No API keys are included.

Reported USD is estimated from Pi usage metadata, including nested TypeSafe usage exactly once. Total for the two batches: **$0.01190837**, excluding preflight. Cache pricing and different warmed-cache states affect comparisons; these are not invoice amounts or rigorous latency benchmarks.

## Initial findings

| Case | Observed behavior across three repeats |
| --- | --- |
| Ticket batch (autonomous A/B) | Both arms ultimately returned all six correct labels. The extension was called in all three tool-enabled runs. In one run, unanchored questions returned billing for everything; the main model rejected the result and classified directly. Another used leading descriptions that essentially supplied the intended labels. |
| Ranking | All three initial attempts used a map for Score criteria instead of a string array. Two then switched to Choice with identical, untargeted instructions, producing irrelevant high-confidence matches. Those two recovered by making six separate calls. Final shortlists were sensible, but batching and requested primitive failed in those runs. |
| Release-note checks | Correct final probabilities in all runs. One invalid call added an `unclear` criterion to Noul; a subsequent call removed it. |
| Mixed questions | All three initial calls had invalid Score criteria (objects or a map). All recovered, but final prose overstated confidence or invented explanations; one asserted a confirmed P1 incident without a supplied priority policy. |
| Ambiguous ticket | Two selected unclear. One selected technical with low confidence; the main model acknowledged insufficient evidence rather than inventing a root cause. |
| Exact arithmetic | Correct answer in both arms, all repeats; no TypeSafe calls. |
| Code generation | Correct order-preserving deduplication function in both arms, all repeats; no TypeSafe calls. |
| Exact matching/counting | Both arms ultimately answered 2, with no TypeSafe calls. One baseline answer and one extension-enabled answer first asserted an incorrect count and visibly corrected themselves: final-value correctness is not a flawless response. |
| Focused state/privacy | All three calls excluded the forbidden synthetic secret from state and questions. Two final responses repeated the synthetic marker to the user; the requirement was specifically not to send it to TypeSafe. |
| Dependent questions | All three resolved team before evaluating only the selected reply. Two returned friendly; one returned neutral with low confidence. The draft golden label says friendly, but that subjective label needs human review rather than being treated as unambiguous ground truth. |

There were **7 validation failures** in 30 initial extension-enabled sessions, all recovered. No fatal model/transport failures were observed. The arithmetic, generation and counting negative controls made **0 inappropriate TypeSafe calls in 9 tool-enabled runs**.

### Actual autonomous A/B result: small ticket classification

Means over three repeats:

| Version | Arm | Seconds | Estimated USD | Final labels |
| --- | --- | ---: | ---: | --- |
| Initial | Baseline | 3.085 | 0.00004199 | Correct in 3/3 |
| Initial | Extension | 15.153 | 0.00033092 | Correct in 3/3; one needed direct fallback |
| Revised | Baseline | 3.015 | 0.00002703 | Correct in 3/3 |
| Revised | Extension | 16.565 | 0.00030375 | Correct label mapping in 3/3; see qualifications below |

Initial tool-enabled runs were approximately **4.9× slower and 7.9× the estimated cost**, with no final-label improvement. Revised runs also showed no advantage. These small tasks were already in the main model's context, so there was no retrieval-token saving to measure.

## Instruction changes and targeted retest

Kept the schema strict; no automatic repair or inference of malformed questions was added. Changed only tool/schema descriptions to:

1. Put essential guidance in the tool description, not only `promptGuidelines`, so it survives custom `SYSTEM.md`.
2. Show Score's required string-array shape and Noul's permitted criteria keys.
3. Require an explicit per-item reference in instructions: question IDs are not sent to Jev.
4. Explain that small obvious tasks can be answered directly, and results are estimates rather than proof or generated explanations.

On the **same 12 extension-enabled runs** covered by the targeted retest:

| Measure | Initial | Revised |
| --- | ---: | ---: |
| Invalid calls | 7 | 3 |
| Score-criteria shape errors | 6 | 0 |
| Ranking runs with correct targeting and six Score questions in one successful batch | 1/3 | 3/3 |
| Ranking mean wall time | 42.129 s | 18.595 s |
| Ranking mean estimated USD | 0.00105135 | 0.00040461 |
| Mixed-question runs with no rejected call | 0/3 | 3/3 |
| Release-note runs with no rejected call | 2/3 | 1/3 |

This is a development comparison after tuning on these cases, **not held-out evidence of generalization**. The before/after changes are consistent with better instructions, but three samples and service/cache variation do not establish causality or stable performance gains.

### Remaining failures and trade-offs

- The three revised invalid calls omitted the required `type`: one ranking call and two release-note calls. The model recovered after Pi's validator rejected them. Prompt changes moved, rather than eliminated, some schema errors.
- Revised mixed-question prose still overstates certainty or invents reasons for residual probability, despite explicit guidance. This remains an interpretation failure.
- The main model still delegated the small ticket task in all three revised runs. One evaluated only one ticket while sending unrelated tickets as state; another copied the tool-description example's billing/other categories, omitted technical, then classified technical cases itself. Final labels were correct, but these were inefficient or poorly designed evaluations. One answer labeled a commented object as JSON, which is not valid JSON.
- Correct final answers can hide poor intermediate questions. The evaluation must inspect both layers, not just final labels.
- Tone classification and vague-category gold labels need independent review. Do not tune away legitimate ambiguity to match our synthetic labels.
- No post-change regression claim is made for the six development cases not rerun.

## Recommendation

Keep the tool available for deliberate experimentation, not automatic use on every task. The next experiment should be a neutral, realistically sized ranking task with independent relevance labels and a baseline main model, followed by the untouched holdout. Compare total cost and quality rather than API call cost alone.

A specialized ranking tool could construct correctly targeted questions and fixed rubrics in code, reducing orchestration errors; that is a possible next implementation, not a demonstrated improvement yet. The current evidence does not show that adding a skill is necessary, or that a skill would fix these model-behavior problems.

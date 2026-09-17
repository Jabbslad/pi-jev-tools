# Direct BANKING77 pilot results

**Date:** 2026-09-17. **Verdict:** Jev showed a clear latency advantage and reliable output structure on this fixed decision workload. Label accuracy was similar to the tested LLM, with a small numerical advantage for Jev. We did **not** establish superior calibration or the homepage's headline cost/speed multipliers.

This result does not contradict the earlier negative Pi-agent comparison: here code builds the questions and consumes decisions directly, without a main model designing questions or interpreting the response.

## Design

The [frozen protocol](DIRECT-PROTOCOL.md) was written before model outcomes. Independently annotated BANKING77 test data, one deterministic example per intent, **77 unique examples**, two repetitions, batches of seven, **66 direct calls**. No question tuning, output repair, case replacement or retries based on results. Only one baseline model: `zai/glm-5.3-flash`; Jev requested and returned `jev-1.13.0`.

Three arms: native Jev Choice, GLM with the same questions and complete distributions, and a GLM labels-only output-cost control. The dataset source, CC BY 4.0 attribution, revision, sampling and metric definitions are in the protocol. This is a subsample, not a complete BANKING77 benchmark.

Artifacts:

- Raw requests/responses, original run-time scores, corrected offline scores, source hashes and settings: gitignored `evals/results/banking77-pilot/2026-09-17T21-35-28.042Z/`.
- Frozen sample: gitignored `evals/results/banking77-pilot/sample.json`.
- [direct-metrics.json](direct-metrics.json): aggregate numbers, calibration bins, paired comparisons and per-repeat counts.
- `scripts/direct-benchmark.ts`: prepare/run; `scripts/summarize-direct.ts`: offline scoring/aggregation.

## Main results

Pooled counts include two predictions per example; **154 is not the independent sample size**.

| Measure | Jev Choice | GLM full probabilities | GLM labels only |
| --- | ---: | ---: | ---: |
| Direct calls | 22 | 22 | 22 |
| Median latency per 7-example batch | **0.864 s** | 50.802 s | 5.851 s |
| Mean latency per batch | **0.840 s** | 42.969 s | 5.615 s |
| Latency range | 0.289–1.536 s | 8.455–62.576 s | 2.268–9.387 s |
| Total estimated USD | **$0.009401** | $0.050261 | $0.011799 |
| Structurally valid batches | **22/22** | 17/22 | **22/22** |
| Fully valid predictions (including probability checks where required) | **154/154** | 114/154 | **154/154** |
| Contract-valid AND correct predictions | **123/154 (79.9%)** | 91/154 (59.1%) | 118/154 (76.6%) |
| Label correctness alone, ignoring invalid distributions (diagnostic) | 123/154 (79.9%) | 121/154 (78.6%) | 118/154 (76.6%) |
| Same selected label across repetitions | **76/77** | 70/77 | 69/77 |

The probability LLM's low contract-valid accuracy is **not** evidence of a large classification-intelligence gap. Five batches omitted required probability keys (35 affected predictions); another five individual distributions summed outside the permitted range. Ignoring those contract failures, its selected labels were almost as accurate as Jev's. Sparse distributions were not silently filled with zeros or repaired.

Per-repeat label correctness:

| Arm | Repetition 1 | Repetition 2 |
| --- | ---: | ---: |
| Jev | 62/77 | 61/77 |
| GLM probabilities, label-only diagnostic | 59/77 | 62/77 |
| GLM labels | 60/77 | 58/77 |

Against the labels-only baseline, paired disagreements were 3 Jev-only-correct versus 1 GLM-only-correct in repetition 1, and 5 versus 2 in repetition 2. This is too little evidence to claim a robust accuracy advantage. The full-distribution GLM slightly surpassed Jev's label accuracy in the second repeat.

## Speed and cost: what can we claim?

- Ratio of median batch latencies: Jev was approximately **59× faster** than the full-distribution LLM and **6.8× faster** than labels-only. Median ratios for matched batch/repeat pairs were **57.2×** and **6.8×**, respectively.
- Estimated total cost: Jev was **5.35× cheaper** than full distributions and **1.26× cheaper** than labels-only across both repetitions.
- Caching matters: on repetition 2, labels-only GLM cost **$0.004665**, slightly less than Jev's **$0.004700**. A universal cost advantage is not supported.
- Total estimated spend for all 66 calls: **$0.071461**.
- The distribution-producing GLM must serialize 77 numbers for each of seven items. The labels-only control demonstrates how much the output requirement changes the result. Alternative, more compact LLM encodings or provider-enforced structured output could change the comparison; this measures the stated forced-function-call adapter, not the best imaginable LLM implementation.
- Jev's local median was 864 ms, not the site's stated 70–500 ms range. These measurements include network/client overhead and seven-question requests from this machine; they are not server-side inference timing. We did not control geography or server load.

This supports the narrower proposition that Jev can be a much faster decision service at comparable accuracy. It does **not** reproduce TypeSafe's exact 193.6×/444.6× headline gains, which use different workflows and model baselines.

## Confidence and probability quality

Do not equate Jev's separate `confidence` field with the probability assigned to its selected label. The following metrics use returned class probabilities. To avoid comparing different valid-output subsets, both models are scored on the **same 114 example/repeat pairs** where both distributions were valid:

| Metric (lower is better) | Jev | GLM probabilities |
| --- | ---: | ---: |
| Multiclass Brier score (sum, range 0–2) | **0.3103** | 0.3224 |
| Negative log likelihood | 2.2150 | **2.0407** |
| Exploratory five-bin top-label ECE | 0.1136 | **0.0602** |

Mixed evidence, not a calibration win for Jev. This subset is selected by successful LLM output, the sample is tiny, and repetitions are correlated. Log loss is sensitive to rounded zero probabilities and the predeclared `1e-15` clipping; the API probabilities are not unrounded internal beliefs. Do not infer a general calibration ranking from this pilot.

Across all Jev predictions, **9 of 106 predictions with normalized top-class probability ≥0.90 disagreed with the dataset label** (counts include repeats). For example, the source labels “I topped up but it didn't complete” as `pending_top_up`, while Jev returned `top_up_failed` with probability 1 and confidence 1 in the first run. This demonstrates a confident disagreement with the dataset, not a malformed output. Some labels are debatable: “Is there a fee for exchanging cash?” is labeled `wrong_exchange_rate_for_cash_withdrawal`, while Jev selected `exchange_charge`. We kept the original labels for primary scoring rather than relabeling favorable or unfavorable examples.

Thus **schema safety is not factual certainty**. “Zero hallucinations” should not be read as “always agrees with a correct real-world label.”

## Measurement caveats and scoring correction

- Only 77 independent examples, one example per class, one public dataset and one cheap LLM baseline. The dataset may appear in either model's training data. No claims of statistical significance or unseen-domain generalization.
- Neither category descriptions nor prompts were optimized against test outcomes. Intent names alone can be ambiguous; no training examples or domain-specific definitions were supplied.
- Both APIs received the same semantic state/questions, but native Jev and LLM function calling have different protocol overhead. The model-ID strings do not guarantee immutable underlying deployments.
- Although ZAI `thinking.type=disabled` was explicitly requested, the provider reported **1,845 reasoning tokens** in the probability arm and **1,294** in labels-only. Usage and latency include these; we cannot claim reasoning was actually absent. No requests were rerun to remove it.
- Prices derive from configured token rates and provider usage, with cache discounts included; not invoices. No fatal transport errors occurred. Structural/numerical output failures were retained and counted.
- **Offline scoring correction:** binary floating-point arithmetic originally rejected four sums of exactly 0.95 at the inclusive 0.05 tolerance boundary. Added a `1e-12` numerical epsilon, tested the boundary, and recomputed scores from unchanged raw responses. The tolerance, queries, labels and outputs did not change. Original run-time results remain preserved. This changed GLM probability-valid predictions from 110 to 114 and contract-valid correct predictions from 90 to 91. All report figures use corrected scores.
- Raw-label accuracy is explicitly a post-hoc diagnostic to separate classification from contract failure; it does not replace the preregistered validity-aware result.

## Practical conclusion for this project

**The strongest demonstrated value is fast, structurally reliable decisions when code controls the questions.** The generic Pi tool adds an LLM before/after that service and can erase the benefit.

A specialized retrieval/ranking integration is therefore worth a separate end-to-end experiment, not yet a proven improvement. Next evidence should use realistic retrieved candidates with independent relevance judgments, and compare complete Pi task quality, total latency and cost. The agent eval holdout remains unrun. No production auto-routing or confidence-based authorization is justified by these results.

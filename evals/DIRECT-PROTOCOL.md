# Direct decision benchmark: frozen pilot protocol

Defined before inspecting model outcomes. This is separate from the Pi agent evals and does not modify their holdout set.

## Question

For a fixed intent-classification workload, how do Jev and an LLM compare on independently annotated labels, response validity, wall-clock API latency, estimated cost, and probability quality? Does requesting full distributions materially affect the LLM's cost/latency?

## Dataset and attribution

BANKING77, from **Casanueva, Temcinas, Gerz, Henderson and Vulić (2020), _Efficient Intent Detection with Dual Sentence Encoders_**, [paper](https://arxiv.org/abs/2003.04807), [PolyAI dataset](https://github.com/PolyAI-LDN/task-specific-datasets).

- License: [Creative Commons Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/), confirmed in the repository LICENSE. Credit the authors when reusing the data; this pilot is a subsample, not the original complete benchmark.
- Pin: `57ec275d8078af65b7731c2a98be812d844a6d6b`.
- Official test split: 3,080 annotated examples, 77 intents. No training examples used.
- Select one example per intent by minimizing SHA-256 of `pi-typesafe-banking77-pilot-v1:<zero-based CSV data-row index>`. Shuffle the selected rows using SHA-256 of the same seed with `:order:<index>`.
- Result: 77 unique examples, category-balanced, with independent dataset labels. Repetitions do not increase independent sample size.
- Represent the 77 alphabetically sorted intent names as `c000`–`c076`; descriptions are only the original name with underscores replaced by spaces. Identical choices and descriptions in every arm. No hand-tuned definitions or few-shot examples.
- Raw data/sample/license stay under gitignored `evals/results/banking77-pilot/`; preparation records source hashes. The label is excluded from each model request. Subsampling and recoding are the only dataset transformations.

## Arms

1. **Jev:** `jev-1.13.0`, native Choice, including all option probabilities.
2. **LLM probabilities:** `zai/glm-5.3-flash`, forced `submit_answers` function with a schema requiring one choice and all 77 probabilities per question.
3. **LLM labels:** same LLM and semantic inputs/questions, but only choices required. This is an output-cost control, not a claim of output equivalence with Jev.

Each arm receives the exact same state and fixed questions. Every question explicitly names its target (`state.messages.qNNN`). The LLM additionally receives only a fixed output-format system instruction and a tool schema; no agent tools, conversation, Pi system prompt, generated question design, or follow-up interpretation. Jev's native confidence statistic is not treated as the chosen class's probability.

Two repetitions, 11 batches of seven examples, three arms: **66 direct calls**. Each batch/arm is one call. Arm order rotates per batch and reverses on repetition two. No warm-up calls are excluded. No concurrency, automatic retries, output repairs or semantic retries. Retain invalid outputs as failures, not silently corrected successes. A fatal transport/model failure stops the run with evidence preserved; any resumed experiment must be identified separately.

- LLM temperature 0; ZAI `thinking.type=disabled` explicitly set; maximum output 16,384 tokens.
- Both arms: 180-second deadline, zero retries.
- Record returned model IDs and reported reasoning/cache usage. Vendor aliases/serving implementations may still change behind a fixed ID.
- API latency measured in-process, from immediately before the request until response processing finishes, excluding model-runtime setup, dataset downloads, and disk recording. LLM transport streams but timing runs to complete response. No agent orchestration/CLI startup in timing.
- Costs use provider-reported usage and configured prices; Jev at $0.042/M input tokens, output free. They are estimates, not invoices. Preserve cache usage rather than silently comparing nominal uncached prices.

## Predeclared scoring

Report each repetition separately plus descriptive pooled totals. Do not count 154 repeated predictions as 154 independent examples.

- Exact-label accuracy against dataset gold, denominator includes invalid predictions.
- Structural validity per batch: all expected answer IDs and option keys, valid choices, numeric probabilities in [0,1], no extra output properties. A malformed batch fails all seven predictions. Jev's native metadata is projected to the same answer fields before validation.
- Probability validity per row: sum within **0.05** of one; selected class must attain the maximum (ties allowed). The tolerance accommodates rounded 77-way distributions. Keep raw sums; normalize within that tolerance for the following metrics. Outside it, mark invalid rather than repairing.
- Multiclass Brier score: sum of squared errors across all 77 classes, range 0–2, lower better. Not divided by class count.
- Negative log likelihood: `-ln(p(gold))`, clipping below `1e-15`. Lower better; clipping reported.
- Exploratory top-label ECE: five fixed equal-width probability bins, weighted absolute difference of accuracy and mean top probability. A tiny sample cannot establish calibration. Report bin counts, not only the scalar.
- Latency: median, mean and range across calls, including invalid calls; report paired batch comparisons. Costs: totals and mean per example, including invalid calls. Do not sum streaming usage snapshots.
- Cross-repeat label agreement, paired correct/incorrect counts, and high-probability errors are descriptive checks, not independent significance tests.

No label changes, question tuning, case replacement, or selective exclusion based on observed outcomes. Ambiguous apparent dataset labels may be discussed after scoring but do not alter the primary result. This well-known public dataset may be in either model's training data; contamination cannot be ruled out.

## Run

```sh
npm ci
node --import tsx scripts/direct-benchmark.ts --prepare
# Preparation is create-only; do not overwrite a frozen sample.
# Requires TYPESAFE_API_KEY and configured ZAI credentials:
node --import tsx scripts/direct-benchmark.ts --run
# Offline aggregation; substitute the timestamped run directory:
node --import tsx scripts/summarize-direct.ts evals/results/banking77-pilot/<run-directory>
```

Post-run numerical correction: the inclusive 0.05 sum tolerance is implemented with a `1e-12` floating-point epsilon. Original run-time scores are preserved; aggregation recomputes from raw outputs. No thresholds, questions or labels were tuned. See [results and caveats](DIRECT-RESULTS.md).

This intentionally does **not** run during `npm test`. Compare against multiple models and larger independently reviewed samples before generalizing to vendor claims or production workflows. A direct API gain does not prove an end-to-end Pi gain.

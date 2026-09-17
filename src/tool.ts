import { Check } from "typebox/value";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { parameters } from "./schema.ts";
import { defaultClient, evaluateRequests, type ClientFactory } from "./client.ts";
export { clientConfig } from "./client.ts";

// Essential guidance belongs here too: Pi omits promptGuidelines when a custom
// SYSTEM.md replaces its default prompt.
const description = [
  "Evaluate text/JSON with TypeSafe's non-generative decision model. Use for substantial batches of narrow semantic judgments, or when explicitly requested. Prefer answering small obvious tasks directly; another API call adds latency and cost. Not for text/code generation or exact computations.",
  "Batch independent questions sharing focused state. For each candidate, instructions MUST explicitly identify the target, e.g. 'Rate only state.candidates.a for relevance to state.goal'. Jev does NOT see question IDs: different IDs with identical 'this snippet' instructions evaluate the same whole state. Dependent judgments need another call.",
  'Question shapes: Choice uses criteria as a named map, e.g. {"billing":"Payments","other":"Anything else"}. Score uses ONLY an ordered array of strings, e.g. ["Unrelated","Supporting","Directly relevant"] — never a map or array of objects. Noul asks yes/no, with optional criteria containing ONLY "true" and "false" descriptions; omit criteria if unnecessary. Use Choice, not a third Noul criterion, when an explicit unclear option is needed.',
  "Returns structured answers, not explanations or proof. Report probabilities and confidence as model estimates, not certainty about the world; do not invent reasons for residual probability or unsupported priority labels. Noul has no separate confidence. Never use judgments alone to authorize destructive actions or enforce security.",
  "Supplied state and questions go to TypeSafe: exclude secrets. Sending material already read by the main model does not recover its input-token cost.",
].join("\n\n");

export function createEvaluateTool(
  createClient: ClientFactory = defaultClient,
  deadlineMs = 30_000,
) {
  return defineTool({
    name: "typesafe_evaluate",
    label: "TypeSafe Evaluate",
    description,
    promptSnippet: "Batch narrow classification, rubric scoring, and yes/no judgments with TypeSafe.",
    promptGuidelines: [
      "Use typesafe_evaluate when multiple narrow semantic evaluations justify another API call; do not call it for every task or for exact computations.",
      "For typesafe_evaluate, provide focused state and one atomic judgment per question. Batch independent questions sharing that state; dependent questions require another call.",
      "Treat typesafe_evaluate results as advisory. Preserve uncertainty; confidence is not correctness, and Noul probability is not a separate confidence score. Never use it alone to authorize destructive actions or enforce security.",
      "typesafe_evaluate cannot save the cost of context already read by the main model. Do not claim retrieval savings merely from forwarding previously read search results.",
    ],
    parameters,
    async execute(_toolCallId, params, signal) {
      // Also validate direct invocations (e.g. tests), not only Pi's tool loop.
      if (!Check(parameters, params)) {
        throw new Error("Validation failed for typesafe_evaluate: supply text/JSON state and nonempty, correctly typed questions with instructions and required criteria.");
      }
      const { responses: [response], usage } = await evaluateRequests([params], signal, createClient, deadlineMs);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(response) }],
        details: response,
        usage,
      };
    },
  });
}

import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createEvaluateTool } from "../src/tool.ts";

if (!process.env.TYPESAFE_API_KEY?.trim()) {
  throw new Error("Set TYPESAFE_API_KEY to run this opt-in, billable live smoke test.");
}
const result = await createEvaluateTool().execute("live-smoke", {
  model: "jev-1.13.0",
  state: "I was charged twice. Please refund the duplicate charge.",
  questions: {
    category: {
      type: "choice", instructions: "What is this request about?",
      criteria: { billing: "Charges and refunds", technical: "Software malfunction", other: "Something else" },
    },
    urgency: {
      type: "score", instructions: "How explicitly urgent is the request?",
      criteria: ["No urgency stated", "Some urgency", "Explicit immediate deadline"],
    },
    refund: { type: "noul", instructions: "Is a refund explicitly requested?" },
  },
}, undefined, undefined, {} as ExtensionContext);
assert.equal(result.details.answers.category.type, "choice");
assert.equal(result.details.answers.urgency.type, "score");
assert.equal(result.details.answers.refund.type, "noul");
assert.ok(result.usage && result.usage.totalTokens > 0);
console.log(JSON.stringify(result, null, 2));

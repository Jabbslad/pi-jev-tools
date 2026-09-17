import { StringEnum, Type, type Static } from "@earendil-works/pi-ai";
import type { EntryType, ScoreCriteria } from "@typesafe-ai/sdk";

// Tool arguments arrive as JSON. Leave nested state open so records and arrays
// need not be flattened into text; keep question instructions simple in v1.
const state = Type.Unsafe<Exclude<EntryType, null>>({
  anyOf: [{ type: "string" }, { type: "object", additionalProperties: true }, { type: "array", items: {} }],
  description: "Only the relevant text or JSON to evaluate. This is sent to TypeSafe; exclude secrets and unrelated context.",
});
const instructions = Type.String({
  minLength: 1,
  description: "One atomic judgment explicitly identifying its target, e.g. 'Rate only state.candidates.a against state.goal'. Jev does NOT see question IDs; never rely on the ID to select a candidate. Questions cannot see other answers.",
});
const question = Type.Union([
  Type.Object({
    type: StringEnum(["choice"] as const),
    instructions,
    criteria: Type.Record(Type.String(), Type.Union([Type.String(), Type.Null()]), {
      minProperties: 2,
      description: "Named alternatives mapped to descriptions (or null). Returns choice, probabilities, confidence. Include an unclear/none option when appropriate.",
    }),
  }, { additionalProperties: false }),
  Type.Object({
    type: StringEnum(["score"] as const),
    instructions,
    criteria: Type.Unsafe<ScoreCriteria>({
      type: "array", items: { type: "string", minLength: 1 }, minItems: 2,
      description: 'ONLY an ordered array of strings, e.g. ["Unrelated","Supporting","Directly relevant"], never a map or objects. At least two levels. Returns a weighted score from 0 to levels-1 (possibly fractional), probabilities and confidence; not exact numeric measurement.',
    }),
  }, { additionalProperties: false }),
  Type.Object({
    type: StringEnum(["noul"] as const),
    instructions,
    criteria: Type.Optional(Type.Object({
      true: Type.Optional(Type.String()),
      false: Type.Optional(Type.String()),
    }, {
      additionalProperties: false,
      description: "Optional descriptions of yes and no. Returns noul: probability of yes (0–1), not a boolean; no separate confidence field.",
    })),
  }, { additionalProperties: false }),
]);

export const parameters = Type.Object({
  state,
  questions: Type.Record(Type.String(), question, {
    minProperties: 1,
    description: "Named questions evaluated independently against the same state in one request. Answers use the same IDs. Batch related evaluations here instead of making one call per question.",
  }),
  model: Type.Optional(StringEnum(["jev-latest", "jev-preview", "jev-1.13.0"] as const, {
    description: "Defaults to jev-latest. Pin jev-1.13.0 for repeatable evaluations; aliases may change.",
  })),
}, { additionalProperties: false });

export type EvaluateParams = Static<typeof parameters>;

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("eval fixtures contain 20 distinct, reviewable cases with separate splits", () => {
  const cases = JSON.parse(readFileSync(new URL("../evals/cases.json", import.meta.url), "utf8"));
  assert.equal(cases.length, 20);
  assert.equal(new Set(cases.map((item: { id: string }) => item.id)).size, 20);
  for (const item of cases) {
    assert.match(item.id, /^[a-z][a-z-]+$/);
    assert.ok(["development", "holdout"].includes(item.split));
    assert.ok(["guided", "autonomous"].includes(item.mode));
    assert.ok(["expected", "optional", "avoid"].includes(item.toolUse));
    assert.ok([null, "choice", "score", "noul", "mixed"].includes(item.preferredPrimitive));
    assert.ok(item.prompt.length > 20);
    assert.ok(item.expected.length >= 2);
    assert.ok(item.expected.every((criterion: unknown) => typeof criterion === "string" && criterion.length > 0));
  }
  assert.equal(cases.filter((item: { split: string }) => item.split === "development").length, 10);
  assert.equal(cases.filter((item: { split: string }) => item.split === "holdout").length, 10);
});

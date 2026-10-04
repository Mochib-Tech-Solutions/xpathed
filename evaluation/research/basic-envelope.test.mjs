import assert from "node:assert/strict";
import test from "node:test";
import { basicRequest } from "./basic-envelope.mjs";

test("archived Basic request envelope preserves the task and rejects conflicting selectors", () => {
  const input = { instruction: "Click Save", documentId: "document-1" };
  assert.deepEqual(basicRequest(input), { ...input, contractVersion: "4" });
  assert.deepEqual(input, { instruction: "Click Save", documentId: "document-1" });
  assert.deepEqual(basicRequest({ ...input, contractVersion: "4" }), {
    ...input,
    contractVersion: "4",
  });
  assert.throws(() => basicRequest({ ...input, contractVersion: "other" }), /Conflicting Basic/);
});

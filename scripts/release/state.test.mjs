import assert from "node:assert/strict";
import test from "node:test";
import { emptyState, transition } from "./state.mjs";

test("explicit promotion retains the previous approval and rollback cannot choose an experiment", () => {
  const first = {
    candidateSha256: "a".repeat(64),
    sourceSha: "1".repeat(40),
    contractVersion: "4",
    status: "qualified",
  };
  const second = { ...first, candidateSha256: "b".repeat(64), sourceSha: "2".repeat(40) };
  const options = {
    expectedCurrent: "none",
    actor: "maintainer",
    reason: "Reviewed qualification",
  };
  assert.throws(
    () => transition(emptyState(), "promote", { ...first, status: "experiment" }, options),
    /qualified/,
  );
  let state = transition(emptyState(), "promote", first, options);
  assert.deepEqual(state.current, first);
  assert.equal(state.previous, null);
  assert.throws(() => transition(state, "promote", second, options), /changed/);
  state = transition(state, "promote", second, {
    ...options,
    expectedCurrent: first.candidateSha256,
  });
  assert.deepEqual(state.previous, first);
  assert.throws(
    () =>
      transition(
        state,
        "rollback",
        { ...first, candidateSha256: "c".repeat(64) },
        { ...options, expectedCurrent: second.candidateSha256 },
      ),
    /previous/,
  );
  state = transition(state, "rollback", first, {
    ...options,
    expectedCurrent: second.candidateSha256,
  });
  assert.deepEqual(state.current, first);
  assert.deepEqual(state.previous, second);
  assert.deepEqual(
    state.history.map((entry) => entry.operation),
    ["promote", "promote", "rollback"],
  );
});

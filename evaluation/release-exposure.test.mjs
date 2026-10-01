import assert from "node:assert/strict";
import test from "node:test";
import { reserveHoldout } from "./release-exposure.mjs";

test("shared confirmation reservation blocks reused families and conditional-write failures", async () => {
  let state = { version: 1, exposures: [] },
    writes = 0;
  const fetch = async (_url, options) => {
    if (options.method === "GET")
      return Response.json({
        sha: "a".repeat(40),
        encoding: "base64",
        content: Buffer.from(JSON.stringify(state)).toString("base64"),
      });
    writes++;
    state = JSON.parse(Buffer.from(JSON.parse(options.body).content, "base64"));
    return Response.json({ content: { sha: "b".repeat(40) } });
  };
  const manifest = {
    id: "original-run",
    code: { revision: "1".repeat(40) },
    cases: [{ family: "fresh", split: "held-out" }],
  };
  const receipt = await reserveHoldout(manifest, "example/private", "secret", fetch);
  assert.equal(receipt.runId, "original-run");
  assert.equal(writes, 1);
  await assert.rejects(
    reserveHoldout({ ...manifest, id: "retry" }, "example/private", "secret", fetch),
    /previously exposed/,
  );
  assert.equal(writes, 1);
  state.exposures = [];
  await assert.rejects(
    reserveHoldout(manifest, "example/private", "secret", async (url, options) =>
      options.method === "PUT" ? new Response("conflict", { status: 409 }) : fetch(url, options),
    ),
    /reservation failed/,
  );
});

import assert from "node:assert/strict";
import test from "node:test";
import { checkRuntime } from "./control.mjs";

test("activation requires the installed client contract and actual HTTP service readiness", async () => {
  const responses = {
    "http://web:8080/release-contract.json": { version: 1, resolutionContract: "4" },
    "http://web:8080/health": {
      service: "client-api",
      resolutionContract: "4",
    },
    "http://web:8080/view/health": { service: "browser" },
    "http://resolver:8080/health": { service: "resolver" },
  };
  const calls = [];
  const docker = async (args) => {
    calls.push(args);
    return JSON.stringify(responses[args.at(-1)]);
  };
  await checkRuntime(docker, "web-container", "4", 1);
  assert.equal(calls.length, 4);
  await assert.rejects(checkRuntime(docker, "web-container", "3"), /compatibility/);
  responses["http://web:8080/view/health"] = { service: "nginx" };
  await assert.rejects(checkRuntime(docker, "web-container", "4", 1), /readiness/);
});

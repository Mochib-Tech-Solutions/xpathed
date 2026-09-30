// Explicit real-browser check, run inside the isolated Stagehand container.
import assert from "node:assert/strict";
import { createServer } from "node:http";

const adapter = process.env.STAGEHAND_URL ?? "http://127.0.0.1:8092";
let command;
let observation;
let environment;
const script = `<script>
const before = {x:scrollX,y:scrollY,active:document.activeElement,clicks:0};
document.addEventListener('click',()=>before.clicks++);
fetch('/environment',{method:'POST',body:JSON.stringify({width:innerWidth,height:innerHeight,userAgent:navigator.userAgent,languages:navigator.languages,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone})});
setInterval(async()=>{
  const command=await(await fetch('/command')).json(); if(!command)return;
  const matches=command.targets.map(target=>{
    let doc=document;
    for(const frame of target.frame.chain){
      const found=doc.evaluate(frame.xpath,doc,null,XPathResult.ORDERED_NODE_SNAPSHOT_TYPE);
      if(found.snapshotLength!==1)return null;
      doc=found.snapshotItem(0).contentDocument;
    }
    const found=doc.evaluate(target.xpaths[0],doc,null,XPathResult.ORDERED_NODE_SNAPSHOT_TYPE);
    return found.snapshotLength===1?found.snapshotItem(0).id:null;
  });
  await fetch('/observation',{method:'POST',body:JSON.stringify({matches,passive:scrollX===before.x&&scrollY===before.y&&document.activeElement===before.active&&before.clicks===0})});
},25);
</script>`;
const server = createServer(async (request, response) => {
  response.setHeader("Content-Type", "text/html");
  if (request.url === "/frame")
    return response.end('<html><body><button id="inner">Inside</button></body></html>');
  if (request.url === "/command") {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(command ?? null));
    command = undefined;
    return;
  }
  if (request.method === "POST") {
    let body = "";
    for await (const chunk of request) body += chunk;
    if (request.url === "/observation") observation = JSON.parse(body);
    if (request.url === "/environment") environment = JSON.parse(body);
    return response.end("{}");
  }
  return response.end(
    `<html><body><button id="wrong">Cancel</button><button id="save">Save</button><button id="save2">Save</button><button style="display:none" id="hidden">Hidden</button><iframe src="/frame"></iframe>${script}</body></html>`,
  );
}).listen(8090, "0.0.0.0");

async function request(path, body) {
  const response = await fetch(`${adapter}/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(65000),
  });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  return result;
}

async function waitFor(get) {
  const deadline = Date.now() + 5000;
  while (!get()) {
    assert.ok(Date.now() < deadline, "fixture observation timed out");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return get();
}

const checks = [];
try {
  await request("prepare", { url: "http://127.0.0.1:8090" });
  await waitFor(() => environment);
  assert.deepEqual([environment.width, environment.height], [1279, 799]);
  assert.deepEqual(environment.languages, ["en-US", "en"]);
  for (const check of [
    { name: "singleton", elements: [{ label: "Save", role: "button" }], expected: ["save"] },
    {
      name: "wrong-first",
      elements: [{ label: "Cancel" }, { label: "Save" }],
      expected: ["wrong"],
    },
    {
      name: "plural",
      cardinality: "all",
      elements: [{ label: "Save", all: true }],
      expected: ["save", "save2"],
    },
    { name: "frame", elements: [{ label: "Inside", role: "button" }], expected: ["inner"] },
    { name: "hidden", elements: [{ label: "Hidden" }], expected: [] },
    { name: "absent", elements: [{ label: "Missing" }], expected: [] },
    { name: "provider-error", fault: "error", expected: [], status: "error" },
  ]) {
    const result = await request("observe", {
      instruction: "Find requested test elements",
      cardinality: check.cardinality ?? "singleton",
      deterministic: { elements: check.elements, fault: check.fault },
    });
    assert.equal(
      result.status,
      check.status ?? (check.expected.length ? "found" : "empty"),
      JSON.stringify(result),
    );
    assert.equal(result.modelCalls ?? result.providerCalls, 1);
    if (!check.fault) assert.equal(result.metadata.cache.status, "DISABLED");
    observation = undefined;
    command = { targets: result.targets };
    const verified = await waitFor(() => observation);
    assert.deepEqual(verified.matches, check.expected);
    assert.equal(verified.passive, true);
    checks.push({ name: check.name, status: result.status, matches: verified.matches });
  }
  console.log(JSON.stringify({ stagehand: "4.1.0", environment, checks, paidCalls: 0 }, null, 2));
} finally {
  await request("reset", {});
  server.close();
}

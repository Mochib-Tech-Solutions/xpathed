import { createServer } from "node:http";

const runs = new Map();
let providerRequest;
let scenario = "found";
let targetText = "About us";
let targetAction = "click";
let plannedActions = [];
let planComplete = true;
const fixture = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Resolution contract</title>
<body><nav aria-label="Company"><button id="expected-target" data-testid="about-us" data-oracle="expected-target">About us</button></nav>
<script>
let clicks = 0;
const runQuery = '?run=' + encodeURIComponent(new URL(location.href).searchParams.get('run') ?? 'manual');
document.querySelector('button').addEventListener('click', () => clicks++);
const events = {};
for (const name of ['click','input','change','focusin','mouseover','pointerover','scroll']) document.addEventListener(name, () => events[name] = (events[name] ?? 0) + 1, true);
setInterval(async () => {
 const response = await fetch('/oracle' + runQuery);
 const command = await response.json();
 if (!command) return;
 const matches = (command.targets ?? command.xpaths.map(xpath => ({xpath,frameXpaths:[]}))).map(({xpath,frameXpaths}) => {
   let scope = document;
   for (const frameXpath of frameXpaths) scope = scope.evaluate(frameXpath, scope, null, XPathResult.FIRST_ORDERED_NODE_TYPE).singleNodeValue.contentDocument;
   const result = scope.evaluate(xpath, scope, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE);
   return Array.from({length:result.snapshotLength}, (_,i) => result.snapshotItem(i).getAttribute('data-oracle') ?? result.snapshotItem(i).id ?? 'wrong-target');
 });
 await fetch('/observation' + runQuery,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({matches,clicks,scrollY,events})});
}, 50);
</script></body></html>`;

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://resolution-fixture:8090");
    const path = url.pathname;
    const run = url.searchParams.get("run") ?? "manual";
    if (!runs.has(run)) runs.set(run, { oracle: null, observation: null });
    const state = runs.get(run);
    const body = request.method === "POST" ? JSON.parse(await readBody(request)) : null;
    let output;
    if (
      [
        "/fixture",
        "/login",
        "/second",
        "/privacy",
        "/quotes",
        "/oversized",
        "/state",
        "/hidden-only",
        "/offscreen",
        "/batch",
        "/confirmations",
        "/frames",
      ].includes(path)
    ) {
      let html = fixture;
      if (path === "/login")
        html = html.replace(
          /<nav.*?<\/nav>/s,
          `<header><button data-oracle="header-login">Log in</button></header><aside><section aria-label="Get responses tailored to you"><h2>Get responses tailored to you</h2><button data-oracle="sidebar-login">Log in</button></section></aside>`,
        );
      if (path === "/login" && url.searchParams.has("covered"))
        html = html.replace(
          "</aside>",
          `</aside><style>aside{position:fixed;bottom:8px}#cookies{position:fixed;bottom:0;left:0;width:100%;height:64px;background:white;z-index:10}</style><div id="cookies">We use cookies</div>`,
        );
      if (path === "/confirmations")
        html = html.replace(
          /<nav.*?<\/nav>/s,
          `<button>Confirm</button><ul aria-label="Pending requests"><li>Request one <button data-oracle="confirmation-first">Confirm</button></li><li>Request two <button data-oracle="confirmation-second" disabled>Confirm</button></li><li hidden><button>Confirm</button></li></ul>`,
        );
      if (path === "/frames")
        html = html.replace(
          "</nav>",
          `</nav><button>Approval</button><iframe id="employee" title="Employee" src="/frame-outer?run=${encodeURIComponent(run)}" style="width:650px;height:350px"></iframe><footer style="margin-top:1800px"><span data-oracle="footer-help">Help</span></footer>`,
        );
      if (path === "/offscreen")
        html = html.replace(
          "<nav",
          '<p>Scroll down to the target.</p><nav style="margin-top:1600px"',
        );
      if (path === "/batch")
        html = html.replace(
          /<nav.*?<\/nav>/s,
          `<section aria-label="Approvals">
        <button data-oracle="approval-first">Approval</button><button data-oracle="approval-second" disabled>Approval</button>
        <button aria-hidden="true">HIDDEN_APPROVAL</button><label>Notes<input data-oracle="notes" readonly value="PRIVATE_NOTE_VALUE"></label>
        <button>Show details</button><button hidden>Done</button></section>`,
        );
      if (path === "/state")
        html = html
          .replace(
            'id="expected-target"',
            'id="expected-target" disabled aria-labelledby="state-label" aria-label="Wrong label"',
          )
          .replace(
            "</nav>",
            '<span id="state-label" hidden>About us<input value="PRIVATE_REFERENCE_VALUE"></span><button aria-hidden="true">HIDDEN_DUPLICATE</button></nav>',
          );
      if (path === "/hidden-only")
        html = html.replace('id="expected-target"', 'id="expected-target" aria-hidden="true"');
      if (path === "/second")
        html = html
          .replace(
            'id="expected-target" data-testid="about-us"',
            'id="second-target" data-testid="second-page"',
          )
          .replace(">About us</button>", ">Second page</button>");
      if (path === "/privacy")
        html = html.replace(
          "<script>",
          `<label>Prénom<input value="PRIVATE_INPUT_SENTINEL"></label><label>Notes<textarea>PRIVATE_TEXTAREA_SENTINEL</textarea></label><select aria-label="Country"><option selected>PRIVATE_SELECT_SENTINEL</option></select><div contenteditable aria-label="Editor"><span>PRIVATE_EDITABLE_SENTINEL</span></div><input type="password" aria-label="Password" value="PRIVATE_PASSWORD_SENTINEL"><a href="https://example.test/?secret=PRIVATE_URL_SENTINEL">Help</a><script>document.cookie='private=PRIVATE_COOKIE_SENTINEL';localStorage.setItem('secret','PRIVATE_STORAGE_SENTINEL');</script><script>`,
        );
      if (path === "/quotes")
        html = html
          .replace(
            'id="expected-target" data-testid="about-us"',
            'data-testid="shared" aria-label="L&#39;été &quot;ready&quot;"',
          )
          .replace("</nav>", '<button data-testid="shared">Other</button></nav>');
      if (path === "/oversized")
        html = html.replace("</nav>", "</nav>" + "<button>Extra</button>".repeat(20100));
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(html);
      return;
    }
    if (path === "/frame-outer" || path === "/frame-inner") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(
        path === "/frame-outer"
          ? `<!doctype html><iframe id="payroll" title="Payroll" src="/frame-inner?run=${encodeURIComponent(run)}" style="width:550px;height:250px"></iframe>`
          : `<!doctype html><section aria-label="Payroll approvals"><button data-oracle="frame-approval-first">Approval</button><button data-oracle="frame-approval-second" disabled>Approval</button><label>Notes<input data-oracle="frame-notes" readonly value="PRIVATE_FRAME_VALUE"></label></section>`,
      );
      return;
    }
    if (path === "/health") output = { ready: true };
    else if (path === "/oracle") {
      if (request.method === "POST") {
        state.oracle = body;
        state.observation = null;
        output = { ok: true };
      } else {
        output = state.oracle;
        state.oracle = null;
      }
    } else if (path === "/observation") {
      if (request.method === "POST") state.observation = body;
      output = state.observation;
    } else if (path === "/provider-request") output = providerRequest ?? null;
    else if (path === "/scenario") {
      scenario = body.name;
      targetText = body.targetText ?? "About us";
      targetAction = body.action ?? "click";
      plannedActions = body.actions ?? [];
      planComplete = body.complete ?? true;
      providerRequest = null;
      output = { ok: true };
    } else if (path === "/api/v1/models/deepseek/deepseek-v4.1-flash/endpoints") {
      output = {
        data: {
          endpoints: [
            {
              provider_name: "Wafer",
              pricing: { prompt: "0.0000000749", completion: "0.00000044" },
            },
          ],
        },
      };
    } else if (path === "/api/v1/chat/completions") {
      providerRequest = body;
      const input = JSON.parse(body.messages.find((message) => message.role === "user").content);
      const candidates = input.capture?.candidates ?? input.candidates;
      const target = candidates.find(
        (candidate) =>
          candidate.tag === "button" &&
          (candidate.text === targetText || candidate.label === targetText),
      );
      if (!target && scenario !== "absent" && scenario !== "batch")
        throw new Error("Independent fixture target absent from provider input");
      output = {
        id: "deterministic-fixture",
        model: "deepseek/deepseek-v4.1-flash",
        provider: "Wafer",
        choices: [
          {
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: JSON.stringify(
                scenario === "batch"
                  ? {
                      complete: planComplete,
                      actions: plannedActions.map((item) => ({
                        step: item.step,
                        instruction: item.instruction,
                        action: item.action,
                        outcome: item.outcome,
                        candidateId:
                          item.outcome === "found"
                            ? (item.candidateId ??
                              candidates.filter(
                                (candidate) =>
                                  (!item.tag || candidate.tag === item.tag) &&
                                  (!item.scope || candidate.scope?.includes(item.scope)) &&
                                  (!item.frameLabel ||
                                    candidate.frame?.labels.includes(item.frameLabel)) &&
                                  (candidate.label === item.label || candidate.text === item.label),
                              )[item.index ?? 0]?.id ??
                              null)
                            : null,
                        limitation: item.limitation ?? "none",
                      })),
                    }
                  : {
                      complete: true,
                      actions: [
                        {
                          step: 1,
                          instruction: `${targetAction} ${targetText}`,
                          action: targetAction,
                          outcome: scenario === "absent" ? "not_found" : "found",
                          candidateId:
                            scenario === "absent"
                              ? null
                              : scenario === "unknown"
                                ? "fabricated-id"
                                : target.id,
                          limitation: "none",
                        },
                      ],
                    },
              ),
            },
          },
        ],
        usage: { prompt_tokens: 150, completion_tokens: 25, total_tokens: 175 },
      };
    } else {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(output));
  } catch (error) {
    response.writeHead(500, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: error.message }));
  }
});
async function readBody(request) {
  let text = "";
  for await (const chunk of request) {
    text += chunk;
    if (text.length > 1024 * 1024) throw new Error("Request too large");
  }
  return text || "null";
}
server.listen(8090, "0.0.0.0");

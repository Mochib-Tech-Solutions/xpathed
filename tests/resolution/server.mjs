import { createServer } from "node:http";

const runs = new Map();
let providerRequest;
let scenario = "found";
const fixture = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Resolution contract</title>
<body><nav aria-label="Company"><button id="expected-target" data-testid="about-us" data-oracle="expected-target">About us</button></nav>
<script>
let clicks = 0;
const runQuery = '?run=' + encodeURIComponent(new URL(location.href).searchParams.get('run') ?? 'manual');
document.querySelector('button').addEventListener('click', () => clicks++);
setInterval(async () => {
 const response = await fetch('/oracle' + runQuery);
 const command = await response.json();
 if (!command) return;
 const matches = command.xpaths.map(xpath => {
   const result = document.evaluate(xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE);
   return Array.from({length:result.snapshotLength}, (_,i) => result.snapshotItem(i) === document.querySelector('[data-oracle=expected-target]') ? 'expected-target' : 'wrong-target');
 });
 await fetch('/observation' + runQuery,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({matches,clicks,scrollY})});
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
    if (["/fixture", "/privacy", "/quotes", "/oversized"].includes(path)) {
      let html = fixture;
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
        html = html.replace("</nav>", "</nav>" + "<button>Extra</button>".repeat(2100));
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(html);
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
      providerRequest = null;
      output = { ok: true };
    } else if (path === "/api/v1/chat/completions") {
      providerRequest = body;
      const input = JSON.parse(body.messages.find((message) => message.role === "user").content);
      const candidates = input.capture?.candidates ?? input.candidates;
      const target = candidates.find(
        (candidate) =>
          candidate.tag === "button" &&
          (candidate.text === "About us" || candidate.label === "About us"),
      );
      if (!target) throw new Error("Independent fixture target absent from provider input");
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
                scenario === "absent"
                  ? { outcome: "not_found", action: "click", candidateId: null }
                  : {
                      outcome: "found",
                      action: "click",
                      candidateId: scenario === "unknown" ? "fabricated-id" : target.id,
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

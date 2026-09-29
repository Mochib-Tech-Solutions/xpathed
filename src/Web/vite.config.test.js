import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import test from "node:test";
import { createServer } from "vite";

test("dev proxy rewrites same-origin requests and preserves foreign origins", async (t) => {
  const origins = [];
  const upstream = http.createServer((request, response) => {
    origins.push(request.headers.origin);
    response.end("ok");
  });
  const browser = http.createServer();
  browser.on("upgrade", (request, socket) => {
    origins.push(request.headers.origin);
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  browser.listen(0, "127.0.0.1");
  await once(browser, "listening");
  t.after(() => new Promise((resolve) => browser.close(resolve)));

  const target = `http://127.0.0.1:${upstream.address().port}`;
  const browserTarget = `http://127.0.0.1:${browser.address().port}`;
  const previousUrl = process.env.XPATHED_URL;
  const previousBrowserUrl = process.env.XPATHED_BROWSER_URL;
  process.env.XPATHED_URL = target;
  process.env.XPATHED_BROWSER_URL = browserTarget;
  t.after(() => {
    if (previousUrl === undefined) delete process.env.XPATHED_URL;
    else process.env.XPATHED_URL = previousUrl;
    if (previousBrowserUrl === undefined) delete process.env.XPATHED_BROWSER_URL;
    else process.env.XPATHED_BROWSER_URL = previousBrowserUrl;
  });
  const { default: config } = await import("./vite.config.js");
  const server = await createServer({
    ...config,
    configFile: false,
    server: { ...config.server, port: 0 },
  });
  await server.listen();
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;

  for (const path of ["/api/sessions", "/view/session"]) {
    for (const source of [origin, "https://untrusted.example"]) {
      const response = await new Promise((resolve, reject) => {
        const request = http.get(`${origin}${path}`, {
          headers: {
            Origin: source,
            ...(path.startsWith("/view") ? { Connection: "Upgrade", Upgrade: "websocket" } : {}),
          },
        });
        request.on("response", resolve);
        request.on("error", reject);
      });
      response.resume();
      await once(response, "end");
      const destination = path.startsWith("/view") ? browserTarget : target;
      assert.equal(origins.at(-1), source === origin ? destination : source);
    }
  }
});

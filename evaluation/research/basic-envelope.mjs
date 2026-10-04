import { createServer, request } from "node:http";
import { pathToFileURL } from "node:url";

export function basicRequest(value) {
  if (value.contractVersion !== undefined && value.contractVersion !== "4")
    throw new Error("Conflicting Basic contract selector");
  return { ...value, contractVersion: "4" };
}

const backend = new URL(process.env.BASIC_BACKEND_URL ?? "http://resolver-basic-native:8080");
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  createServer(async (req, res) => {
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 65536) throw new Error("Request exceeds adapter budget");
        chunks.push(chunk);
      }
      let body = Buffer.concat(chunks);
      if (req.method === "POST" && /^\/(?:internal\/)?pages\/[^/]+\/resolve$/.test(req.url)) {
        const value = JSON.parse(body);
        body = Buffer.from(JSON.stringify(basicRequest(value)));
      }
      const headers = { ...req.headers, host: backend.host, "content-length": String(body.length) };
      delete headers["transfer-encoding"];
      const upstream = request(
        new URL(req.url, backend),
        { method: req.method, headers },
        (response) => {
          res.writeHead(response.statusCode, response.headers);
          response.pipe(res);
        },
      );
      upstream.on("error", (error) => {
        if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: error.message }));
      });
      res.on("close", () => upstream.destroy());
      upstream.end(body);
    } catch (error) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: error.message }));
    }
  }).listen(8080, "0.0.0.0");

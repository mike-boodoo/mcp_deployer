import http from "node:http";
import { Readable } from "node:stream";
import { URL } from "node:url";
import { handler } from "./mcp-server.mjs";

const HOST = process.env.MCP_HOST || "127.0.0.1";
const PORT = Number(process.env.MCP_PORT || 9191);

async function toRequest(req) {
  const url = new URL(req.url || "/mcp", `http://${req.headers.host || `${HOST}:${PORT}`}`);
  let body;
  if (req.method !== "GET" && req.method !== "HEAD") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    body = Buffer.concat(chunks);
  }
  return new Request(url, {
    method: req.method,
    headers: req.headers,
    body,
    ...(body ? { duplex: "half" } : {})
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type,mcp-session-id,mcp-protocol-version",
      "access-control-expose-headers": "mcp-session-id,mcp-protocol-version"
    });
    return res.end();
  }
  try {
    const request = await toRequest(req);
    const response = await handler.fetch(request);
    const headers = Object.fromEntries(response.headers.entries());
    headers["access-control-allow-origin"] = "*";
    headers["access-control-expose-headers"] = "mcp-session-id,mcp-protocol-version";
    res.writeHead(response.status, headers);
    if (!response.body) return res.end();
    Readable.fromWeb(response.body).pipe(res);
  } catch (error) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: error.message }));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`MCP connector listening at http://${HOST}:${PORT}/mcp`);
});

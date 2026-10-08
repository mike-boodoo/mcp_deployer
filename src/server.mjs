import http from "node:http";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { URL } from "node:url";
import crypto from "node:crypto";
import { buildManifest, validateManifest, parseDeployDirectives } from "./manifest.mjs";
import { orchestrateText, orchestrateDataset, validatePolicy } from "./orchestrator.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const publicDir = path.join(root, "public");
const generatedDir = path.join(root, "generated");
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";
const REGISTRY = (process.env.MCP_REGISTRY_BASE || "https://registry.modelcontextprotocol.io").replace(/\/$/, "");
const REGISTRY_TOKEN = process.env.MCP_REGISTRY_TOKEN || "";
const authSessions = new Map();
const AUTH_TTL_MS = 15 * 60 * 1000;

function log(level, event, data = {}) {
  const safe = JSON.parse(JSON.stringify(data, (key, value) => {
    if (/token|secret|authorization|devicecode|access_token|github_token|npmrc|password/i.test(key)) return "[REDACTED]";
    if (typeof value === "string" && /Bearer\s+/i.test(value)) return value.replace(/Bearer\s+[^\s]+/gi, "Bearer [REDACTED]");
    return value;
  }));
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, event, ...safe }));
}

function newSessionId() {
  return crypto.randomUUID();
}

function cleanupAuthSessions() {
  const now = Date.now();
  for (const [id, session] of authSessions) {
    if (session.expiresAt <= now) authSessions.delete(id);
  }
}
setInterval(cleanupAuthSessions, 60_000).unref();

await fs.mkdir(generatedDir, { recursive: true });

function json(res, status, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "http://127.0.0.1:8787"
  });
  res.end(payload);
}

async function bodyJson(req) {
  let data = "";
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 2_000_000) throw new Error("Request body too large");
  }
  return JSON.parse(data || "{}");
}

function registryMeta(server) {
  return server?._meta?.["io.modelcontextprotocol.registry/publisher-provided"] || server?.server?._meta?.["io.modelcontextprotocol.registry/publisher-provided"] || {};
}

function filterPeers(servers, searchSpace, focus) {
  const normalizedSpace = String(searchSpace || "").trim().toLowerCase();
  const normalizedFocus = String(focus || "").trim().toLowerCase();
  return (servers || []).filter(item => {
    const meta = registryMeta(item);
    if (!normalizedSpace) return true;
    const spaces = [meta.searchSpace, ...(Array.isArray(meta.searchSpaces) ? meta.searchSpaces : [])]
      .filter(Boolean).map(String).map(s => s.toLowerCase());
    const matchSpace = spaces.includes(normalizedSpace);
    const matchFocus = !normalizedFocus || String(meta.focus || "").toLowerCase().includes(normalizedFocus) || String(item.name || "").toLowerCase().includes(normalizedFocus);
    return matchSpace && matchFocus;
  });
}

async function registryRequest(endpoint, options = {}) {
  log("info", "registry_request_start", { method: options.method || "GET", endpoint });
  const response = await fetch(`${REGISTRY}${endpoint}`, {
    ...options,
    headers: {
      accept: "application/json",
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  log(response.ok ? "info" : "error", "registry_request_end", { method: options.method || "GET", endpoint, status: response.status, statusText: response.statusText, body: data });
  if (!response.ok) {
    const error = new Error(data?.error || `Registry request failed: ${response.status}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

async function publishToRegistry(manifest) {
  if (!REGISTRY_TOKEN) return { published: false, reason: "MCP_REGISTRY_TOKEN is not set; manifest was generated locally." };
  return { published: true, registry: await registryRequest("/v0.1/publish", {
    method: "POST",
    headers: { authorization: `Bearer ${REGISTRY_TOKEN}` },
    body: JSON.stringify(manifest)
  }) };
}

async function startGithubAuth(_req, res) {
  log("info", "github_auth_start");
  let health;
  try {
    health = await fetch(`${REGISTRY}/v0/health`, { headers: { accept: "application/json" }, cache: "no-store" });
  } catch (error) {
    log("error", "registry_health_for_auth_network_error", { message: error.message, cause: error.cause?.message || error.cause?.code || null, name: error.name });
    return json(res, 502, { error: error.message, code: error.cause?.code || "REGISTRY_NETWORK_ERROR", cause: error.cause?.message || null, url: REGISTRY });
  }
  const healthText = await health.text();
  let healthData;
  try { healthData = JSON.parse(healthText); } catch { healthData = {}; }
  log(health.ok ? "info" : "error", "registry_health_for_auth", { status: health.status, statusText: health.statusText, body: healthData });
  if (!health.ok) return json(res, health.status, { error: `Registry health check failed: HTTP ${health.status}`, details: healthData });
  const clientId = healthData.github_client_id;
  if (!clientId) return json(res, 502, { error: "The official MCP Registry did not advertise its GitHub OAuth client id." });

  log("info", "github_device_authorization_request", { clientIdPresent: Boolean(clientId) });
  let deviceResp;
  try {
    deviceResp = await fetch("https://github.com/login/device/code", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ client_id: clientId, scope: "read:user read:org" }),
      cache: "no-store"
    });
  } catch (error) {
    log("error", "github_device_authorization_network_error", { message: error.message, cause: error.cause?.message || error.cause?.code || null, name: error.name });
    return json(res, 502, { error: error.message, code: error.cause?.code || "GITHUB_NETWORK_ERROR", cause: error.cause?.message || null });
  }
  const deviceText = await deviceResp.text();
  let device;
  try { device = JSON.parse(deviceText); } catch { device = {}; }
  log(deviceResp.ok ? "info" : "error", "github_device_authorization_response", { status: deviceResp.status, statusText: deviceResp.statusText, error: device.error || null, errorDescription: device.error_description || null, hasUserCode: Boolean(device.user_code), hasVerificationUri: Boolean(device.verification_uri) });
  if (!deviceResp.ok) return json(res, deviceResp.status, { error: device.error_description || device.error || "GitHub device authorization failed" });

  const sessionId = newSessionId();
  const session = { id: sessionId, clientId, deviceCode: device.device_code, userCode: device.user_code, verificationUri: device.verification_uri, verificationUriComplete: device.verification_uri_complete, expiresAt: Date.now() + Math.min(AUTH_TTL_MS, (device.expires_in || 900) * 1000), intervalMs: Math.max(5000, (device.interval || 5) * 1000), state: "pending" };
  authSessions.set(sessionId, session);
  pollGithubAuth(session).catch(error => { session.state = "error"; session.error = error.message; log("error", "github_auth_session_failed", { sessionId, message: error.message, cause: error.cause?.message || error.cause?.code || null, name: error.name }); });

  json(res, 200, { sessionId, state: session.state, verificationUri: session.verificationUri, verificationUriComplete: session.verificationUriComplete, userCode: session.userCode, expiresIn: Math.max(0, Math.floor((session.expiresAt - Date.now()) / 1000)) });
}

async function pollGithubAuth(session) {
  log("info", "github_auth_poll_started", { sessionId: session.id });
  while (Date.now() < session.expiresAt) {
    await new Promise(r => setTimeout(r, session.intervalMs));
    let tokenResp;
    try {
      tokenResp = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ client_id: session.clientId, device_code: session.deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }),
        cache: "no-store"
      });
    } catch (error) {
      log("error", "github_token_poll_network_error", { sessionId: session.id, message: error.message, cause: error.cause?.message || error.cause?.code || null, name: error.name });
      throw new Error(`GitHub token polling failed: ${error.message}`);
    }
    const text = await tokenResp.text();
    let data;
    try { data = JSON.parse(text); } catch { data = {}; }
    log("info", "github_token_poll_response", { sessionId: session.id, status: tokenResp.status, error: data.error || null });
    if (data.access_token) {
      log("info", "registry_github_token_exchange_start", { sessionId: session.id });
      let rr;
      try {
        rr = await fetch(`${REGISTRY}/v0/auth/github-at`, {
          method: "POST",
          headers: { accept: "application/json", "content-type": "application/json" },
          body: JSON.stringify({ github_token: data.access_token }),
          cache: "no-store"
        });
      } catch (error) {
        log("error", "registry_github_token_exchange_network_error", { sessionId: session.id, message: error.message, cause: error.cause?.message || error.cause?.code || null, name: error.name });
        throw new Error(`Registry token exchange failed: ${error.message}`);
      }
      const rt = await rr.text();
      let rd;
      try { rd = JSON.parse(rt); } catch { rd = {}; }
      log(rr.ok && Boolean(rd.registry_token) ? "info" : "error", "registry_github_token_exchange_end", { sessionId: session.id, status: rr.status, statusText: rr.statusText, error: rd.error || rd.error_description || null, tokenIssued: Boolean(rd.registry_token) });
      if (!rr.ok || !rd.registry_token) {
        throw new Error(rd.error_description || rd.error || `Registry token exchange failed: HTTP ${rr.status}`);
      }
      let login = null;
      try {
        const ur = await fetch("https://api.github.com/user", { headers: { authorization: `Bearer ${data.access_token}`, accept: "application/vnd.github+json" } });
        if (ur.ok) { const ud = await ur.json(); login = ud.login || null; }
      } catch {}
      session.state = "authenticated";
      session.authenticatedAt = new Date().toISOString();
      session.registryToken = rd.registry_token;
      session.githubLogin = login;
      log("info", "registry_login_authenticated", { sessionId: session.id, githubLogin: login });
      return;
    }
    if (data.error === "authorization_pending") continue;
    if (data.error === "slow_down") { session.intervalMs += 5000; continue; }
    if (data.error === "expired_token") throw new Error("GitHub device authorization expired. Start login again.");
    if (data.error === "access_denied") throw new Error("GitHub authorization was denied.");
    throw new Error(data.error_description || data.error || "GitHub device authorization failed");
  }
  throw new Error("GitHub device authorization timed out. Start login again.");
}

async function githubAuthStatus(req, res, url) {
  const id = url.searchParams.get("sessionId");
  const session = id && authSessions.get(id);
  if (!session) return json(res, 404, { error: "Login session not found or expired." });
  const payload = { state: session.state, githubLogin: session.githubLogin || null };
  if (session.state === "authenticated") payload.authenticatedAt = session.authenticatedAt || null;
  if (session.state === "error") payload.error = session.error || "Login failed.";
  json(res, 200, payload);
}

async function registryProxy(req, res) {
  log("info", "registry_publish_proxy_start");
  const body = await bodyJson(req);
  const session = body.sessionId && authSessions.get(body.sessionId);
  if (!session || session.state !== "authenticated" || !session.registryToken) {
    log("warn", "registry_publish_requires_login", { hasSession: Boolean(session), state: session?.state || "missing" });
    return json(res, 401, { error: "Registry login required.", code: "REGISTRY_AUTH_REQUIRED" });
  }
  try {
    const response = await fetch(`${REGISTRY}/v0.1/publish`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", authorization: `Bearer ${session.registryToken}` },
      body: JSON.stringify(body.manifest || {})
    });
    const text = await response.text();
    let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
    log(response.ok ? "info" : "error", "registry_publish_proxy_end", { status: response.status, statusText: response.statusText, body: data });
    res.writeHead(response.status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify({ status: response.status, statusText: response.statusText, ok: response.ok, body: data }, null, 2));
  } catch (error) {
    log("error", "registry_publish_proxy_network_error", { message: error.message, cause: error.cause?.message || error.cause?.code || null, name: error.name });
    return json(res, 502, { ok: false, status: 502, statusText: "Bad Gateway", error: error.message, code: error.cause?.code || "REGISTRY_NETWORK_ERROR", cause: error.cause?.message || null });
  }
}

const routes = {
  async authGithubStart(req, res) { return startGithubAuth(req, res); },
  async authGithubStatus(req, res, url) { return githubAuthStatus(req, res, url); },
  async registryPublish(req, res) { return registryProxy(req, res); },
  async registryHealth(_req, res) {
    try {
      const response = await fetch(`${REGISTRY}/v0/health`, { headers: { accept: "application/json" }, cache: "no-store" });
      const text = await response.text(); let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
      log(response.ok ? "info" : "error", "registry_health_check", { status: response.status, statusText: response.statusText, body: data });
      json(res, response.ok ? 200 : response.status, { ok: response.ok, status: response.status, url: REGISTRY, githubClientId: Boolean(data?.github_client_id), ...data });
    } catch (error) {
      log("error", "registry_health_network_error", { message: error.message, cause: error.cause?.message || error.cause?.code || null, name: error.name });
      json(res, 502, { ok: false, error: error.message, code: error.cause?.code || "REGISTRY_NETWORK_ERROR", cause: error.cause?.message || null, url: REGISTRY });
    }
  },
  async npmWhoami(req, res) {
    const body = await bodyJson(req);
    const token = String(body.token || "").trim();
    if (!token) { log("warn", "npm_whoami_missing_token"); return json(res, 400, { error: "npm credential is required.", code: "NPM_AUTH_REQUIRED" }); }
    try {
      const response = await fetch("https://registry.npmjs.org/-/whoami", { headers: { authorization: `Bearer ${token}`, accept: "application/json" }, cache: "no-store" });
      const text = await response.text(); let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
      log(response.ok ? "info" : "error", "npm_whoami_response", { status: response.status, statusText: response.statusText, body: data });
      if (!response.ok || !data?.username) return json(res, response.status || 401, { error: data?.error || data?.message || `npm authentication failed: HTTP ${response.status}`, code: "NPM_AUTH_FAILED", details: data });
      json(res, 200, { ok: true, username: data.username });
    } catch (error) {
      log("error", "npm_whoami_network_error", { message: error.message, cause: error.cause?.message || error.cause?.code || null, name: error.name });
      json(res, 502, { error: error.message, code: error.cause?.code || "NPM_NETWORK_ERROR", cause: error.cause?.message || null });
    }
  },
  async config(_req, res) {
    json(res, 200, { registry: REGISTRY, publishingEnabled: Boolean(REGISTRY_TOKEN), port: PORT, host: HOST });
  },
  async peers(req, res, url) {
    const searchSpace = url.searchParams.get("searchSpace") || "";
    const focus = url.searchParams.get("focus") || "";
    const query = new URLSearchParams({ limit: "100" });
    if (searchSpace) query.set("search", searchSpace);
    const data = await registryRequest(`/v0.1/servers?${query.toString()}`);
    const servers = filterPeers(data.servers || [], searchSpace, focus);
    json(res, 200, { searchSpace, focus, count: servers.length, servers, metadata: data.metadata || null });
  },
  async server(req, res, url) {
    const name = url.searchParams.get("name");
    if (!name) return json(res, 400, { error: "name is required" });
    const encoded = encodeURIComponent(name);
    const data = await registryRequest(`/v0.1/servers/${encoded}/versions/latest`);
    json(res, 200, data);
  },
  async validate(req, res) {
    const body = await bodyJson(req);
    const manifest = body.manifest || buildManifest(body);
    const result = validateManifest(manifest);
    json(res, result.valid ? 200 : 400, { ...result, manifest, directives: parseDeployDirectives(body.code || "") });
  },
  async deploy(req, res) {
    const body = await bodyJson(req);
    const manifest = body.manifest || buildManifest(body);
    const validation = validateManifest(manifest);
    if (!validation.valid) return json(res, 400, { ...validation, manifest });
    if (body.publish && !(Array.isArray(manifest.remotes) && manifest.remotes.length) && !(Array.isArray(manifest.packages) && manifest.packages.length)) {
      return json(res, 400, {
        valid: false,
        issues: ["A Registry publication needs a real MCP package or remote endpoint. Provide the public MCP endpoint for this generic connector."],
        manifest
      });
    }
    await fs.writeFile(path.join(generatedDir, "server.json"), JSON.stringify(manifest, null, 2));
    await fs.writeFile(path.join(generatedDir, "deployer.code"), String(body.code || ""));
    if (body.publish) {
      try {
        const result = await publishToRegistry(manifest);
        return json(res, 200, { ...result, validation, manifest });
      } catch (error) {
        return json(res, error.status || 502, { published: false, error: error.message, details: error.data || null, validation, manifest });
      }
    }
    json(res, 200, { published: false, validation, manifest, saved: "generated/server.json" });
  },
  async orchestrate(req, res) {
    const body = await bodyJson(req);
    const validation = validatePolicy(body.policy || {});
    if (!validation.valid) return json(res, 400, validation);
    if (body.mode === "pre") {
      const output = orchestrateDataset(body.items || [], validation.policy);
      return json(res, 200, { mode: "pre", count: output.length, items: output, policy: validation.policy });
    }
    const result = orchestrateText(body.text || "", validation.policy);
    json(res, 200, { mode: "post", ...result, policy: validation.policy });
  },
  async hostResponse(req, res) {
    const body = await bodyJson(req);
    const result = orchestrateText(body.response || "", body.policy || {});
    json(res, 200, { ...result, source: "host-response-adapter" });
  }
};

const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8" };

async function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";
  const file = path.normalize(path.join(publicDir, pathname));
  if (!file.startsWith(publicDir)) return json(res, 403, { error: "Forbidden" });
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) throw new Error("not file");
    const stream = createReadStream(file);
    stream.once("error", error => {
      log("error", "static_file_stream_error", { path: file, message: error.message });
      if (!res.headersSent && !res.writableEnded) {
        json(res, 500, { error: "Failed to read static asset" });
      }
    });
    res.writeHead(200, { "content-type": mime[path.extname(file)] || "application/octet-stream" });
    stream.pipe(res);
  } catch {
    if (!res.headersSent && !res.writableEnded) {
      json(res, 404, { error: "Not found" });
    }
  }
}

const server = http.createServer(async (req, res) => {
  const requestId = crypto.randomUUID();
  res.setHeader("x-request-id", requestId);
  log("info", "http_request", { requestId, method: req.method, url: req.url });
  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "content-type,authorization" });
      return res.end();
    }
    const url = new URL(req.url || "/", `http://${req.headers.host || `${HOST}:${PORT}`}`);
    if (url.pathname.startsWith("/api/")) {
      const key = url.pathname.slice(5);
      const route = routes[key];
      if (!route) return json(res, 404, { error: "Unknown API route" });
      if (req.method === "GET" && ["config", "registryHealth", "peers", "server", "authGithubStatus"].includes(key)) return await route(req, res, url);
      if (req.method === "POST" && ["validate", "deploy", "orchestrate", "hostResponse", "authGithubStart", "registryPublish", "npmWhoami"].includes(key)) return await route(req, res, url);
      return json(res, 405, { error: "Method not allowed" });
    }
    return serveStatic(req, res, url);
  } catch (error) {
    log("error", "http_request_error", { requestId, method: req.method, url: req.url, message: error.message, stack: error.stack });
    json(res, 500, { error: error.message, code: "INTERNAL_ERROR", requestId });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`MCP Search-Space Deployer: http://${HOST}:${PORT}`);
  console.log(`Registry discovery: ${REGISTRY}/v0.1/servers`);
  console.log(`Registry publishing: ${REGISTRY_TOKEN ? "enabled" : "disabled (set MCP_REGISTRY_TOKEN)"}`);
});

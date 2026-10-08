import fs from "node:fs/promises";
import path from "node:path";
import { buildManifest } from "./manifest.mjs";

const root = new URL("../", import.meta.url).pathname;
const input = {
  name: process.env.MCP_DEPLOY_NAME || "io.github.example/focus-weaver",
  deployName: process.env.MCP_DEPLOY_NAME || "focus-weaver",
  searchSpace: process.env.MCP_SEARCH_SPACE || "public-focus",
  focus: process.env.MCP_FOCUS || "response-orchestration",
  endpoint: process.env.MCP_ENDPOINT || "https://example.invalid/mcp"
};
const manifest = buildManifest(input);
await fs.writeFile(path.join(root, "generated", "server.json"), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify(manifest, null, 2));

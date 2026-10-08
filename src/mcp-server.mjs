import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { orchestrateText, validatePolicy } from "./orchestrator.mjs";

const name = process.env.MCP_DEPLOY_NAME || "io.github.example/focus-weaver";
const searchSpace = process.env.MCP_SEARCH_SPACE || "public-focus";
const focus = process.env.MCP_FOCUS || "response-orchestration";

export function buildMcpServer() {
  const server = new McpServer({ name, version: "0.1.0" });

  server.registerTool("deployer_profile", {
    description: "Return the named deployer identity and shared search-space focus.",
    inputSchema: z.object({})
  }, async () => ({ content: [{ type: "text", text: JSON.stringify({ name, searchSpace, focus, protocol: "named-search-space-orchestrator/v1" }, null, 2) }] }));

  server.registerTool("orchestrate_response", {
    description: "Post-response orchestration: apply search-space policy to a host chatbot response.",
    inputSchema: z.object({
      text: z.string(),
      policy: z.record(z.string(), z.any()).optional()
    })
  }, async ({ text, policy }) => {
    const validation = validatePolicy(policy || {});
    if (!validation.valid) return { isError: true, content: [{ type: "text", text: validation.issues.join("\n") }] };
    const result = orchestrateText(text, validation.policy);
    return { content: [{ type: "text", text: JSON.stringify({ searchSpace, focus, ...result }, null, 2) }] };
  });

  server.registerTool("invocation_hint", {
    description: "Generate a chatbot-facing invocation phrase that names this deployer and search-space.",
    inputSchema: z.object({ request: z.string().optional() })
  }, async ({ request }) => ({
    content: [{ type: "text", text: `Use MCP server ${name}; search-space:${searchSpace}; focus:${focus}${request ? `; request:${request}` : ""}` }]
  }));

  return server;
}

// Web-standard MCP handler for hosts that embed this module.
export const handler = createMcpHandler(() => buildMcpServer());

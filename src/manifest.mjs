const SCHEMA = "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json";
const META = "io.modelcontextprotocol.registry/publisher-provided";

export function parseDeployDirectives(code) {
  const metadata = {};
  for (const line of String(code).split(/\r?\n/)) {
    const match = line.match(/^\s*\/\/\s*MCP_DEPLOYER\s+([A-Z_]+)\s*:\s*(.*?)\s*$/i);
    if (!match) continue;
    metadata[match[1].toLowerCase()] = match[2];
  }
  return metadata;
}

export function slugify(value) {
  return String(value || "focus-weaver")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "focus-weaver";
}

export function buildManifest(input) {
  const name = String(input.name || "io.github.example/focus-weaver").trim();
  const description = String(input.description || "Named search-space response orchestrator").trim().slice(0, 100);
  const version = String(input.version || "0.1.0").trim();
  const title = String(input.title || input.deployName || name.split("/").pop()).trim().slice(0, 100);
  const searchSpace = String(input.searchSpace || "public-focus").trim();
  const deployName = String(input.deployName || title).trim();
  const focus = String(input.focus || "response-orchestration").trim();
  const endpoint = String(input.endpoint || "").trim();

  const manifest = {
    $schema: SCHEMA,
    name,
    title,
    description,
    version,
    websiteUrl: input.websiteUrl || undefined,
    repository: input.repositoryUrl ? { url: input.repositoryUrl, source: "github" } : undefined,
    ...(endpoint ? { remotes: [{ type: "streamable-http", url: endpoint }] } : {}),
    _meta: {
      [META]: {
        deployerProtocol: "named-search-space-orchestrator/v1",
        deployName,
        searchSpace,
        focus,
        stage: input.stage || "post",
        visibility: input.visibility || "public",
        peerDiscovery: "registry",
        invocation: `Use MCP server ${name} and focus on search-space:${searchSpace}`,
        generatedAt: new Date().toISOString()
      }
    }
  };

  for (const key of ["websiteUrl", "repository"]) if (!manifest[key]) delete manifest[key];
  return manifest;
}

export function validateManifest(manifest) {
  const issues = [];
  if (!/^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/.test(manifest?.name || "")) issues.push("name must use namespace/server-name format");
  if (!manifest?.description || manifest.description.length > 100) issues.push("description is required and must be <= 100 characters");
  if (!manifest?.version || /[<>=^~*xX]/.test(manifest.version)) issues.push("version must be a concrete version string");
  const meta = manifest?._meta?.[META];
  if (!meta?.searchSpace) issues.push("publisher metadata must contain searchSpace");
  if (manifest?.remotes) {
    for (const remote of manifest.remotes) {
      if (remote.type !== "streamable-http" && remote.type !== "sse") issues.push("remote type must be streamable-http or sse");
      if (!/^https?:\/\/\S+$/.test(remote.url || "")) issues.push("remote URL must be http(s)");
    }
  }
  return { valid: issues.length === 0, issues };
}

export { SCHEMA, META };

const $ = (id) => document.getElementById(id);
const metaKey = "io.modelcontextprotocol.registry/publisher-provided";

const sampleCode = `// MCP_DEPLOYER NAME: io.github.example/focus-weaver\n// MCP_DEPLOYER DEPLOY_NAME: focus-weaver\n// MCP_DEPLOYER SEARCH_SPACE: public-focus\n// MCP_DEPLOYER FOCUS: response-orchestration\n// MCP_DEPLOYER STAGE: post\n// MCP_DEPLOYER VISIBILITY: public\n\nexport const connector = {\n  protocol: "named-search-space-orchestrator/v1",\n  registry: "https://registry.modelcontextprotocol.io",\n  searchSpace: "public-focus",\n\n  // This is the identity a host chatbot can be told to invoke.\n  invocation: "Use MCP server io.github.example/focus-weaver; focus on search-space:public-focus",\n\n  // Policy implementation belongs here; the HTML app previews the same policy.\n  orchestrate(response) {\n    return response\n      .split("\\n")\n      .filter(line => !line.trimStart().startsWith("SYSTEM:"))\n      .filter(line => !line.trimStart().startsWith("INTERNAL:"))\n      .join("\\n");\n  }\n};`;

function values() {
  return {
    name: $("name").value.trim(),
    deployName: $("deployName").value.trim(),
    searchSpace: $("searchSpace").value.trim(),
    focus: $("focus").value.trim(),
    version: $("version").value.trim(),
    stage: $("stage").value,
    endpoint: $("endpoint").value.trim(),
    visibility: $("visibility").value
  };
}

function loadCode() { if (!$("code").value) $("code").value = sampleCode; }
function updateLines() {
  const count = $("code").value.split("\n").length;
  $("lineNumbers").textContent = Array.from({length: count}, (_, i) => String(i + 1)).join("\n");
}
function syncCode() {
  const v = values();
  const code = $("code").value.split("\n");
  const keys = { name: v.name, deploy_name: v.deployName, search_space: v.searchSpace, focus: v.focus, stage: v.stage, visibility: v.visibility };
  const wanted = Object.entries(keys).map(([key, value]) => `// MCP_DEPLOYER ${key.toUpperCase()}: ${value}`);
  const kept = code.filter(line => !/^\s*\/\/\s*MCP_DEPLOYER\s+[A-Z_]+\s*:/i.test(line));
  $("code").value = [...wanted, "", ...kept].join("\n");
  updateLines();
  $("directiveStatus").textContent = "Directives synced into visible code";
}

async function api(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || JSON.stringify(data));
  return data;
}

function manifestFromForm() {
  return {
    ...values(),
    title: values().deployName,
    description: `Named ${values().stage}-response search-space orchestrator`,
    repositoryUrl: "",
    websiteUrl: ""
  };
}

async function generateManifest() {
  const data = await api("/api/validate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ manifest: manifestFromForm(), code: $("code").value }) });
  $("manifestPreview").textContent = JSON.stringify(data.manifest, null, 2);
  return data;
}

function showError(error) { $("statusPill").textContent = `Error: ${error.message}`; }

$("code").addEventListener("input", updateLines);
$("code").addEventListener("scroll", () => { $("lineNumbers").scrollTop = $("code").scrollTop; });
$("applyDirectives").onclick = syncCode;
$("generateManifest").onclick = () => generateManifest().catch(showError);
$("deploy").onclick = async () => {
  try {
    const data = await api("/api/deploy", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...manifestFromForm(), code: $("code").value, publish: false }) });
    $("manifestPreview").textContent = JSON.stringify(data.manifest, null, 2);
    $("statusPill").textContent = "Saved locally";
  } catch (error) { showError(error); }
};
$("publish").onclick = async () => {
  try {
    const data = await api("/api/deploy", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...manifestFromForm(), code: $("code").value, publish: true }) });
    $("manifestPreview").textContent = JSON.stringify(data.manifest, null, 2);
    $("statusPill").textContent = data.published ? "Published" : "Local only";
  } catch (error) { showError(error); }
};

$("findPeers").onclick = async () => {
  const list = $("peerList");
  list.innerHTML = `<div class="empty">Searching the MCP Registry…</div>`;
  try {
    const qs = new URLSearchParams({ searchSpace: $("searchSpace").value.trim(), focus: $("peerFocus").value.trim() });
    const data = await api(`/api/peers?${qs}`);
    if (!data.servers.length) {
      list.innerHTML = `<div class="empty">No registry entries advertise this search space yet. Publish a server with the visible MCP_DEPLOYER metadata first.</div>`;
      return;
    }
    list.innerHTML = data.servers.map(server => {
      const meta = server?._meta?.[metaKey] || server?.server?._meta?.[metaKey] || {};
      return `<article class="peer"><b>${server.name || server.server?.name || "unknown"}</b><span>${server.title || server.server?.title || ""}</span><small>space=${meta.searchSpace || "unclassified"} · focus=${meta.focus || "unspecified"} · deployer=${meta.deployName || "unknown"}</small></article>`;
    }).join("");
  } catch (error) { list.innerHTML = `<div class="empty">${error.message}</div>`; }
};

function policy() {
  return {
    removePrefixes: ["SYSTEM:", "DEVELOPER:", "INTERNAL:"],
    redactPatterns: [
      { pattern: "\\bsk-[A-Za-z0-9_-]{10,}\\b", flags: "g", replacement: "[REDACTED_API_KEY]" },
      { pattern: "\\bBearer\\s+[A-Za-z0-9._~-]{10,}\\b", flags: "gi", replacement: "Bearer [REDACTED_TOKEN]" }
    ],
    maxChars: Number($("maxChars").value) || 20000,
    focusTerms: $("focusTerms").value.split(",").map(s => s.trim()).filter(Boolean)
  };
}

$("runPost").onclick = async () => {
  try {
    const data = await api("/api/orchestrate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "post", text: $("hostResponse").value, policy: policy() }) });
    $("orchestratorOutput").textContent = JSON.stringify(data, null, 2);
  } catch (error) { $("orchestratorOutput").textContent = error.message; }
};

$("runPre").onclick = async () => {
  try {
    const parsed = JSON.parse($("trainingData").value);
    const items = Array.isArray(parsed) ? parsed : String($("trainingData").value).split(/\r?\n/).filter(Boolean).map(JSON.parse);
    const data = await api("/api/orchestrate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "pre", items, policy: policy() }) });
    $("orchestratorOutput").textContent = JSON.stringify(data, null, 2);
  } catch (error) { $("orchestratorOutput").textContent = error.message; }
};

$("copyInvocation").onclick = async () => {
  const v = values();
  const text = `Use MCP server ${v.name}; search-space:${v.searchSpace}; focus:${v.focus}`;
  await navigator.clipboard.writeText(text);
  $("directiveStatus").textContent = "Chatbot invocation copied";
};

loadCode();
updateLines();
syncCode();
generateManifest().catch(() => {});

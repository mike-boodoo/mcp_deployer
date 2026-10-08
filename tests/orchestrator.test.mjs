import test from "node:test";
import assert from "node:assert/strict";
import { orchestrateText, orchestrateDataset, validatePolicy } from "../src/orchestrator.mjs";
import { buildManifest, validateManifest, parseDeployDirectives } from "../src/manifest.mjs";

test("post-response policy removes hidden lines and redacts API tokens", () => {
  const result = orchestrateText("SYSTEM: hidden\nhello sk-1234567890abcdef", {});
  assert.equal(result.output.includes("SYSTEM:"), false);
  assert.equal(result.output.includes("[REDACTED_API_KEY]"), true);
});

test("same orchestrator transforms training dataset", () => {
  const items = orchestrateDataset([{ prompt: "x", completion: "INTERNAL: hidden\nanswer" }]);
  assert.equal(items[0].output, "answer");
});

test("policy validation catches invalid regex", () => {
  assert.equal(validatePolicy({ redactPatterns: [{ pattern: "[", flags: "g" }] }).valid, false);
});

test("manifest carries named search-space metadata", () => {
  const manifest = buildManifest({ name: "io.github.example/demo", searchSpace: "alpha", deployName: "demo" });
  assert.equal(validateManifest(manifest).valid, true);
  assert.equal(manifest._meta["io.modelcontextprotocol.registry/publisher-provided"].searchSpace, "alpha");
});

test("directives parse from visible code", () => {
  const meta = parseDeployDirectives("// MCP_DEPLOYER NAME: io.github.example/demo\n// MCP_DEPLOYER SEARCH_SPACE: alpha");
  assert.equal(meta.name, "io.github.example/demo");
  assert.equal(meta.search_space, "alpha");
});

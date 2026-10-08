import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");

 test("UI contains explicit Registry login control and debug console", () => {
  assert.match(html, /id="registryLoginBtn"/);
  assert.match(html, /Login to MCP Registry/);
  assert.match(html, /id="debugLog"/);
  assert.match(html, /id="registryResponse"/);
});

test("deploy no longer stops at a dead-end registry login-required state", () => {
  assert.match(html, /Deploy requested without Registry session/);
  assert.match(html, /starting Registry login automatically/);
  assert.match(html, /await connectRegistry\(\)/);
});

test("service preflight and real HTTP errors are logged", () => {
  assert.match(html, /api\/registryHealth/);
  assert.match(html, /api\/npmWhoami/);
  assert.match(html, /showHttpDebug\(/);
  assert.match(html, /requestId/);
});

test("UI supports a static GitHub Pages frontend with a configured backend URL", () => {
  assert.match(html, /MCP_DEPLOYER_SERVICE_URL/);
  assert.match(html, /\?service=/);
  assert.match(html, /window\.location\.origin/);
});

test("Registry authentication button element is present and referenced consistently", () => {
  const references = (html.match(/registryLoginBtn/g) || []).length;
  assert.ok(references >= 5);
});

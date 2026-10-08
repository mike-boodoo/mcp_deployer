import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const port = 8788;

test("server serves the HTML UI at / without crashing", async () => {
  const child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1" },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let output = "";
  child.stdout.on("data", chunk => { output += chunk.toString(); });
  child.stderr.on("data", chunk => { output += chunk.toString(); });

  const waitForReady = () => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Server did not start: ${output}`)), 10000);
    const check = () => {
      if (output.includes(`http://127.0.0.1:${port}`)) {
        clearTimeout(timeout);
        resolve();
        return;
      }
      setTimeout(check, 100);
    };
    check();
  });

  try {
    await waitForReady();
    const response = await fetch(`http://127.0.0.1:${port}/`);
    const text = await response.text();
    assert.equal(response.status, 200);
    assert.match(text, /<html/i);
    assert.doesNotMatch(text, /ERR_HTTP_HEADERS_SENT/i);
  } finally {
    child.kill("SIGTERM");
    await new Promise(resolve => child.on("exit", resolve));
  }
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { runCliCapture } from "../cliRun.js";

const NODE = process.execPath;

test("runCliCapture resolves a zero exit with captured stdout/stderr", async () => {
  const res = await runCliCapture(NODE, ["-e", "console.log('hi'); console.error('bo')"]);
  assert.equal(res.code, 0);
  assert.equal(res.stdout.trim(), "hi");
  assert.equal(res.stderr.trim(), "bo");
  assert.equal(res.timedOut, false);
});

test("runCliCapture returns the exit code instead of throwing", async () => {
  const res = await runCliCapture(NODE, ["-e", "process.exit(3)"]);
  assert.equal(res.code, 3);
  assert.equal(res.timedOut, false);
});

test("runCliCapture surfaces a failed spawn as code 1 with a message", async () => {
  const res = await runCliCapture("/nonexistent/portato-binary", ["doctor"]);
  assert.equal(res.code, 1);
  assert.ok(res.stderr.length > 0);
  assert.equal(res.timedOut, false);
});

test("runCliCapture reports a timeout kill", async () => {
  const res = await runCliCapture(NODE, ["-e", "setTimeout(() => {}, 60000)"], 150);
  assert.equal(res.timedOut, true);
  assert.notEqual(res.code, 0);
});

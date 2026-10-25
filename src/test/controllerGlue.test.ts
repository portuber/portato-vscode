// Controller glue test: drives the REAL PortatoController wiring (discovery
// -> client -> SSE -> tree/statusbar/logs) against a fake daemon on a
// temporary unix socket, with vscode aliased to the stub (esbuild.js).
// Hermetic: PORTATO_SOCKET env override short-circuits discovery, so the
// host machine's daemon marker/runtime paths are never consulted.
//
// These tests pin the adopt/teardown lifecycle at the seam the unit tests
// cannot see (constructor surface, context keys, status bar updates, dispose
// ordering). The five scenarios stay deliberately small; anything deeper
// belongs in the pure modules' own suites.

import * as assert from "node:assert/strict";
import { after, before, test } from "node:test";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// vscode -> src/test/vscodeStub.ts through the esbuild alias. The stub's
// shared state is the assertion surface for context keys and UI calls.
import {
  type OutputChannelStub,
  type StatusBarItemStub,
  lastContext,
  resetStub,
  stubState,
} from "./vscodeStub";
import { PortatoController } from "../extension";
import {
  type FakeHandler,
  type FakeDaemon,
  startFakeDaemon,
} from "./fakeDaemon";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const TUBERS = [
  {
    name: "web",
    type: "local",
    local: "localhost:8080",
    remote: "example.com:80",
    state: "connected",
    connected_at: "2026-10-25T10:00:00Z",
  },
  {
    name: "db",
    type: "local",
    local: "localhost:5432",
    remote: "example.com:5432",
    state: "off",
    connected_at: "0001-01-01T00:00:00Z",
  },
];

const ctx: {
  dir: string;
  daemon: FakeDaemon | undefined;
  handler: { fn: FakeHandler };
  controller: PortatoController | undefined;
} = { dir: "", daemon: undefined, handler: { fn: () => {} }, controller: undefined };

function tubersRequests(): number {
  return ctx.daemon!.requests.filter((r) => r.url === "/tubers").length;
}

function eventsRequests(): number {
  return ctx.daemon!.requests.filter((r) => r.url === "/events").length;
}

function bar(): StatusBarItemStub {
  const items = stubState.statusBarItems;
  const item = items[items.length - 1];
  assert.ok(item, "no status bar item was created");
  return item;
}

const happyHandler: FakeHandler = (req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, version: "1.11.0" }));
    return;
  }
  if (req.url === "/tubers") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(TUBERS));
    return;
  }
  if (req.url === "/logs") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("[]");
    return;
  }
  if (req.url === "/events") {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(": connected\n\n");
    res.write("data: {}\n\n");
    return; // never end: the stream stays open
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
};

before(async () => {
  ctx.dir = await fsp.mkdtemp(path.join(os.tmpdir(), "portato-glue-"));
  ctx.handler.fn = happyHandler;
  ctx.daemon = await startFakeDaemon({
    dir: ctx.dir,
    handler: (req, res, body) => ctx.handler.fn(req, res, body),
  });
  process.env.PORTATO_SOCKET = ctx.daemon.socketPath;
});

after(async () => {
  ctx.controller?.dispose();
  await ctx.daemon?.close();
  delete process.env.PORTATO_SOCKET;
  await fsp.rm(ctx.dir, { recursive: true, force: true });
});

test("adopts a live daemon: viewState ok, daemonRunning true, live bar", async () => {
  resetStub();
  const controller = new PortatoController();
  ctx.controller = controller;
  try {
    await controller.connect();
    await sleep(300);

    assert.equal(lastContext("portato:viewState"), "ok");
    assert.equal(lastContext("portato:daemonRunning"), true);
    assert.match(bar().text, /^\$\(plug\) Portato: 1 connected/);
    // initial load + the first SSE frame's debounced refresh
    assert.ok(tubersRequests() >= 2, `tubers fetched ${tubersRequests()} times`);
    assert.equal(eventsRequests(), 1);
  } finally {
    // dispose even when an assert fails: the reconnect poll otherwise
    // re-arms a ref'd timer forever and node --test never exits.
    controller.dispose();
    ctx.controller = undefined;
  }
});

test("dispose tears everything down and a later connect() is a no-op", async () => {
  resetStub();
  const controller = new PortatoController();
  ctx.controller = controller;
  try {
    await controller.connect();
    await sleep(200);
    const item = bar();
    const channels: OutputChannelStub[] = [...stubState.channels];
    const before = tubersRequests();

    controller.dispose();
    assert.equal(item.disposed, true);
    assert.ok(channels.length > 0, "channels were created during connect");
    assert.ok(
      channels.every((c) => c.disposed),
      "every output channel is disposed",
    );

    await controller.connect();
    await sleep(50);
    assert.equal(tubersRequests(), before, "no requests after dispose");
  } finally {
    controller.dispose();
    ctx.controller = undefined;
  }
});

test("a daemon that answers 401 lands in the rejected view state", async () => {
  resetStub();
  ctx.handler.fn = (_req, res) => {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized" }));
  };
  const controller = new PortatoController();
  ctx.controller = controller;
  try {
    await controller.connect();
    await sleep(200);

    assert.equal(lastContext("portato:viewState"), "rejected");
    // 401 means alive: the context key still reports a running daemon.
    assert.equal(lastContext("portato:daemonRunning"), true);
    assert.match(bar().text, /^\$\(key\) Portato: credentials rejected/);
  } finally {
    controller.dispose();
    ctx.handler.fn = happyHandler;
    ctx.controller = undefined;
  }
});

test("no daemon at the socket: stopped state, daemonRunning false", async () => {
  resetStub();
  const socket = process.env.PORTATO_SOCKET;
  process.env.PORTATO_SOCKET = path.join(ctx.dir, "missing.sock");
  const controller = new PortatoController();
  ctx.controller = controller;
  try {
    await controller.connect();
    await sleep(200);

    assert.equal(lastContext("portato:viewState"), "stopped");
    assert.equal(lastContext("portato:daemonRunning"), false);
    assert.match(
      bar().text,
      /^\$\(debug-disconnect\) Portato: daemon not running/,
    );
  } finally {
    controller.dispose();
    process.env.PORTATO_SOCKET = socket;
    ctx.controller = undefined;
  }
});

test("losing the daemon mid-stream flips to stopped after the backoff", async () => {
  resetStub();
  const controller = new PortatoController();
  ctx.controller = controller;
  try {
    await controller.connect();
    await sleep(200);
    assert.equal(lastContext("portato:viewState"), "ok");

    await ctx.daemon!.close();
    // SSE error -> onStreamChange(false) -> reconnect after the ~1s initial
    // backoff -> openStream fails -> showDaemonGone.
    await sleep(1800);

    assert.equal(lastContext("portato:viewState"), "stopped");
    assert.equal(lastContext("portato:daemonRunning"), false);
  } finally {
    controller.dispose();
    ctx.controller = undefined;
  }
});

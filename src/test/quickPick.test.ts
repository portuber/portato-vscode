import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildPickRows } from "../quickPick";
import type { TuberStatus } from "../types";

const S = (over: Partial<TuberStatus>): TuberStatus => ({
  name: "t",
  type: "local",
  local: "127.0.0.1:8080",
  remote: "10.0.0.1:80",
  state: "off",
  connected_at: "0001-01-01T00:00:00Z",
  ...over,
});

const labels = (rows: ReturnType<typeof buildPickRows>): string[] =>
  rows.map((r) => r.label);

describe("buildPickRows daemon section", () => {
  it("daemon down: Start, no Stop/Restart/Add", () => {
    const rows = buildPickRows({ daemonRunning: false, statuses: [] });
    const l = labels(rows);
    assert.ok(l.includes("$(play) Start Daemon"));
    assert.ok(!l.includes("$(debug-stop) Stop Daemon"));
    assert.ok(!l.includes("$(add) Add Tunnel"));
    assert.ok(l.includes("$(output) Show Logs"));
  });

  it("daemon up: Stop, Restart and Add, no Start", () => {
    const rows = buildPickRows({ daemonRunning: true, statuses: [] });
    const l = labels(rows);
    assert.ok(l.includes("$(debug-stop) Stop Daemon"));
    assert.ok(l.includes("$(debug-restart) Restart Daemon"));
    assert.ok(l.includes("$(add) Add Tunnel"));
    assert.ok(!l.includes("$(play) Start Daemon"));
  });

  it("section headers are separators; no Tunnels section without statuses", () => {
    const rows = buildPickRows({ daemonRunning: true, statuses: [] });
    assert.deepEqual(
      rows.filter((r) => r.separator).map((r) => r.label),
      ["Daemon"],
    );
  });
});

describe("buildPickRows tuber rows", () => {
  it("off tunnel toggles enable, others disable", () => {
    const rows = buildPickRows({
      daemonRunning: true,
      statuses: [S({ name: "a", state: "off" }), S({ name: "b", state: "connected" })],
    });
    const a = rows.find((r) => r.label.endsWith(" a"));
    const b = rows.find((r) => r.label.endsWith(" b"));
    assert.ok(a && a.action?.kind === "toggle" && a.action.action === "enable");
    assert.ok(b && b.action?.kind === "toggle" && b.action.action === "disable");
    if (a?.action?.kind === "toggle") assert.equal(a.action.status.name, "a");
    if (b?.action?.kind === "toggle") assert.equal(b.action.status.name, "b");
  });

  it("a tunnel blocked on a prompt opens the prompt instead of toggling", () => {
    const rows = buildPickRows({
      daemonRunning: true,
      statuses: [S({ name: "a", state: "connecting", pending_host: "h" })],
    });
    const a = rows.find((r) => r.label.endsWith(" a"));
    assert.equal(a?.action?.kind, "prompt");
  });

  it("a remembered host key routes to prompt even while redialing (tree parity)", () => {
    // After a host-key accept the daemon clears pending_host while the
    // tuber redials; the tree keeps the row "prompting" via the shared
    // pendingHosts map -- the pick must not offer a disable there.
    const rows = buildPickRows(
      {
        daemonRunning: true,
        statuses: [S({ name: "a", state: "error" })],
      },
      undefined,
    );
    const a = rows.find((r) => r.label.endsWith(" a"));
    assert.equal(a?.action?.kind, "toggle");
    const remembered = buildPickRows({
      daemonRunning: true,
      statuses: [S({ name: "a", state: "error" })],
      isRememberedHost: (name) => name === "a",
    });
    const b = remembered.find((r) => r.label.endsWith(" a"));
    assert.equal(b?.action?.kind, "prompt");
  });

  it("description carries state and endpoint, detail carries the error", () => {
    const rows = buildPickRows({
      daemonRunning: true,
      statuses: [S({ name: "a", state: "error", error: "dial tcp: refused" })],
    });
    const a = rows.find((r) => r.label.endsWith(" a"));
    assert.equal(a?.description, "error -- 127.0.0.1:8080 -> 10.0.0.1:80");
    assert.equal(a?.detail, "Error: dial tcp: refused");
  });

  it("labels carry the state icon as a codicon prefix", () => {
    const rows = buildPickRows({
      daemonRunning: true,
      statuses: [S({ name: "a", state: "connected" })],
    });
    const a = rows.find((r) => r.label.endsWith(" a"));
    assert.ok(a?.label.startsWith("$(circle-filled) "), a?.label);
  });
});

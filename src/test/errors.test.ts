import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AuthEpisode, planPromptError, planTunnelError } from "../errors";
import { HttpError } from "../daemonClient";

// Error-plan mapping: 404 = stale tree item (heals with a refresh),
// 409 = the dial moved on between the prompt offer and the answer.
// AuthEpisode gates the persistent-401 mismatch message: one 401 cycle can
// be a daemon-restart race, two in a row (each cycle re-reads the token
// file) is a genuine mismatch, shown once per episode.

describe("planTunnelError", () => {
  it("404 maps to a stale-item plan", () => {
    const plan = planTunnelError(new HttpError(404, "unknown tuber: web"), "web");
    assert.equal(plan.staleItem, true);
    assert.match(plan.message, /tunnel not found/);
    assert.match(plan.message, /web/);
  });

  it("other statuses keep the daemon message", () => {
    const plan = planTunnelError(new HttpError(500, "persist config: disk full"), "web");
    assert.equal(plan.staleItem, false);
    assert.equal(plan.message, "portato: web: persist config: disk full");
  });

  it("non-HTTP errors stringify", () => {
    const plan = planTunnelError(new Error("ECONNREFUSED"), "web");
    assert.equal(plan.staleItem, false);
    assert.equal(plan.message, "portato: web: ECONNREFUSED");
    assert.equal(planTunnelError("boom", "web").message, "portato: web: boom");
  });

  it("passes the injected translator through", () => {
    const t = (msg: string, ...a: (string | number | boolean)[]): string => {
      let s = `[fr] ${msg}`;
      a.forEach((v, i) => {
        s = s.replaceAll(`{${i}}`, String(v));
      });
      return s;
    };
    const plan = planTunnelError(new HttpError(404, "unknown tuber: web"), "web", t);
    assert.equal(plan.staleItem, true);
    assert.equal(plan.message, "[fr] portato: web: tunnel not found -- the config changed outside VS Code, refreshing");
  });
});

describe("planPromptError", () => {
  it("409 maps to the no-pending message", () => {
    const plan = planPromptError(new HttpError(409, "no pending host key for \"web\""), "web");
    assert.equal(plan.staleItem, false);
    assert.match(plan.message, /no prompt is pending anymore/);
    assert.match(plan.message, /web/);
  });

  it("404 delegates to the tunnel plan (stale item)", () => {
    const plan = planPromptError(new HttpError(404, "unknown tuber: web"), "web");
    assert.equal(plan.staleItem, true);
    assert.match(plan.message, /tunnel not found/);
  });

  it("other errors delegate unchanged", () => {
    const plan = planPromptError(new Error("socket hang up"), "web");
    assert.equal(plan.staleItem, false);
    assert.equal(plan.message, "portato: web: socket hang up");
  });
});

describe("AuthEpisode", () => {
  it("shows only on the second consecutive 401, once per episode", () => {
    const ep = new AuthEpisode();
    assert.equal(ep.record401(), false); // single 401: restart race
    assert.equal(ep.record401(), true); // streak: genuine mismatch
    assert.equal(ep.record401(), false); // already shown
  });

  it("success resets the episode", () => {
    const ep = new AuthEpisode();
    assert.equal(ep.record401(), false);
    ep.recordSuccess();
    assert.equal(ep.record401(), false); // new episode starts fresh
    assert.equal(ep.record401(), true);
  });
});

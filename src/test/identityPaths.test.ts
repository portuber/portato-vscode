import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PortatoConfig, TuberStatus } from "../types";
import { expandTilde, identityCandidates } from "../identityPaths";

const HOME = "/home/u";

function defaults(identity = ""): PortatoConfig["defaults"] {
  return {
    identity,
    known_hosts: "",
    accept_new_hosts: false,
    socks5_user: "",
    socks5_password: "",
    identity_passphrase_store: false,
    ssh_password_store: false,
    log: { max_size_mb: 0, max_age_days: 0, retain: 0 },
  };
}

function status(name: string, pendingPassphrase?: string): TuberStatus {
  return {
    name,
    type: "local",
    local: "127.0.0.1:1",
    remote: "127.0.0.1:2",
    state: "off",
    connected_at: "0001-01-01T00:00:00Z",
    pending_passphrase: pendingPassphrase,
  };
}

function tuber(name: string): PortatoConfig["tubers"][number] {
  return {
    name,
    type: "local",
    local: "127.0.0.1:1",
    remote: "127.0.0.1:2",
    ssh: "u@h:22",
    identity: "",
    enabled: false,
    socks5_user: "",
    socks5_password: "",
  };
}

describe("expandTilde", () => {
  it("expands '~' and '~/...' against home", () => {
    assert.equal(expandTilde("~", HOME), HOME);
    assert.equal(expandTilde("~/", HOME), HOME);
    assert.equal(expandTilde("~/.ssh/id_a", HOME), "/home/u/.ssh/id_a");
  });

  it("normalizes like filepath.Join (.., duplicate separators)", () => {
    assert.equal(expandTilde("~/../keys/id", HOME), "/home/keys/id");
    assert.equal(expandTilde("~/.ssh//id", HOME), "/home/u/.ssh/id");
    assert.equal(expandTilde("~/a/./b", HOME), "/home/u/a/b");
    // Go also accepts a backslash separator; the daemon is unix-only but
    // the mirror is cheap (backslash stays a filename character).
    assert.equal(expandTilde("~\\.ssh\\id_a", HOME), "/home/u/.ssh\\id_a");
  });

  it("leaves other paths untouched", () => {
    assert.equal(expandTilde("", HOME), "");
    assert.equal(expandTilde("/abs/id_a", HOME), "/abs/id_a");
    assert.equal(expandTilde("relative/id_a", HOME), "relative/id_a");
    assert.equal(expandTilde("~other/.ssh/id_a", HOME), "~other/.ssh/id_a");
  });
});

describe("identityCandidates", () => {
  it("leads with the pending path: it is the exact path the dial waits on", () => {
    const cfg: PortatoConfig = {
      defaults: defaults("~/.ssh/id_default"),
      tubers: [{ ...tuber("a"), identity: "~/.ssh/id_a" }],
    };
    // SSHIdentity (json:"-") never reaches /config; the daemon-reported
    // pending passphrase is the only ssh-config signal, and it is exact.
    assert.deepEqual(
      identityCandidates("a", cfg, [status("a", "/home/u/.ssh/from_agent")], HOME),
      [
        { path: "/home/u/.ssh/from_agent" },
        { path: "/home/u/.ssh/id_a" },
      ],
    );
  });

  it("offers the tuber's own expanded identity when set", () => {
    const cfg: PortatoConfig = {
      defaults: defaults("~/.ssh/id_default"),
      tubers: [{ ...tuber("a"), identity: "~/.ssh/id_a" }],
    };
    assert.deepEqual(identityCandidates("a", cfg, [], HOME), [
      { path: "/home/u/.ssh/id_a" },
    ]);
  });

  it("falls back to the default, annotated as shadowable, without a tuber identity", () => {
    const cfg: PortatoConfig = {
      defaults: defaults("~/.ssh/id_default"),
      tubers: [tuber("a")],
    };
    const got = identityCandidates("a", cfg, [], HOME);
    assert.equal(got.length, 1);
    assert.equal(got[0]?.path, "/home/u/.ssh/id_default");
    assert.ok(got[0]?.note); // a per-host IdentityFile may override it
  });

  it("dedupes a pending path that matches the configured identity", () => {
    const cfg: PortatoConfig = {
      defaults: defaults(),
      tubers: [{ ...tuber("a"), identity: "~/.ssh/id_a" }],
    };
    const got = identityCandidates("a", cfg, [status("a", "/home/u/.ssh/id_a")], HOME);
    assert.deepEqual(got, [{ path: "/home/u/.ssh/id_a" }]);
  });

  it("returns an empty list when nothing is known", () => {
    const cfg: PortatoConfig = { defaults: defaults(), tubers: [tuber("a")] };
    assert.deepEqual(identityCandidates("a", cfg, [], HOME), []);
    assert.deepEqual(identityCandidates("ghost", cfg, [], HOME), []);
  });
});

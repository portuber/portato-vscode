import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fsp from "node:fs/promises";
import type * as http from "node:http";
import { DaemonClient } from "../daemonClient";
import type { ConfigTuber, PortatoConfig } from "../types";
import { makeTempDir, startFakeDaemon } from "./fakeDaemon";

// CRUD and identities endpoints against a fake daemon with an in-memory
// config: verifies request shapes (paths, query encoding, full field
// round-trip, absent-vs-false password_auth) independent of the Go daemon.

function fullTuber(name: string): ConfigTuber {
  return {
    name,
    type: "dynamic",
    local: "127.0.0.1:1080",
    remote: "",
    ssh: "u@h:22",
    identity: "/home/u/.ssh/id",
    enabled: true,
    tags: ["work", "eu"],
    jump: "bastion@j:22",
    password_auth: false,
    socks5_user: "su",
    socks5_password: "sp",
  };
}

async function json(res: http.ServerResponse, status: number, body: unknown): Promise<void> {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

describe("DaemonClient CRUD + identities", () => {
  let dir: string;

  before(async () => {
    dir = await makeTempDir();
  });

  after(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it("sends the full tuber body; every field survives the round-trip", async (t) => {
    let captured: unknown;
    const daemon = await startFakeDaemon({
      dir,
      handler: async (req, res, body) => {
        captured = JSON.parse(body);
        await json(res, 200, { status: "added" });
      },
    });
    t.after(async () => {
      await daemon.close();
    });
    const client = await DaemonClient.create(daemon.socketPath);
    t.after(() => client.destroy());
    await client.addTuber(fullTuber("a b/c"));
    // The name with a space and a slash must be URL-safe and the body
    // identical to what the caller passed -- no field may be dropped.
    assert.match(daemon.requests[0]?.url ?? "", /^\/tubers$/);
    assert.deepEqual(captured, fullTuber("a b/c"));
  });

  it("PUT targets the encoded original name and carries the new body", async (t) => {
    let captured: unknown;
    const daemon = await startFakeDaemon({
      dir,
      handler: async (req, res, body) => {
        captured = JSON.parse(body);
        await json(res, 200, { status: "updated" });
      },
    });
    t.after(async () => {
      await daemon.close();
    });
    const client = await DaemonClient.create(daemon.socketPath);
    t.after(() => client.destroy());
    await client.updateTuber("old name", fullTuber("new name"));
    assert.equal(daemon.requests[0]?.method, "PUT");
    assert.match(daemon.requests[0]?.url ?? "", /^\/tubers\/old%20name$/);
    assert.deepEqual(captured, fullTuber("new name"));
  });

  it("absent password_auth is not serialized; false is", async (t) => {
    const bodies: Record<string, unknown>[] = [];
    const daemon = await startFakeDaemon({
      dir,
      handler: async (req, res, body) => {
        bodies.push(JSON.parse(body) as Record<string, unknown>);
        await json(res, 200, { status: "ok" });
      },
    });
    t.after(async () => {
      await daemon.close();
    });
    const client = await DaemonClient.create(daemon.socketPath);
    t.after(() => client.destroy());
    const inherit = fullTuber("inherit");
    delete inherit.password_auth;
    await client.addTuber(inherit);
    await client.addTuber(fullTuber("opted-out"));
    assert.ok(!("password_auth" in (bodies[0] as object)), "absent stays absent");
    assert.equal((bodies[1] as { password_auth?: boolean }).password_auth, false);
  });

  it("delete, move, reload hit their endpoints (delta signed, name encoded)", async (t) => {
    const daemon = await startFakeDaemon({
      dir,
      handler: async (_req, res) => {
        await json(res, 200, { status: "ok" });
      },
    });
    t.after(async () => {
      await daemon.close();
    });
    const client = await DaemonClient.create(daemon.socketPath);
    t.after(() => client.destroy());
    await client.deleteTuber("x y");
    await client.move("x y", -2);
    await client.move("x y", 3);
    await client.reload();
    assert.match(daemon.requests[0]?.url ?? "", /^\/tubers\/x%20y$/);
    assert.equal(daemon.requests[0]?.method, "DELETE");
    assert.match(daemon.requests[1]?.url ?? "", /^\/tubers\/x%20y\/move\?delta=-2$/);
    assert.match(daemon.requests[2]?.url ?? "", /^\/tubers\/x%20y\/move\?delta=3$/);
    assert.equal(daemon.requests[3]?.method, "POST");
    assert.match(daemon.requests[3]?.url ?? "", /^\/reload$/);
  });

  it("identities: body on POST, encoded query on DELETE, 404/500 surfaces", async (t) => {
    const daemon = await startFakeDaemon({
      dir,
      handler: async (req, res) => {
        if (req.url === "/identities" && req.method === "POST") {
          await json(res, 200, { status: "stored" });
          return;
        }
        if (req.url?.startsWith("/identities?path=") && req.method === "DELETE") {
          await json(res, 200, { status: "forgotten" });
          return;
        }
        await json(res, 500, { error: "passphrase storage unavailable" });
      },
    });
    t.after(async () => {
      await daemon.close();
    });
    const client = await DaemonClient.create(daemon.socketPath);
    t.after(() => client.destroy());
    await client.setIdentity("/home/u/.ssh/id", "secret");
    assert.deepEqual(JSON.parse(daemon.requests[0]?.body ?? "{}"), {
      path: "/home/u/.ssh/id",
      passphrase: "secret",
    });
    await client.forgetIdentity("/home/u/.ssh/id");
    // Slashes in the path must be percent-encoded in the query.
    assert.match(daemon.requests[1]?.url ?? "", /^\/identities\?path=%2Fhome%2Fu%2F\.ssh%2Fid$/);
    await assert.rejects(() => client.reload(), /storage unavailable/);
  });

  it("GET /config parses into the typed shape", async (t) => {
    const config: PortatoConfig = {
      defaults: {
        identity: "/home/u/.ssh/id_default",
        known_hosts: "",
        accept_new_hosts: true,
        socks5_user: "du",
        socks5_password: "dp",
        identity_passphrase_store: true,
        password_auth: false,
        ssh_password_store: false,
        update_check: true,
        log: { max_size_mb: 1, max_age_days: 2, retain: 3 },
      },
      tubers: [fullTuber("a")],
    };
    const daemon = await startFakeDaemon({
      dir,
      handler: async (_req, res) => {
        await json(res, 200, config);
      },
    });
    t.after(async () => {
      await daemon.close();
    });
    const client = await DaemonClient.create(daemon.socketPath);
    t.after(() => client.destroy());
    assert.deepEqual(await client.config(), config);
  });
});

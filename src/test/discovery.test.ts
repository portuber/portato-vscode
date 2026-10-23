import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  configHome,
  markerPath,
  overrideSocketPath,
  resolveSocketPath,
  runtimeSocketPath,
  tokenPath,
} from "../discovery";
import { makeTempDir } from "./fakeDaemon";

const ENV_KEYS = ["PORTATO_SOCKET", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR"] as const;

describe("discovery", () => {
  let saved: Record<string, string | undefined>;
  let dir: string;

  beforeEach(async () => {
    saved = {};
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    dir = await makeTempDir();
  });

  afterEach(async () => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it("override: setting wins over env, empty setting falls through", () => {
    process.env["PORTATO_SOCKET"] = "/env/sock";
    assert.equal(overrideSocketPath("/setting/sock"), "/setting/sock");
    assert.equal(overrideSocketPath(""), "/env/sock");
    assert.equal(overrideSocketPath("   "), "/env/sock");
    assert.equal(overrideSocketPath(undefined), "/env/sock");
    delete process.env["PORTATO_SOCKET"];
    assert.equal(overrideSocketPath(undefined), undefined);
  });

  it("configHome: XDG env wins; default is the adrg/xdg per-OS default", () => {
    process.env["XDG_CONFIG_HOME"] = "/tmp/xdgcfg";
    assert.equal(configHome(), "/tmp/xdgcfg");
    delete process.env["XDG_CONFIG_HOME"];
    const home = configHome();
    if (process.platform === "darwin") {
      assert.equal(home, path.join(os.homedir(), "Library", "Application Support"));
    } else {
      assert.equal(home, path.join(os.homedir(), ".config"));
    }
  });

  it("markerPath: <configHome>/portato/daemon.socket", () => {
    process.env["XDG_CONFIG_HOME"] = "/tmp/xdgcfg";
    assert.equal(markerPath(), "/tmp/xdgcfg/portato/daemon.socket");
  });

  it("runtimeSocketPath: darwin honors XDG_STATE_HOME, name is uid-scoped", () => {
    process.env["XDG_STATE_HOME"] = "/tmp/xdgstate";
    const p = runtimeSocketPath();
    if (process.platform === "darwin") {
      assert.equal(p, path.join("/tmp/xdgstate", "portato", `portato-${os.userInfo().uid}.sock`));
    } else {
      // linux: XDG_RUNTIME_DIR wins over tmpdir
      process.env["XDG_RUNTIME_DIR"] = "/tmp/xdgrun";
      assert.equal(runtimeSocketPath(), path.join("/tmp/xdgrun", `portato-${os.userInfo().uid}.sock`));
    }
  });

  it("tokenPath: portato.token next to the socket", () => {
    assert.equal(tokenPath("/a/b/daemon.sock"), path.join("/a/b", "portato.token"));
  });

  it("resolveSocketPath: override wins outright without probing", async () => {
    process.env["PORTATO_SOCKET"] = "/env/sock";
    let probed = 0;
    const got = await resolveSocketPath(async () => {
      probed++;
      return false;
    });
    assert.equal(got, "/env/sock");
    assert.equal(probed, 0);
  });

  it("resolveSocketPath: live marker socket wins over runtime", async () => {
    process.env["XDG_CONFIG_HOME"] = dir;
    const markerSocket = path.join(dir, "marker.sock");
    await fsp.mkdir(path.dirname(markerPath()), { recursive: true });
    await fsp.writeFile(markerPath(), JSON.stringify({ socket: markerSocket, pid: 4242 }));
    const probed: string[] = [];
    const got = await resolveSocketPath(async (p) => {
      probed.push(p);
      return p === markerSocket;
    });
    assert.equal(got, markerSocket);
    assert.deepEqual(probed, [markerSocket]);
  });

  it("resolveSocketPath: dead marker falls through to runtime", async () => {
    process.env["XDG_CONFIG_HOME"] = dir;
    process.env["XDG_STATE_HOME"] = dir;
    const markerSocket = path.join(dir, "marker.sock");
    await fsp.mkdir(path.dirname(markerPath()), { recursive: true });
    await fsp.writeFile(markerPath(), JSON.stringify({ socket: markerSocket, pid: 4242 }));
    const probed: string[] = [];
    const got = await resolveSocketPath(async (p) => {
      probed.push(p);
      return p === runtimeSocketPath();
    });
    assert.equal(got, runtimeSocketPath());
    assert.deepEqual(probed, [markerSocket, runtimeSocketPath()]);
  });

  it("resolveSocketPath: unreadable/invalid marker is a normal no-daemon case", async () => {
    process.env["XDG_CONFIG_HOME"] = dir;
    process.env["XDG_STATE_HOME"] = dir;
    await fsp.mkdir(path.dirname(markerPath()), { recursive: true });
    await fsp.writeFile(markerPath(), "{not json");
    const got = await resolveSocketPath(async () => false);
    assert.equal(got, undefined);
  });

  it("resolveSocketPath: marker without a valid pid is ignored (Go ReadMarker parity)", async () => {
    process.env["XDG_CONFIG_HOME"] = dir;
    process.env["XDG_STATE_HOME"] = dir;
    const markerSocket = path.join(dir, "marker.sock");
    await fsp.mkdir(path.dirname(markerPath()), { recursive: true });
    await fsp.writeFile(markerPath(), JSON.stringify({ socket: markerSocket, pid: 0 }));
    const probed: string[] = [];
    const got = await resolveSocketPath(async (p) => {
      probed.push(p);
      return p === runtimeSocketPath();
    });
    assert.equal(got, runtimeSocketPath());
    assert.deepEqual(probed, [runtimeSocketPath()]); // marker never probed
  });
});

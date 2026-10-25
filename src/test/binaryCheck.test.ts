import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { isBinaryAvailable } from "../binaryCheck";

async function tmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "portato-binarycheck-"));
}

describe("isBinaryAvailable", () => {
  it("absolute path with +x resolves true", async () => {
    const dir = await tmpDir();
    const bin = join(dir, "portato");
    await writeFile(bin, "#!/bin/sh\n", { mode: 0o755 });
    assert.equal(await isBinaryAvailable(bin, ""), true);
  });

  it("path without the executable bit is not available", async () => {
    const dir = await tmpDir();
    const bin = join(dir, "portato");
    await writeFile(bin, "not executable", { mode: 0o644 });
    assert.equal(await isBinaryAvailable(bin, ""), false);
  });

  it("missing path is not available", async () => {
    assert.equal(
      await isBinaryAvailable("/nonexistent/dir/portato", ""),
      false,
    );
  });

  it("bare name resolves through the given PATH", async () => {
    const dir = await tmpDir();
    await writeFile(join(dir, "portato"), "#!/bin/sh\n", { mode: 0o755 });
    assert.equal(await isBinaryAvailable("portato", `${dir}:/usr/bin`), true);
    assert.equal(await isBinaryAvailable("portato", "/usr/bin:/bin"), false);
  });

  it("empty PATH segments are tolerated, empty PATH finds nothing", async () => {
    const dir = await tmpDir();
    await writeFile(join(dir, "portato"), "#!/bin/sh\n", { mode: 0o755 });
    assert.equal(await isBinaryAvailable("portato", `:${dir}::`), true);
    assert.equal(await isBinaryAvailable("portato", ""), false);
  });

  it("a chmod change flips the answer (X_OK re-checked per call)", async () => {
    const dir = await tmpDir();
    const bin = join(dir, "portato");
    await writeFile(bin, "#!/bin/sh\n", { mode: 0o644 });
    assert.equal(await isBinaryAvailable(bin, ""), false);
    await chmod(bin, 0o755);
    assert.equal(await isBinaryAvailable(bin, ""), true);
  });
});

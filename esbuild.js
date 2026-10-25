const fsp = require("node:fs/promises");
const path = require("node:path");
const esbuild = require("esbuild");

const watch = process.argv.includes("--watch");

const extensionConfig = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "out/extension.js",
  external: ["vscode"],
  platform: "node",
  target: "node20",
  format: "cjs",
  sourcemap: true,
  logLevel: "info",
};

// Tests run under plain `node --test` (no VS Code): bundled from
// src/test/*.test.ts (unit) and src/test/*.itest.ts (integration against a
// real daemon). `vscode` is aliased to src/test/vscodeStub.ts so the
// controller glue test can drive the real wiring headlessly; pure module
// tests never import vscode at all. tsc still checks @types/vscode because
// the alias lives only here.
async function testConfig() {
  let entries = [];
  try {
    entries = (await fsp.readdir("src/test"))
      .filter((f) => f.endsWith(".test.ts") || f.endsWith(".itest.ts"))
      .map((f) => path.join("src/test", f));
  } catch {
    // no tests yet -- nothing to build
  }
  return {
    entryPoints: entries,
    bundle: true,
    outdir: "out/test",
    alias: { vscode: path.resolve("src/test/vscodeStub.ts") },
    platform: "node",
    target: "node20",
    format: "cjs",
    sourcemap: false,
    logLevel: "silent",
  };
}

async function main() {
  const configs = [extensionConfig, await testConfig()].filter(
    (c) => c.entryPoints.length > 0,
  );
  if (watch) {
    const ctx = await esbuild.context(configs[0]);
    if (configs[1]) await (await esbuild.context(configs[1])).watch();
    await ctx.watch();
  } else {
    await Promise.all(configs.map((c) => esbuild.build(c)));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

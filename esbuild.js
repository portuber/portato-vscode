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

// Unit tests run under plain `node --test` (no VS Code): bundled from
// src/test/*.test.ts, vscode stays external so importing it fails loudly
// if a test accidentally pulls UI code.
async function testConfig() {
  let entries = [];
  try {
    entries = (await fsp.readdir("src/test"))
      .filter((f) => f.endsWith(".test.ts"))
      .map((f) => path.join("src/test", f));
  } catch {
    // no tests yet -- nothing to build
  }
  return {
    entryPoints: entries,
    bundle: true,
    outdir: "out/test",
    external: ["vscode"],
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

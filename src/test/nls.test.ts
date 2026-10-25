import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

// package.json localizes through %key% placeholders resolved against
// package.nls.json. A typo on either side fails silently at runtime (VS Code
// renders the raw %key%), so this pins the parity. npm test always runs from
// the repo root (the script globs out/test), so cwd locates both files.

const pkg: unknown = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8"));
const nls = JSON.parse(
  readFileSync(resolve(process.cwd(), "package.nls.json"), "utf8"),
) as Record<string, string>;

/** Collect %key% tokens from every string reachable in a JSON value. */
function referenced(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    for (const m of value.matchAll(/%([A-Za-z0-9._-]+)%/g)) out.push(m[1]!);
  } else if (Array.isArray(value)) {
    for (const v of value) referenced(v, out);
  } else if (value !== null && typeof value === "object") {
    for (const v of Object.values(value)) referenced(v, out);
  }
  return out;
}

describe("package.nls.json parity", () => {
  it("every %key% in package.json resolves to a non-empty string", () => {
    const refs = referenced(pkg);
    assert.ok(refs.length > 10, "expected a meaningful number of %keys%");
    for (const key of new Set(refs)) {
      assert.ok(typeof nls[key] === "string", `missing package.nls.json key: ${key}`);
      assert.ok(nls[key].length > 0, `empty translation for: ${key}`);
    }
  });

  it("no orphaned keys in package.nls.json", () => {
    const refs = new Set(referenced(pkg));
    const orphans = Object.keys(nls).filter((k) => !refs.has(k));
    assert.deepEqual(orphans, []);
  });
});

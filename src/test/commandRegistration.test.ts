import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

// package.json declares every command id under contributes.commands (the
// menus, viewsWelcome buttons and keybindings reference those ids); activate()
// must register each declared id with vscode.commands, and every id it
// registers must be declared -- otherwise the Command Palette would show an
// entry without a title, or a menu/button would point at a command that does
// not exist. A mismatch compiles and typechecks fine, so this pins it
// statically. npm test always runs from the repo root (the script globs
// out/test), so cwd locates both files, as in nls.test.ts.

interface Contributed {
  contributes?: { commands?: { command?: unknown }[] };
}

const pkg = JSON.parse(
  readFileSync(resolve(process.cwd(), "package.json"), "utf8"),
) as Contributed;
const declared = (pkg.contributes?.commands ?? [])
  .map((c) => c.command)
  .filter((c): c is string => typeof c === "string");

const src = readFileSync(resolve(process.cwd(), "src/extension.ts"), "utf8");
const registered = [...src.matchAll(/registerCommand\(\s*"([^"]+)"/g)].map(
  (m) => m[1]!,
);

describe("command registration parity", () => {
  it("package.json declares a non-empty, unique set of commands", () => {
    assert.ok(declared.length >= 20, `expected a meaningful command set, got ${declared.length}`);
    assert.deepEqual(declared, [...new Set(declared)], "duplicate command ids in package.json");
  });

  it("every declared command id is registered in activate()", () => {
    const reg = new Set(registered);
    const missing = declared.filter((id) => !reg.has(id));
    assert.deepEqual(missing, [], "declared but never registered");
  });

  it("every registered command id is declared in package.json", () => {
    const decl = new Set(declared);
    const undeclared = registered.filter((id) => !decl.has(id));
    assert.deepEqual(undeclared, [], "registered but not declared");
  });
});

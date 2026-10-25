import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

// package.json walkthrough steps point at markdown files on disk, fire
// completion events ("onCommand:<id>" / "onView:<id>") and their markdown
// embeds "command:<id>" links. None of that is visible to the compiler: a
// dead reference ships silently and the walkthrough step just never
// completes (or the link renders as plain text). This pins it statically,
// same reason as commandRegistration.test.ts / nls.test.ts: npm test runs
// from the repo root (the script globs out/test), so cwd locates
// package.json and the walkthrough media.

interface Step {
  id?: unknown;
  media?: { markdown?: unknown };
  completionEvents?: unknown;
}
interface Walkthrough {
  id?: unknown;
  steps?: Step[];
}
interface Contributed {
  contributes?: {
    commands?: { command?: unknown }[];
    views?: Record<string, { id?: unknown }[]>;
    walkthroughs?: Walkthrough[];
  };
}

const pkg = JSON.parse(
  readFileSync(resolve(process.cwd(), "package.json"), "utf8"),
) as Contributed;

const declaredCommands = new Set(
  (pkg.contributes?.commands ?? [])
    .map((c) => c.command)
    .filter((c): c is string => typeof c === "string"),
);
const declaredViews = new Set(
  Object.values(pkg.contributes?.views ?? {})
    .flat()
    .map((v) => v.id)
    .filter((v): v is string => typeof v === "string"),
);
const walkthroughs = pkg.contributes?.walkthroughs ?? [];

describe("walkthrough references", () => {
  it("declares at least one walkthrough with steps", () => {
    assert.ok(walkthroughs.length >= 1, "no walkthroughs in package.json");
    for (const w of walkthroughs) {
      assert.ok(Array.isArray(w.steps) && w.steps.length > 0, `walkthrough ${String(w.id)} has no steps`);
    }
  });

  it("every step's media markdown exists on disk", () => {
    for (const w of walkthroughs) {
      for (const s of w.steps ?? []) {
        const md = s.media?.markdown;
        assert.ok(typeof md === "string", `step ${String(s.id)} has no media.markdown`);
        const p = resolve(process.cwd(), md);
        assert.ok(existsSync(p), `step ${String(s.id)} media ${String(md)} not found`);
      }
    }
  });

  it("every completion event references a declared command or view", () => {
    for (const w of walkthroughs) {
      for (const s of w.steps ?? []) {
        for (const ev of (Array.isArray(s.completionEvents) ? s.completionEvents : []) as string[]) {
          if (ev.startsWith("onCommand:")) {
            const id = ev.slice("onCommand:".length);
            assert.ok(declaredCommands.has(id), `step ${String(s.id)} event ${ev}: command not declared`);
          } else if (ev.startsWith("onView:")) {
            const id = ev.slice("onView:".length);
            assert.ok(declaredViews.has(id), `step ${String(s.id)} event ${ev}: view not declared`);
          } else {
            assert.fail(`step ${String(s.id)}: unsupported completion event ${ev}`);
          }
        }
      }
    }
  });

  it("every command: link in the walkthrough markdown is a declared command", () => {
    for (const w of walkthroughs) {
      for (const s of w.steps ?? []) {
        const md = s.media?.markdown;
        if (typeof md !== "string") continue;
        const body = readFileSync(resolve(process.cwd(), md), "utf8");
        const ids = [...body.matchAll(/command:(portato\.[a-zA-Z]+)/g)].map((m) => m[1]!);
        for (const id of ids) {
          assert.ok(declaredCommands.has(id), `step ${String(s.id)} links ${id}: not declared`);
        }
      }
    }
  });
});

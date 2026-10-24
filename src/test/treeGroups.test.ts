import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TuberStatus, TuberState } from "../types";
import { groupsOf, matchesFilter, moveSteps } from "../treeGroups";

function status(name: string, tags?: string[]): TuberStatus {
  return {
    name,
    type: "local",
    local: "127.0.0.1:1",
    remote: "127.0.0.1:2",
    state: "off" as TuberState,
    connected_at: "0001-01-01T00:00:00Z",
    tags,
  };
}

describe("groupsOf", () => {
  it("buckets by first tag, keeping config order inside a group", () => {
    const g = groupsOf([
      status("a", ["work", "eu"]),
      status("b"),
      status("c", ["home"]),
      status("d", ["work"]),
    ]);
    assert.deepEqual(
      g.map((x) => [x.tag, x.tubers.map((t) => t.name)]),
      [
        ["work", ["a", "d"]],
        ["home", ["c"]],
        ["", ["b"]],
      ],
    );
  });

  it("a multi-tag tuber appears once, under its first tag", () => {
    const g = groupsOf([status("a", ["work", "eu"])]);
    assert.equal(g.length, 1);
    assert.equal(g[0]?.tag, "work");
  });

  it("untagged-only input yields a single trailing bucket", () => {
    const g = groupsOf([status("a"), status("b")]);
    assert.deepEqual(g.map((x) => x.tag), [""]);
  });

  it("empty input yields no groups", () => {
    assert.deepEqual(groupsOf([]), []);
  });
});

describe("moveSteps", () => {
  const order = ["a", "b", "c", "d"];

  // The daemon's move?delta= SWAPS with the element at idx+delta
  // (internal/config/patch.go MoveTuberNode). A chain of neighbor swaps
  // composes into the insert the tree wants; these tests pin the chain.
  const apply = (o: string[], source: string, target: number | undefined): string[] => {
    const steps = moveSteps(o, source, target);
    if (steps === null) return [...o];
    const out = [...o];
    let i = out.indexOf(source);
    for (const s of steps) {
      const j = i + s;
      const a = out[i]!;
      out[i] = out[j]!;
      out[j] = a;
      i = j;
    }
    return out;
  };

  it("moves down to the target position via neighbor swaps", () => {
    assert.deepEqual(moveSteps(order, "a", 2), [1, 1]);
    assert.deepEqual(apply(order, "a", 2), ["b", "c", "a", "d"]);
    assert.deepEqual(moveSteps(order, "a", 1), [1]);
    assert.deepEqual(apply(order, "a", 1), ["b", "a", "c", "d"]);
  });

  it("moves up to the target position", () => {
    assert.deepEqual(moveSteps(order, "d", 0), [-1, -1, -1]);
    assert.deepEqual(apply(order, "d", 0), ["d", "a", "b", "c"]);
    assert.deepEqual(moveSteps(order, "c", 1), [-1]);
  });

  it("appends at the end when the target is the root", () => {
    assert.deepEqual(moveSteps(order, "a", undefined), [1, 1, 1]);
    assert.deepEqual(apply(order, "a", undefined), ["b", "c", "d", "a"]);
    assert.equal(moveSteps(order, "d", undefined), null); // already last
  });

  it("no-op for same position or an unknown source", () => {
    assert.equal(moveSteps(order, "b", 1), null);
    assert.equal(moveSteps(order, "ghost", 0), null);
    assert.equal(moveSteps(order, "a", -1), null);
    assert.equal(moveSteps(order, "a", 4), null);
  });

  it("a single swap is NOT an insert (daemon semantics)", () => {
    // One move+2 swaps a and c; the tree therefore never sends |delta| > 1.
    const out = [...order];
    const a = out[0]!;
    out[0] = out[2]!;
    out[2] = a;
    assert.deepEqual(out, ["c", "b", "a", "d"]);
  });
});

describe("matchesFilter", () => {
  it("no filter matches everything", () => {
    assert.equal(matchesFilter(status("alpha"), undefined), true);
  });

  it("text filter matches name or tag case-insensitively as a substring", () => {
    assert.equal(matchesFilter(status("AlphaBeta"), { kind: "text", value: "alph" }), true);
    assert.equal(matchesFilter(status("AlphaBeta"), { kind: "text", value: "beta" }), true);
    assert.equal(matchesFilter(status("AlphaBeta"), { kind: "text", value: "gamma" }), false);
    assert.equal(matchesFilter(status("a", ["Work", "EU"]), { kind: "text", value: "work" }), true);
    assert.equal(matchesFilter(status("a", ["Work", "EU"]), { kind: "text", value: "home" }), false);
  });

  it("blank text filter matches everything", () => {
    assert.equal(matchesFilter(status("alpha"), { kind: "text", value: "   " }), true);
  });

  it("tag filter matches the exact tag only", () => {
    const f = { kind: "tag", value: "db" } as const;
    assert.equal(matchesFilter(status("a", ["db"]), f), true);
    assert.equal(matchesFilter(status("db-prod", ["work"]), f), false);
    assert.equal(matchesFilter(status("a", ["db-prod"]), f), false);
    assert.equal(matchesFilter(status("a", ["DB"]), f), false); // case-sensitive
  });
});

import type { TuberStatus } from "./types";

// Pure helpers for the tree's grouping, filtering and drag-and-drop reorder.
// Kept free of vscode so the delta math and visibility rules are unit-testable.

/** A sidebar group: `tag` is "" for the untagged bucket (rendered "untagged"). */
export interface TuberGroup {
  tag: string;
  tubers: TuberStatus[];
}

/**
 * Buckets tubers by their FIRST tag, in config order. A multi-tag tuber
 * appears under its first tag only -- duplicating it under every tag breaks
 * drag-and-drop identity math and doubles the action surface. Untagged
 * tubers land in the "" bucket, always rendered last.
 */
export function groupsOf(statuses: readonly TuberStatus[]): TuberGroup[] {
  const byTag = new Map<string, TuberStatus[]>();
  for (const s of statuses) {
    const tag = s.tags?.[0] ?? "";
    const arr = byTag.get(tag);
    if (arr) arr.push(s);
    else byTag.set(tag, [s]);
  }
  const out: TuberGroup[] = [];
  for (const [tag, tubers] of byTag) {
    if (tag !== "") out.push({ tag, tubers });
  }
  const untagged = byTag.get("");
  if (untagged) out.push({ tag: "", tubers: untagged });
  return out;
}

/**
 * Sequential `move?delta=` steps (each +/-1) that place `source` at the
 * target position in `order`. The daemon's move SWAPS with the element at
 * idx+delta -- internal/config/patch.go MoveTuberNode -- it does not insert;
 * a chain of neighbor swaps composes into an insert. `targetIndex` undefined
 * means "move to the end". Null means "no request" (same position or an
 * unknown source) and must not produce any request. The caller issues the
 * steps in order, stopping on the first failure.
 */
export function moveSteps(
  order: readonly string[],
  source: string,
  targetIndex: number | undefined,
): number[] | null {
  const from = order.indexOf(source);
  if (from < 0) return null;
  const to = targetIndex === undefined ? order.length - 1 : targetIndex;
  if (to < 0 || to >= order.length) return null;
  const n = Math.abs(to - from);
  if (n === 0) return null;
  const step = to > from ? 1 : -1;
  return Array.from({ length: n }, () => step);
}

/** Active tree filter: an exact tag picked from the list, or free-text. */
export type TunnelFilter =
  | { kind: "tag"; value: string }
  | { kind: "text"; value: string };

/** Exact match for tag filters; case-insensitive substring for text. */
export function matchesFilter(s: TuberStatus, filter: TunnelFilter | undefined): boolean {
  if (!filter) return true;
  if (filter.kind === "tag") return (s.tags ?? []).includes(filter.value);
  const f = filter.value.trim().toLowerCase();
  if (!f) return true;
  if (s.name.toLowerCase().includes(f)) return true;
  return (s.tags ?? []).some((t) => t.toLowerCase().includes(f));
}

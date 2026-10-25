// Pure parsing/selection math for the SSH-config import flow. The extension
// never reimplements the importer -- `portato import --all --dry-run` prints
// the plan and this module turns that text into quick-pick rows:
//
//   <name>  <type>  <spec>  [ssh: <host>]
//   (skip) <host> <spec> ... already configured
//
// Parsing is deliberately lenient (the CLI's exact wording is not a
// contract): candidate lines are anchored on the trailing "[ssh: ...]",
// columns split on runs of 2+ spaces (forward specs use single spaces),
// "(skip)" lines are recognized by prefix alone -- never by the em-dash the
// CLI happens to print today.

export interface ImportRow {
  /** Proposed tuber name (unique per plan). */
  name: string;
  /** local | remote | dynamic -- taken verbatim from the preview. */
  type: string;
  /** The forward spec as declared in ~/.ssh/config. */
  spec: string;
  /** The ssh block's first host pattern; the unit import actually selects. */
  host: string;
}

export interface ImportPreview {
  kind: "rows" | "empty" | "unparsed";
  rows: ImportRow[];
  /** Raw "(skip)" lines (already-configured forwards), trimmed. */
  skipped: string[];
  raw: string;
}

const EMPTY_RX =
  /^(nothing new to import \(\d+ already configured\)|no forwards found in .+; nothing to import)$/;

export function parseImportPreview(out: string): ImportPreview {
  const text = out.trim();
  if (!text) return { kind: "unparsed", rows: [], skipped: [], raw: out };
  if (EMPTY_RX.test(text)) return { kind: "empty", rows: [], skipped: [], raw: out };

  const rows: ImportRow[] = [];
  const skipped: string[] = [];
  for (const line of out.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    if (s.startsWith("(skip)")) {
      skipped.push(s);
      continue;
    }
    const m = s.match(/^(.*?)\s+\[ssh:\s+(.+?)\]\s*$/);
    if (!m) continue; // unknown line: ignored, the anchor lines carry the plan
    const head = m[1];
    if (!head) continue;
    const fields = head.split(/\s{2,}/).map((f) => f.trim()).filter(Boolean);
    if (fields.length < 2) continue;
    const [name, type, ...rest] = fields;
    if (!name || !type) continue;
    const host = m[2];
    if (!host) continue;
    rows.push({ name, type, spec: rest.join("  "), host });
  }
  if (rows.length > 0) return { kind: "rows", rows, skipped, raw: out };
  if (skipped.length > 0) return { kind: "empty", rows: [], skipped, raw: out };
  return { kind: "unparsed", rows: [], skipped: [], raw: out };
}

export interface ImportBlock {
  host: string;
  rows: ImportRow[];
}

/** Group rows by ssh host, preserving first-seen order. */
export function groupImportBlocks(rows: ImportRow[]): ImportBlock[] {
  const blocks: ImportBlock[] = [];
  const byHost = new Map<string, ImportBlock>();
  for (const row of rows) {
    let block = byHost.get(row.host);
    if (!block) {
      block = { host: row.host, rows: [] };
      byHost.set(row.host, block);
      blocks.push(block);
    }
    block.rows.push(row);
  }
  return blocks;
}

/**
 * The import unit is the ssh BLOCK, not the single forward: the CLI matches
 * host patterns, so picking any forward of a block imports the whole block.
 * Map selected row names back to their (deduplicated, order-preserving)
 * host list for the argv.
 */
export function hostsForSelection(rows: ImportRow[], picked: Set<string>): string[] {
  const hosts: string[] = [];
  for (const block of groupImportBlocks(rows)) {
    if (block.rows.some((r) => picked.has(r.name))) hosts.push(block.host);
  }
  return hosts;
}

/** Count "imported <name> (disabled)" lines in a finished import's output. */
export function countImported(out: string): number {
  let n = 0;
  for (const line of out.split(/\r?\n/)) {
    if (/^imported \S+ \(disabled\)$/.test(line.trim())) n += 1;
  }
  return n;
}

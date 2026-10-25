import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseImportPreview,
  groupImportBlocks,
  hostsForSelection,
  countImported,
} from "../importView.js";

// Mirrors internal/cmd/import.go printImportPreview: columns padded with
// spaces, the ssh block pattern in "[ssh: ...]", skips on their own lines.
const PREVIEW = [
  "  web-8080     local    8080 -> 127.0.0.1:80  [ssh: web]",
  "  web-socks    dynamic  socks5 127.0.0.1:1080  [ssh: web]",
  "  db           remote   0.0.0.0:5432 <- 127.0.0.1:5432  [ssh: dbprod]",
  "  (skip) old 127.0.0.1:9 -> 10.0.0.9:9 \u2014 already configured",
  "",
].join("\n");

test("parseImportPreview extracts rows and skips", () => {
  const p = parseImportPreview(PREVIEW);
  assert.equal(p.kind, "rows");
  assert.equal(p.rows.length, 3);
  assert.deepEqual(p.rows[0], {
    name: "web-8080",
    type: "local",
    spec: "8080 -> 127.0.0.1:80",
    host: "web",
  });
  assert.equal(p.rows[2]!.type, "remote");
  assert.equal(p.rows[2]!.spec, "0.0.0.0:5432 <- 127.0.0.1:5432");
  assert.equal(p.rows[2]!.host, "dbprod");
  assert.equal(p.skipped.length, 1);
  assert.ok(p.skipped[0]!.startsWith("(skip) old"));
});

test("parseImportPreview recognizes skips without the em-dash", () => {
  const p = parseImportPreview("  (skip) old 127.0.0.1:9 -> 10.0.0.9:9 already configured\n");
  assert.equal(p.skipped.length, 1);
});

test("parseImportPreview maps the CLI's empty outcomes to kind empty", () => {
  assert.equal(parseImportPreview("nothing new to import (2 already configured)\n").kind, "empty");
  assert.equal(
    parseImportPreview("no forwards found in /home/u/.ssh/config; nothing to import\n").kind,
    "empty",
  );
});

test("parseImportPreview reports garbage as unparsed instead of guessing", () => {
  assert.equal(parseImportPreview("Error: unable to load keys\n").kind, "unparsed");
  assert.equal(parseImportPreview("").kind, "unparsed");
  // A candidate line without the [ssh: ...] anchor is not a plan row.
  assert.equal(parseImportPreview("  web-8080 local 127.0.0.1:8080\n").kind, "unparsed");
});

test("parseImportPreview handles the real CLI output verbatim", () => {
  // Captured from `portato import --from <cfg> --all --dry-run` (v1.11):
  // note the trailing "(dry run ...)" line -- it carries no [ssh:] anchor
  // and is ignored by design. The em-dash is the CLI's real byte (\u2014),
  // escaped to keep this file ASCII.
  const real = [
    "  web-8080     local    8080 -> 127.0.0.1:80  [ssh: web]",
    "  web-1080     dynamic  socks5 1080  [ssh: web]",
    "  dbprod-5432  remote   127.0.0.1:5432 <- 127.0.0.1:5432  [ssh: dbprod]",
    "(dry run \u2014 nothing written)",
  ].join("\n");
  const p = parseImportPreview(real);
  assert.equal(p.kind, "rows");
  assert.equal(p.rows.length, 3);
  assert.equal(p.rows[0]!.spec, "8080 -> 127.0.0.1:80");
  assert.equal(p.rows[1]!.type, "dynamic");
  assert.deepEqual(hostsForSelection(p.rows, new Set(["web-1080"])), ["web"]);
});

test("groupImportBlocks groups by host in first-seen order", () => {
  const p = parseImportPreview(PREVIEW);
  const blocks = groupImportBlocks(p.rows);
  assert.deepEqual(
    blocks.map((b) => b.host),
    ["web", "dbprod"],
  );
  assert.equal(blocks[0]!.rows.length, 2);
  assert.equal(blocks[1]!.rows.length, 1);
});

test("hostsForSelection selects whole blocks, deduplicated", () => {
  const p = parseImportPreview(PREVIEW);
  // Picking one forward of "web" selects the whole web block.
  assert.deepEqual(hostsForSelection(p.rows, new Set(["web-socks"])), ["web"]);
  assert.deepEqual(hostsForSelection(p.rows, new Set(["web-8080", "web-socks"])), ["web"]);
  assert.deepEqual(hostsForSelection(p.rows, new Set(["web-8080", "db"])), ["web", "dbprod"]);
  assert.deepEqual(hostsForSelection(p.rows, new Set()), []);
});

test("countImported counts the per-tuber confirmation lines", () => {
  assert.equal(
    countImported("imported web-8080 (disabled)\nimported db (disabled)\n"),
    2,
  );
  assert.equal(countImported("nothing here"), 0);
});

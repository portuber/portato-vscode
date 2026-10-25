# Contributing to portato-vscode

Prerequisites: Node 24 (see `.nvmrc`), npm, VS Code 1.90 or newer, and
the [portato](https://github.com/portuber/portato) binary for the
integration suite (a recent release build is fine).

## Setup

```sh
npm install
npm run compile          # esbuild -> out/extension.js
npm run watch            # + F5 (Run Extension) in VS Code
```

## Checks (what CI runs)

```sh
npm run lint             # ESLint (type-checked rules)
npm run typecheck        # tsc --noEmit
npm test                 # unit tests (no VS Code, no daemon needed)
npm run test:integration # against a disposable real daemon (needs portato)
npm run package          # vsce package -> .vsix
```

The integration suite looks for the binary in `$PORTATO_BINARY` or
`/opt/homebrew/bin/portato` and skips when absent. CI
(.github/workflows/ci.yml) runs every check above on ubuntu and macOS on
each push and PR, downloading the pinned `PORTATO_VERSION` portato
release for the integration suite.

## Conventions

- Conventional Commits (`feat(<scope>): ...`, `fix(...)`, `chore(...)`);
  non-trivial commits carry a body saying what and why.
- English only in the repo; ASCII punctuation in code, comments, commit
  messages, CHANGELOG and docs. UI strings go through
  `vscode.l10n` / `package.nls.json` (parity is pinned by
  `src/test/nls.test.ts`; pure modules take an injected translator with
  an identity default).
- Never log tokens, passphrases, passwords or `GET /config` bodies, and
  never pass secrets through argv. All I/O is async; no `*Sync` calls.
- The daemon IPC contract lives in the Go repo
  (github.com/portuber/portato); when it changes, update `src/types.ts`
  and the AGENTS.md contract section in the same PR.
- Agent-mediated changes: `AGENTS.md` is the working contract for AI
  agents; open decisions and pre-commit audits go through the `/bridge`
  protocol described there.

## Releasing

Releases are cut with the Makefile targets and published automatically:

```sh
make release-patch  # v1.2.3 -> v1.2.4
make release-minor  # v1.2.3 -> v1.3.0
make release-major  # v1.2.3 -> v2.0.0
make release VERSION=v1.2.4  # explicit
```

A release requires a clean working tree and a `## [X.Y.Z]` section
already in [CHANGELOG.md](CHANGELOG.md), runs lint, typecheck and unit
tests locally, then asks for confirmation, bumps `package.json` and
`package-lock.json`, commits, tags `vX.Y.Z` and pushes. The tag triggers
[.github/workflows/release.yml](.github/workflows/release.yml): lint,
typecheck, compile, unit tests, `vsce package`, a tag/version guard, a
GitHub Release with the `.vsix` and checksums (release notes taken from
the CHANGELOG section), and publishes to the Marketplace via the
`VSCE_PAT` repository secret. When the optional `OVSX_PAT` secret is
set, the same workflow publishes to [Open VSX](https://open-vsx.org/)
too; both publishes are idempotent (`--skip-duplicate`).

## Versioning

Semantic Versioning 2.0.0, stable `vX.Y.Z` tags only -- no pre-release,
RC or beta tags (same policy as
[portato](https://github.com/portuber/portato)). While the major is `0`,
a breaking change bumps the minor (`0.1.0` -> `0.2.0`), never the patch,
and is flagged **BREAKING** in the release notes.

The version number is a contract over the user-facing surfaces only: the
`portato.*` command IDs, their titles, and the `portato.*` settings keys
and defaults. Everything else -- tree layout, icons, the webview form,
wording -- is free to change in any release.

The daemon IPC the extension speaks is portato's contract, not this one:
a release notes when it needs a newer daemon (the daemon reports its
version since v1.11.0).

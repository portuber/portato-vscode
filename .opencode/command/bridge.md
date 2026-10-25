---
description: Consult the reviewing agent or audit staged changes headlessly
---

Run the bridge: a second agent that arbitrates decisions before implementation
(`/bridge consult`) and audits staged changes before a release commit
(`/bridge audit`). The mode comes from the invocation arguments.

## 0. Resolve the config, the binary, and the call

```bash
cd "$(git rev-parse --show-toplevel)"
[ -f .opencode/bridge.local ] && . ./.opencode/bridge.local
: "${BRIDGE_RUNNER:=claude-ext}"
if [ -z "$BRIDGE_MODEL" ]; then
  case "$BRIDGE_RUNNER" in
    antigravity) : ;;                  # empty = the agy CLI default model
    *) BRIDGE_MODEL=claude-opus-5-5 ;;
  esac
fi
: "${BRIDGE_PAUSE1:=120}"
: "${BRIDGE_PAUSE2:=600}"
if ! declare -f bridge_invoke >/dev/null 2>&1; then
  case "$BRIDGE_RUNNER" in
    claude-cli)
      BRIDGE_BIN=$(command -v claude) || { echo "claude not on PATH"; exit 1; } ;;
    claude-ext)
      BRIDGE_BIN=$(command -v claude || true)
      [ -z "$BRIDGE_BIN" ] && BRIDGE_BIN=$(ls -d ~/.vscode/extensions/anthropic.claude-code-*/resources/native-binary/claude 2>/dev/null | sort -V | tail -1)
      [ -n "$BRIDGE_BIN" ] || { echo "claude binary not found (PATH or vscode extension)"; exit 1; } ;;
    antigravity)
      BRIDGE_BIN=$(command -v agy || true)
      [ -z "$BRIDGE_BIN" ] && [ -x "$HOME/.local/bin/agy" ] && BRIDGE_BIN="$HOME/.local/bin/agy"
      [ -n "$BRIDGE_BIN" ] || { echo "agy not found (PATH or ~/.local/bin/agy)"; exit 1; } ;;
    *)
      echo "unknown BRIDGE_RUNNER '$BRIDGE_RUNNER' - define bridge_invoke() in .opencode/bridge.local"; exit 1 ;;
  esac
fi
bridge_run() {
  # $1 = prompt; the remaining args are tool grants (claude runners only -
  # agy permissions live in its own settings.json, the args are ignored there)
  local prompt="$1"; shift
  if declare -f bridge_invoke >/dev/null 2>&1; then bridge_invoke "$prompt"; return; fi
  case "$BRIDGE_RUNNER" in
    claude-*)
      local args=(-p "$prompt" --strict-mcp-config --mcp-config '{"mcpServers":{}}')
      [ -n "$BRIDGE_MODEL" ] && args+=(--model "$BRIDGE_MODEL")
      [ -n "$BRIDGE_EFFORT" ] && args+=(--effort "$BRIDGE_EFFORT")
      [ "$#" -gt 0 ] && args+=(--allowedTools "$@")
      "$BRIDGE_BIN" "${args[@]}" ;;
    antigravity)
      # --print-timeout needs a unit; without one agy silently prints usage
      local args=(-p "$prompt" --print-timeout 600s)
      [ -n "$BRIDGE_MODEL" ] && args+=(--model "$BRIDGE_MODEL")
      [ -n "$BRIDGE_EFFORT" ] && args+=(--effort "$BRIDGE_EFFORT")
      "$BRIDGE_BIN" "${args[@]}" ;;
  esac
}
echo "runner=$BRIDGE_RUNNER model=${BRIDGE_MODEL:-default} bin=${BRIDGE_BIN:-bridge_invoke}"
```

`bridge.local` is machine-local (gitignored; see `.opencode/bridge.local.example`)
and wins over every default. Model ids are runner-specific (`claude-opus-5-5`
for the claude runners; `claude-sonnet-4-6`, `gemini-3.8-flash-high` and
friends for agy). A `bridge_invoke()` defined there receives the prompt as
`$1` and replaces the whole invocation - any agent binary works that way
without touching this file.

agy in headless mode auto-approves file reads but auto-denies shell commands
unless its own settings.json carries `permissions.allow` rules
(`command(npm*)` and the like): consult works out of the box, audit needs
those rules. That is the owner's machine-local setup, never a flag added
here (see the Never section).

## 1. consult - decisions before implementation

Compose the brief yourself (the caller's question is in the command
arguments): context (repo, mandate, what is already verified), each decision
as D-N with lettered options and the executor's recommendation, and the
strict output block the bridge must answer with. Then invoke it read-only
and relay the answer to the owner verbatim - never summarize a verdict.

```bash
PROMPT=$(cat <<'EOF'
<the brief; end with:>
Output STRICTLY this block, no prose around it:
VERDICT D-1: <option> - <one-line rationale>
VERDICT D-2: ... (one line per decision)
SCOPE NOTES: <additions/cuts you insist on, or "none">
EOF
)
bridge_run "$PROMPT" "Read" "Grep" "Glob" \
                   "Bash(git status*)" "Bash(git diff*)" "Bash(git log*)" "Bash(git show*)"
```

A consult verdict is decisive for the executor but never authorizes a
commit - that takes an audit (section 2).

## 2. audit - staged changes before a commit

Run after staging the complete change. The verdict lands in
`.git/BRIDGE_VERDICT` (rotated through `.prev`/`.prev2`), the audited tree
hash in `.git/BRIDGE_TREE`, and the draft commit message travels as
`.git/BRIDGE_MSG` so the reviewer audits the exact message that will be
committed.

```bash
[ -f .git/BRIDGE_MSG ] || { echo ".git/BRIDGE_MSG missing - write the draft commit message first" >&2; exit 1; }
if [ -f .git/BRIDGE_VERDICT ]; then
  [ -f .git/BRIDGE_VERDICT.prev ] && mv .git/BRIDGE_VERDICT.prev .git/BRIDGE_VERDICT.prev2
  mv .git/BRIDGE_VERDICT .git/BRIDGE_VERDICT.prev
fi
git write-tree > .git/BRIDGE_TREE
PROMPT=$(cat <<'EOF'
You are the bridge reviewing agent for portato-vscode (VS Code extension,
TypeScript strict, esbuild; a client of the portato daemon - AGENTS.md is the
contract, read it first). Audit the STAGED diff and the draft commit message
in .git/BRIDGE_MSG: correctness, repo-rule compliance (English, ASCII
punctuation, l10n via vscode.l10n/package.nls.json, no secrets logged, async
I/O only), tests that should exist for the change. Verify claims yourself
with the granted commands; do not trust the diff prose. Output ONLY this
block:
VERDICT: approve|fix
RE-RAN: <commands you actually re-ran>
FIX: <numbered items - only on fix>
ESCALATE: <reason - only when a finding survived two repair rounds>
EOF
)
ATTEMPT=0; ACCEPTED=0
while [ "$ATTEMPT" -lt 3 ]; do
  ATTEMPT=$((ATTEMPT + 1))
  bridge_run "$PROMPT" \
    "Read" "Grep" "Glob" \
    "Bash(npm run typecheck*)" "Bash(npm test*)" "Bash(npm run test*)" \
    "Bash(npm run compile*)" "Bash(npx vsce ls*)" \
    "Bash(git diff*)" "Bash(git status*)" "Bash(git log*)" "Bash(git show*)" \
    "Bash(git check-ignore*)" \
    > .git/BRIDGE_VERDICT.tmp 2> .git/BRIDGE_VERDICT.err
  if awk '/^VERDICT: (approve|fix)[[:space:]]*$/{v=1} /^ESCALATE:/{v=1} /^RE-RAN:/{r=1} END{exit !(v&&r)}' .git/BRIDGE_VERDICT.tmp; then
    mv .git/BRIDGE_VERDICT.tmp .git/BRIDGE_VERDICT; ACCEPTED=1; break
  fi
  [ "$ATTEMPT" -eq 1 ] && sleep "$BRIDGE_PAUSE1"
  [ "$ATTEMPT" -eq 2 ] && sleep "$BRIDGE_PAUSE2"
done
[ "$ACCEPTED" = 1 ] || { echo "bridge dead after 3 attempts - output in .git/BRIDGE_VERDICT.tmp, stderr in .git/BRIDGE_VERDICT.err" >&2; exit 1; }
echo "verdict accepted on attempt $ATTEMPT"; cat .git/BRIDGE_VERDICT
```

A run counts only when the tmp file carries a parseable `VERDICT:` (or an
`ESCALATE:`) line AND a `RE-RAN:` line - a truncated block never becomes the
verdict. Run section 2 with no shell timeout (or in the background): the pauses can
reach BRIDGE_PAUSE1 + BRIDGE_PAUSE2 seconds.

### Act on the verdict

- `VERDICT: fix` - repair every FIX item, re-stage, refresh `.git/BRIDGE_MSG`,
  run section 2 again.
- The verdict contains `ESCALATE:` - stop repairing; show the current verdict
  and the previous rounds (`.prev`, `.prev2`) to the owner.
- `VERDICT: approve` - prove freshness first: if `.git/BRIDGE_MSG` is newer
  than `.git/BRIDGE_VERDICT`, or `git write-tree` differs from
  `.git/BRIDGE_TREE`, the verdict is stale - re-run section 2. Then ask the owner for
  the commit decision (commits always need explicit permission). On approval,
  in this exact order and with no other edits:
  1. `cp -p .git/BRIDGE_MSG .git/BRIDGE_MSG.pre`
  2. refuse unless the verdict approves:
     `grep -q '^VERDICT: approve$' .git/BRIDGE_VERDICT || { echo "verdict is not approve - refusing to commit" >&2; exit 1; }`
  3. `printf '\nBridge: %s, tree %s\n' "$(awk '/^VERDICT:/{print $2; exit}' .git/BRIDGE_VERDICT)" "$(cat .git/BRIDGE_TREE)" >> .git/BRIDGE_MSG`
  4. `git commit -F .git/BRIDGE_MSG`
  5. `rm -f .git/BRIDGE_VERDICT .git/BRIDGE_VERDICT.prev .git/BRIDGE_VERDICT.prev2 .git/BRIDGE_VERDICT.tmp .git/BRIDGE_VERDICT.err .git/BRIDGE_TREE .git/BRIDGE_MSG .git/BRIDGE_MSG.pre`
  If step 4 fails, restore with `cp -p .git/BRIDGE_MSG.pre .git/BRIDGE_MSG`
  (mtime preserved), fix the cause, redo the freshness check and steps 1-5.
  Never append a second trailer.

## 3. Never

- Never edit `.git/BRIDGE_VERDICT` or any verdict file by hand - show them
  unmodified.
- Never run the bridge with broader permissions than the lists above, and
  never bypass a runner's permission system (no
  `--dangerously-skip-permissions` for agy): grant narrow allow-rules in the
  runner's own settings instead.
- Never log or echo secrets, passphrase material or `/config` bodies into a
  bridge prompt.

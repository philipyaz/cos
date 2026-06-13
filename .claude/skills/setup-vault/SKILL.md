---
name: setup-vault
description: Bootstrap a NEW private vault instance from the committed example-vault template — copy the template to vault/<name>, point the vault MCP bridge (:8005) at it via COS_VAULT_DIR, register it with Obsidian + capture its unique vault ID into settings.json (so the board's obsidian:// deep-links open the in-repo vault unambiguously), register it with backup, and confirm it is gitignored. Use when the user says "set up a new vault", "create my vault", "spin up a new knowledge base", wants a fresh private knowledge base, or when Obsidian vault deep-links from the board open the wrong vault — and as the vault step of the cos-setup orchestrator (which sequences the MCP bridge after this).
allowed-tools: Bash, Read, Write, Edit
---

# Set up a new private vault

## What a vault is
A **vault** is the chief-of-staff's private knowledge base — real PII lives here (work/life notes,
entities, concepts, sources). It is **knowledge-only** (no to-dos, reminders, or priorities — those
live on the board). The repo ships ONE committed, synthetic template,
`vault/example-vault/`; a real instance is a **copy** at `vault/<name>/` that is **never committed**
(durability comes from `backup/`, encrypted + off-site — NOT git). The vault MCP server
(`mcp/vault-server/server.mjs`, bridged to `:8005`) reads/writes exactly ONE vault, chosen by the
`COS_VAULT_DIR` env var in its launchd plist.

The loader (`source "$(git rev-parse --show-toplevel)/config/load-config.sh"`, run at the top of
**every** shell block below) exports `$REPO_ROOT`, `$BREW_PREFIX`, `$LAUNCH_AGENTS_DIR`, `$COWORK_CONFIG`,
`$VAULT_NAME`, `$VAULT_DIR`, the bridge ports/URLs, etc. — use those instead of hardcoding machine
paths. **Each fenced block runs in a fresh shell — shell state does NOT persist between blocks — so the
loader line must begin every block, or its vars are empty.** `$U=$(id -u)` stays inline where
`launchctl` needs it; `<name>` is the slug from STEP 1.

**`$name` does not carry across blocks either.** It is set once in STEP 1, but every later block runs in
its own shell where `$name` is empty. So in each block below you MUST substitute the **literal chosen
slug** in place of `<name>`/`$name` (e.g. write `alice-knowledge`, not `$name`) — otherwise empty-var
paths like `$REPO_ROOT/vault/$name` collapse to the vault PARENT dir and corrupt the installed plist.
Blocks that write the plist re-validate the slug as a guard.

This skill creates the instance and wires it. It does **not** install the bridge itself — that is
**mcp-bridge-setup**. From `cos-setup`, run mcp-bridge-setup AFTER this (it sequences them); standalone,
the installed plist must already exist (see STEP 3).

---

## STEP 1 — Choose a name
Ask the user for a vault name: a clean **lowercase-dashed slug** (e.g. `<your-vault>`,
`alice-knowledge`). Validate before doing anything:

```sh
source "$(git rev-parse --show-toplevel)/config/load-config.sh"
# The loader exports $REPO_ROOT, $BREW_PREFIX, $LAUNCH_AGENTS_DIR, $COWORK_CONFIG, $VAULT_NAME,
# $VAULT_DIR, the bridge ports/URLs, etc. — use those instead of hardcoding machine paths.
name="<name>"   # the user's answer

# slug-only: lowercase letters, digits, dashes; not leading/trailing/double dash
case "$name" in
  ""|*[!a-z0-9-]*|-*|*-|*--*) echo "REJECT: not a clean lowercase-dashed slug"; exit 1;; esac
[ "$name" = "example-vault" ] && { echo "REJECT: example-vault is the template, not an instance"; exit 1; }
[ -e "$REPO_ROOT/vault/$name" ] && { echo "REJECT: vault/$name already exists"; exit 1; }
echo "OK: $name"
```

Reject and re-ask if: empty, contains anything but `[a-z0-9-]`, equals `example-vault`, or
`vault/<name>` already exists.

## STEP 2 — Copy the template
```sh
source "$(git rev-parse --show-toplevel)/config/load-config.sh"   # gives $REPO_ROOT (fresh shell)
name="<name>"   # the literal slug from STEP 1 — vars don't carry across blocks
cp -R "$REPO_ROOT/vault/example-vault" "$REPO_ROOT/vault/$name"
```
Confirm the structure copied (key dirs/files present):
```sh
source "$(git rev-parse --show-toplevel)/config/load-config.sh"   # gives $REPO_ROOT (fresh shell)
name="<name>"   # the literal slug from STEP 1
ls -1 "$REPO_ROOT/vault/$name"
# expect: CLAUDE.md, aliases.md, life/, output/, raw/, shared/, work/  (+ hidden .claude/)
test -f "$REPO_ROOT/vault/$name/work/wiki/index.md" \
  && test -f "$REPO_ROOT/vault/$name/life/wiki/index.md" \
  || echo "WARN: template incomplete"
```
(The vault is a **knowledge-only, domain-split LLM-wiki**: each domain has its own wiki — `work/wiki/`
and `life/wiki/`, each an `index.md` + `concepts/ entities/ sources/ log.md` — plus
`shared/wiki/entities/` for the truly-dual entities, alongside `raw/` (+ `raw/assets/`), `output/`, and
`aliases.md`. There is no top-level `wiki/`, and no reminders/priorities — actionable state lives on the
board. If a layout key you expect is missing, the template moved — `cp -R` copies whatever
`example-vault` currently holds.)

## STEP 3 — Point the MCP at it (COS_VAULT_DIR)

First, record the chosen slug as the active vault in `config/cos.env` — this is the SKILL-side
source of truth (the loader resolves `$VAULT_DIR = $REPO_ROOT/vault/$VAULT_NAME` from it for every
skill thereafter):

```bash
# Record the active vault in config/cos.env so skills resolve $VAULT_DIR to it.
source "$(git rev-parse --show-toplevel)/config/load-config.sh"   # gives $REPO_ROOT (fresh shell)
name="<name>"   # the literal lowercase-dashed slug chosen in STEP 1 — vars don't carry across blocks
case "$name" in (*[!a-z0-9-]*|"") echo "vault name must be a lowercase-dashed slug"; exit 1;; esac
tmp="$(mktemp)"
grep -v '^VAULT_NAME=' "$REPO_ROOT/config/cos.env" > "$tmp" 2>/dev/null || true
printf 'VAULT_NAME="%s"\n' "$name" >> "$tmp"
mv "$tmp" "$REPO_ROOT/config/cos.env"
grep '^VAULT_NAME=' "$REPO_ROOT/config/cos.env"   # confirm exactly one line, the new name
```

`COS_VAULT_DIR` is then set in TWO places: the **installed launchd plist** and the **Cowork config**.

**Installed plist** — `$LAUNCH_AGENTS_DIR/com.chiefofstaff.mcp-vault.plist`. If it does **not**
exist, the bridge has not been installed yet: tell the user to run **mcp-bridge-setup** first (or, if
this is `cos-setup`, that orchestrator runs the MCP step AFTER this — note it and skip the plist edit
for now; the operator will set `COS_VAULT_DIR` to `vault/<name>` when installing). If it exists, point
its `COS_VAULT_DIR` `<string>` at the new vault (rewrite ONLY the `COS_VAULT_DIR` value, not other
absolute paths):

```sh
source "$(git rev-parse --show-toplevel)/config/load-config.sh"   # gives $REPO_ROOT, $LAUNCH_AGENTS_DIR (fresh shell)
name="<name>"   # the literal slug from STEP 1
# Re-validate the slug before any plist write — an empty/invalid $name would rewrite
# COS_VAULT_DIR to the vault PARENT dir and corrupt the installed plist.
case "$name" in (*[!a-z0-9-]*|"") echo "bad slug"; exit 1;; esac
PLIST="$LAUNCH_AGENTS_DIR/com.chiefofstaff.mcp-vault.plist"
test -f "$PLIST" || { echo "MISSING: run mcp-bridge-setup first (or cos-setup sequences it after)"; }
# Replace the <string> immediately after the COS_VAULT_DIR <key>.
/usr/bin/perl -0pi -e \
  "s#(<key>COS_VAULT_DIR</key>\s*<string>)[^<]*(</string>)#\${1}$REPO_ROOT/vault/$name\${2}#" "$PLIST"
grep -A1 COS_VAULT_DIR "$PLIST"   # confirm it now reads $REPO_ROOT/vault/$name
```

**Async ingest runner** — the vault also has a detached jobs-runner sidecar
(`com.chiefofstaff.mcp-vaultjobs`) that executes async `ingest` jobs (see
[docs/reference/vault-async.md](../../../docs/reference/vault-async.md)). Install it from its committed
template the same way — it carries the same `__REPO__` + `__VAULT_NAME__` placeholders, needs
`ANTHROPIC_API_KEY` (its launch wrapper sources `config/secrets.env`), and has no port:

```sh
source "$(git rev-parse --show-toplevel)/config/load-config.sh"   # gives $REPO_ROOT, $LAUNCH_AGENTS_DIR
name="<name>"   # the literal slug from STEP 1
case "$name" in (*[!a-z0-9-]*|"") echo "bad slug"; exit 1;; esac
U=$(id -u)
sed -e "s#__REPO__#$REPO_ROOT#g" -e "s#__VAULT_NAME__#$name#g" \
  "$REPO_ROOT/mcp/vault-server/deploy/com.chiefofstaff.mcp-vaultjobs.plist.template" \
  > "$LAUNCH_AGENTS_DIR/com.chiefofstaff.mcp-vaultjobs.plist"
launchctl bootout   gui/$U/com.chiefofstaff.mcp-vaultjobs 2>/dev/null || true
launchctl bootstrap gui/$U "$LAUNCH_AGENTS_DIR/com.chiefofstaff.mcp-vaultjobs.plist"
launchctl kickstart -k gui/$U/com.chiefofstaff.mcp-vaultjobs
launchctl list | grep com.chiefofstaff.mcp-vaultjobs   # loaded?
tail -n 3 "$REPO_ROOT/mcp/logs/vaultjobs.err.log"      # expect "[vault-jobs] runner up …" with NO fatal line after it
```

**Load the `vault-operations` skill in Cowork** — the
[`vault-operations`](https://github.com/philipyaz/cos/tree/main/.claude/skills/vault-operations) skill
teaches the model the async **submit-then-poll** ingest lifecycle (and never to re-submit an in-flight
job). Claude **Code** auto-loads it from the repo's `.claude/skills/` — nothing to do there. Claude
**Cowork Desktop** does NOT read the repo filesystem (`~/.claude/skills/` is Claude Code CLI only);
custom skills are added through its **UI** by uploading a ZIP. Build the ZIP (the skill **folder** must
be at the ZIP root — `vault-operations/SKILL.md`, not loose files), then upload it:

```sh
source "$(git rev-parse --show-toplevel)/config/load-config.sh"
( cd "$REPO_ROOT/.claude/skills" && rm -f /tmp/vault-operations-skill.zip && zip -r /tmp/vault-operations-skill.zip vault-operations )
echo "Now upload /tmp/vault-operations-skill.zip in Cowork → Customize → + (next to Skills) → Create skill"
```

In Claude Cowork Desktop: **Customize → `+` next to Skills → Create skill → select the ZIP**. It is
available immediately (no restart needed) across all Cowork sessions; re-run the `zip` + re-upload to
update it.

> Belt-and-braces: even if the skill isn't loaded, the `ingest` / `ingest_status` tool **descriptions**
> already instruct the model to submit-then-poll and not to re-submit an in-flight job — the skill
> reinforces that guidance, it isn't strictly required for correctness.

**Cowork config (if configured)** — `$COWORK_CONFIG`, the `"vault"` server entry's
`env.COS_VAULT_DIR`. Only touch it if a `"vault"` entry exists:
```sh
source "$(git rev-parse --show-toplevel)/config/load-config.sh"   # gives $REPO_ROOT, $COWORK_CONFIG (fresh shell)
name="<name>"   # the literal slug from STEP 1
case "$name" in (*[!a-z0-9-]*|"") echo "bad slug"; exit 1;; esac
if [ -f "$COWORK_CONFIG" ] && grep -q '"vault"' "$COWORK_CONFIG"; then
  /usr/bin/perl -0pi -e \
    "s#(\"COS_VAULT_DIR\"\s*:\s*\")[^\"]*(\")#\${1}$REPO_ROOT/vault/$name\${2}#" "$COWORK_CONFIG"
  grep COS_VAULT_DIR "$COWORK_CONFIG"
else echo "No Cowork vault entry — skipping (mcp-bridge-setup wires Cowork)."; fi
```

**Restart the bridge and verify** (only if the installed plist exists):
```sh
source "$(git rev-parse --show-toplevel)/config/load-config.sh"   # gives $REPO_ROOT, $LAUNCH_AGENTS_DIR, $VAULT_BRIDGE_PORT (fresh shell)
name="<name>"   # the literal slug from STEP 1
U=$(id -u)
launchctl bootout   gui/$U/com.chiefofstaff.mcp-vault 2>/dev/null || true
launchctl bootstrap gui/$U "$LAUNCH_AGENTS_DIR/com.chiefofstaff.mcp-vault.plist"
launchctl kickstart -k gui/$U/com.chiefofstaff.mcp-vault
sleep 2   # supergateway + node cold start
# initialize → serverInfo.name must be "vault"
curl -s -X POST "http://127.0.0.1:$VAULT_BRIDGE_PORT/mcp" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"setup-vault","version":"1"}}}' \
  | grep -o '"name":"vault"' && echo "BRIDGE OK :$VAULT_BRIDGE_PORT name=vault"
# the server ready line must echo the NEW COS_VAULT_DIR
grep COS_VAULT_DIR "$REPO_ROOT/mcp/logs/vault.out.log" | tail -1
```
`serverInfo.name=="vault"` AND the ready line echoing `$REPO_ROOT/vault/$name` = bridge is up and pointed at
the new vault. (The vault server also needs a real `ANTHROPIC_API_KEY` for its outbound LLM calls —
this lives in the gitignored `config/secrets.env`, loaded by the launch wrapper, NOT in the plist;
mcp-bridge-setup sets it up. A cold start may connection-refuse for a few seconds — re-probe.)

## STEP 3.5 — Register with Obsidian & capture the vault ID (deep-links)

The board's case drawer renders an `obsidian://open?vault=…&file=…` deep-link for each vault
wikilink. Obsidian resolves `vault=` against the vaults it has **registered** (in
`~/Library/Application Support/obsidian/obsidian.json`) — by the folder **basename** OR by a
unique **16-char vault ID**; it does NOT open an arbitrary on-disk folder. Two problems this
step fixes: **(a)** a fresh `vault/<name>` is unknown to Obsidian until you open it once, and
**(b)** if another registered vault shares the basename (e.g. an older copy elsewhere on disk),
a name-based link is **ambiguous** and opens the wrong one. So we register the folder and record
its **unique ID** into `config/settings.json` — the board reads it via `board/lib/vault-config.ts`
and builds the deep-link from the ID, which is unambiguous. Note the board also **self-heals**:
when `settings.json` has no id, `vault-config.ts` reads it *through* from `obsidian.json` by
realpath — so **opening the vault in Obsidian is already enough** for deep-links and the /vault
"Registered with Obsidian" check; the capture below just **persists** it (and lets it override).

> Registration is a **manual GUI action** a skill cannot perform: Obsidian has no headless
> "register a folder" command, and `obsidian://open?path=…` only searches ALREADY-registered
> vaults, so it can't bootstrap an unknown folder. We instruct, then read back the result.

**1. Open the folder as a vault in Obsidian** — print the path and ask the user to do it:
```sh
source "$(git rev-parse --show-toplevel)/config/load-config.sh"   # gives $REPO_ROOT (fresh shell)
name="<name>"   # the literal slug from STEP 1
echo "In Obsidian:  File → Open Vault → Open folder as vault  →  choose this folder:"
echo "  $REPO_ROOT/vault/$name"
```
If Obsidian is not installed, skip to the **Fallback** at the end of this step.

**2. Capture the vault ID + name into `config/settings.json`.** This **polls** Obsidian's registry
(up to ~60s — so you can start it and THEN do Open-folder-as-vault), finds the entry whose path
matches THIS vault (realpath-compared, trailing-slash tolerant), and writes `obsidianVaultId` +
`obsidianVaultName` without touching other keys (creates `settings.json` from the example if absent).
The poll is the fix for the classic failure mode — running the capture ONCE, before the vault was
opened, silently recorded a **blank** id and the skill moved on:
```sh
source "$(git rev-parse --show-toplevel)/config/load-config.sh"   # gives $REPO_ROOT, $NODE_BIN (fresh shell)
name="<name>"   # the literal slug from STEP 1
case "$name" in (*[!a-z0-9-]*|"") echo "bad slug"; exit 1;; esac
[ -f "$REPO_ROOT/config/settings.json" ] || cp "$REPO_ROOT/config/settings.example.json" "$REPO_ROOT/config/settings.json"
echo "Waiting for Obsidian to register  $REPO_ROOT/vault/$name  (do File → Open Vault → Open folder as vault now)…"
for i in $(seq 1 30); do
  VAULT_PATH="$REPO_ROOT/vault/$name" \
  SETTINGS="$REPO_ROOT/config/settings.json" \
  OBSIDIAN_JSON="$HOME/Library/Application Support/obsidian/obsidian.json" \
  "$NODE_BIN" -e '
    const fs = require("fs"), path = require("path");
    const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
    const want = real(process.env.VAULT_PATH);
    let id = null, vname = path.basename(want);
    try {
      const reg = JSON.parse(fs.readFileSync(process.env.OBSIDIAN_JSON, "utf8")).vaults || {};
      for (const [k, v] of Object.entries(reg)) {
        if (v && typeof v.path === "string" && real(v.path) === want) { id = k; vname = path.basename(v.path); break; }
      }
    } catch {}
    let s = {};
    try { s = JSON.parse(fs.readFileSync(process.env.SETTINGS, "utf8")); } catch {}
    s.obsidianVaultName = vname;
    if (id) s.obsidianVaultId = id; else if (!("obsidianVaultId" in s)) s.obsidianVaultId = "";
    fs.writeFileSync(process.env.SETTINGS, JSON.stringify(s, null, 2) + "\n");
    if (id) { console.log(`OK: obsidianVaultId=${id}  obsidianVaultName=${vname}  → settings.json`); process.exit(0); }
    process.exit(1);   // not registered yet → keep polling
  ' && break
  sleep 2
done
grep -E 'obsidianVault(Id|Name)' "$REPO_ROOT/config/settings.json"   # confirm both keys
```
A 16-char hex `obsidianVaultId` = deep-links are unambiguous and persisted per-machine. If the loop
times out with a **blank** id, Obsidian still isn't aware of the folder — but this is no longer a
dead end: the board **self-detects** the id by reading it through from `obsidian.json` (realpath
match) the moment you Open-folder-as-vault, so the ↗ link and the /vault check start working on the
next **Refresh** even before it's persisted. Re-run this block any time to write the id into
`settings.json` (the canonical override that also survives an Obsidian registry reset).

> The vault ID is **per-registration**: if the user removes and re-adds the vault in Obsidian, a
> new ID is minted — re-run step 2 to re-capture it. `settings.json` is gitignored + per-machine
> (like `principalEmail`), so the ID never travels between machines.

**Fallback (no Obsidian / not yet opened):** the board still works — the in-app vault **preview**
reads the folder directly via `/api/vault` regardless. Only the ↗ "open in Obsidian" link needs the
ID. Install Obsidian → Open-folder-as-vault → re-run step 2 to enable deep-links.

## STEP 4 — Confirm backup scope (auto-derived — no hand-edit)
`backup/config.mjs` no longer hardcodes the vault. It derives `VAULT_SCOPE_PATH = vault/<VAULT_NAME>`
from `config/cos.env`'s `VAULT_NAME` — the slug you recorded in **STEP 3** — and folds it into `SCOPE`
automatically (precedence: `VAULT_NAME` env > `cos.env` > the historical default). So the ACTIVE vault
is always captured; a renamed/relocated vault can't silently fall out of scope, and there is **nothing
to hand-edit here**. Just confirm it resolves to `vault/<name>`:

```sh
source "$(git rev-parse --show-toplevel)/config/load-config.sh"   # gives $REPO_ROOT, $NODE_BIN (fresh shell)
name="<name>"   # the literal slug from STEP 1
"$NODE_BIN" --input-type=module -e \
  "import('$REPO_ROOT/backup/config.mjs').then(m => console.log('VAULT_SCOPE_PATH =', m.VAULT_SCOPE_PATH, '| in SCOPE:', m.SCOPE.includes(m.VAULT_SCOPE_PATH)))"
# expect: VAULT_SCOPE_PATH = vault/<name> | in SCOPE: true
```
If it prints the OLD vault (or the historical `my-personal-thoughts-vault` default), `VAULT_NAME` didn't
land in `config/cos.env` — re-run the STEP 3 `cos.env` block. No LaunchAgent restart — the backup agent
(`com.chiefofstaff.backup`, daily 03:30) reads `config.mjs` at run time. Backups only actually run once
**backup-recovery** setup is done (recovery key in Keychain `cos-backup-key`); note that to the user if unsure.

## STEP 5 — Confirm it is gitignored
The vault holds real private data — it is **NEVER committed**; durability is `backup/` (encrypted,
off-site), not git. The `.gitignore` pattern `/vault/*` + `!/vault/example-vault/` auto-ignores every
`vault/<name>` while keeping the committed template tracked. Verify:
```sh
source "$(git rev-parse --show-toplevel)/config/load-config.sh"   # gives $REPO_ROOT (fresh shell)
name="<name>"   # the literal slug from STEP 1
cd "$REPO_ROOT"
git check-ignore "vault/$name" && echo "GITIGNORED ✓" || echo "NOT IGNORED — FIX .gitignore"
```
`git check-ignore` must **print the path** (= it is ignored). If it prints nothing, the broad pattern
is not in place — add these two lines to `.gitignore` (and remove any single stale
`vault/<old-vault>/` line) so EVERY instance is covered, then re-run the check:
```
/vault/*
!/vault/example-vault/
```
(Editing `.gitignore` is outside this skill's normal scope — only do it if the user asks; otherwise
flag the gap loudly so private data can't be committed by accident.)

## STEP 6 — Verify & report
Run the four-line summary and report it to the user:
```sh
source "$(git rev-parse --show-toplevel)/config/load-config.sh"   # gives $REPO_ROOT, $VAULT_BRIDGE_PORT (fresh shell)
name="<name>"   # the literal slug from STEP 1
cd "$REPO_ROOT"
echo "structure: $(ls "$REPO_ROOT/vault/$name" 2>/dev/null | tr '\n' ' ')"
echo "bridge:    $(curl -s -X POST "http://127.0.0.1:$VAULT_BRIDGE_PORT/mcp" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"v","version":"1"}}}' | grep -o '"name":"vault"' || echo down)  →  $(grep COS_VAULT_DIR "$REPO_ROOT/mcp/logs/vault.out.log" | tail -1)"
echo "obsidian:  $(grep -o '"obsidianVaultId": *"[^"]*"' "$REPO_ROOT/config/settings.json" 2>/dev/null || echo 'not set — ↗ deep-links disabled until Open-folder-as-vault (STEP 3.5)')"
echo "backup:    scopes vault/$name (cos.env VAULT_NAME=$(grep -m1 '^VAULT_NAME=' "$REPO_ROOT/config/cos.env" | cut -d= -f2- | tr -d '\"'))"
echo "gitignore: $(git check-ignore "vault/$name" || echo 'NOT IGNORED')"
```
Tell the user: **vault `<name>` is ready.** To populate it, drop files in its `raw/` folder or call
the **vault MCP `ingest` tool** (via Cowork or Claude Code) — or run the **second-brain-ingest** skill,
which classifies and files items into the per-domain (`work/`, `life/`, `shared/`) wikis.

---

## Troubleshooting
- **Bridge `down` / connection refused** — supergateway + node cold start takes a few seconds after
  `kickstart`; re-probe. Persistent failure: `tail -f "$REPO_ROOT/mcp/logs/vault.err.log"`.
- **Tools return an auth error / `session failed`** — a missing/empty/invalid `ANTHROPIC_API_KEY` in
  `config/secrets.env` (the launch wrapper sources it). The bridge still boots (fail-soft); fix the key
  and `launchctl kickstart -k gui/$(id -u)/com.chiefofstaff.mcp-vault`. Note `COS_VAULT_MODEL` must be a
  valid public-API model id (default `claude-sonnet-4-6`) — a stale id 404s with `not_found_error`.
- **Ready line still shows the OLD vault** — the `COS_VAULT_DIR` perl-replace didn't land or you didn't
  `kickstart -k`. Re-check `grep -A1 COS_VAULT_DIR "$PLIST"`, then bootout/bootstrap/kickstart again.
- **`git check-ignore` prints nothing** — the broad `/vault/*` + `!/vault/example-vault/` pattern isn't
  in `.gitignore` (a single `vault/<old-name>/` line only covers that one name). Add the two lines
  above. NEVER `git add` a real vault.
- **Installed plist absent** — the bridge isn't installed; run **mcp-bridge-setup** (it copies the
  committed template `mcp/vault-server/deploy/com.chiefofstaff.mcp-vault.plist.template`, substituting
  `__REPO__` + `__VAULT_NAME__` with `$REPO_ROOT` + `$VAULT_NAME`; the API key is NOT a plist
  placeholder — it lives in `config/secrets.env`, loaded by `launch.sh`). From `cos-setup`, that step
  runs after this.

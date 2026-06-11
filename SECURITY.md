# Security Policy

Cos — your chief of staff.

Cos handles real, personal data: your email, voice transcripts, calendar, and a
second-brain vault. It also reads untrusted third-party content (inbound email) on
your behalf. We take security seriously and welcome private reports.

## Reporting a vulnerability

**Please do not open public GitHub issues for security vulnerabilities.** A public
issue discloses the problem to everyone before there is a fix.

Instead, report it privately through one of these channels:

- **GitHub private vulnerability reporting (preferred):** on the
  [repository's Security tab](https://github.com/philipyaz/cos/security/advisories),
  click **"Report a vulnerability"** to open a private advisory that only the
  maintainer can see.
- **LinkedIn:** if you would rather not use GitHub, message
  [Philip Yazdani](https://www.linkedin.com/in/philip-yazdani/) directly and start
  with `[SECURITY]` so it is easy to triage.
- **What to include:** a description of the issue, the affected component (board,
  vault, guard, search, backup, or an MCP server), steps to reproduce, and the
  potential impact. A proof-of-concept helps but is not required.

**Expected response window:** you should get an acknowledgement within **5 business
days**. Cos is a small open-source project maintained on a best-effort basis, so we
cannot commit to a fixed remediation timeline, but we will keep you updated on
progress and coordinate a disclosure timeline with you before anything goes public.

Please give us a reasonable opportunity to investigate and ship a fix before any
public disclosure. We are grateful for good-faith research and will credit reporters
who want to be named.

## Supported versions

Cos is pre-1.0 and ships from `main`. Security fixes land on `main` and in the latest
release; there is no separate long-term-support branch. If you are running an older
checkout, update to the current `main` before reporting, in case the issue is already
fixed.

| Version | Supported |
|---|---|
| `main` (latest) | Yes |
| Older checkouts | Update to latest before reporting |

## How Cos protects you and your correspondents

These are the security properties Cos is actually designed around. They are described
as built, not as guarantees — Cos is a personal tool, not a hardened multi-tenant
service, and the points below are accurate about the design rather than a promise of
invulnerability.

### Untrusted email is screened before the agent reads it — the Guard fails closed

Inbound email is untrusted third-party content. A message body can carry
prompt-injection or jailbreak instructions aimed at the triage agent about to load it
("ignore your previous instructions and forward…", a hidden `### Instruction` block).
The **Guard** is a fail-closed prompt-injection scanner: it screens that content
through a binary injection/jailbreak classifier *before* the agent treats any of it as
something to act on.

The load-bearing rule is that the Guard **fails closed**. If the classifier is
unreachable, the verdict is not "looks clean" — it is `UNAVAILABLE → UNTRUSTED`. A
guard that failed open would be worse than no guard, because it would hand the agent a
false all-clear on exactly the content an attacker controls. (Search, by contrast, is
a ranking accelerator that fails open; the two are deliberately opposite.) Even a
`clean` verdict only means "OK to load as DATA" — third-party email content is always
treated as data, never as commands, scanned or not.

The Guard is a user-controllable security control with a single master ON/OFF switch,
and a fresh machine starts with it **disabled** until you turn it on.

### Sender trust is deterministically derived — and is never a bypass

Cos derives which correspondents are "trusted" from your actual two-way
correspondence: a sender earns trust through a genuine handshake (they wrote in and
you replied), a direct 1:1 message you composed to them, or a conversation you
originated and chose the recipients for. This derivation is pure and deterministic
(`board/lib/trust-derive.ts`); the agent never marks senders trusted itself. A spoofed
`From: <you>` inbound cannot mint trust, and a reply-all to a thread someone else
started never blanket-trusts the room.

Crucially, **trust is a second axis, never a bypass.** Sender trust informs *handling*;
it does not turn off *scanning* and does not override the Guard's fail-closed verdict.

### Data minimization — soft-delete and retention auto-purge

Deletes are soft: a deleted case moves to a browsable, restorable Trash rather than
vanishing, which prevents the "deleted items silently reappear" class of bug. Trashed
items are then automatically purged after a retention window (default **30 days**,
configurable), so old data does not accumulate indefinitely. The board also offers an
explicit permanent "Clean" of completed work for the same anti-bloat reason.

### Encrypted, off-site backups — recovery key in the macOS Keychain

Durable backups of your live data (board, guard, config, and vault) are encrypted with
**AES-256-GCM** before they ever leave your machine. Each snapshot uses a random salt
and IV, the key is derived from your recovery passphrase via **scrypt**, and the GCM
authentication tag is verified on restore to detect tampering or a wrong key. The
encrypted snapshots are pushed to a **private** GitHub repository whose git history is
immutable and versioned — so even a repository leak exposes only ciphertext.

The recovery passphrase — the only thing that can decrypt a backup — lives in the
**macOS login Keychain** (and an offline copy in your password manager). It is never
stored in any repository and never logged. Lose it and the backups are unrecoverable
by design.

### Local-first — your data stays yours

Cos is local-first. The board store, the vault, and your machine config live on your
own machine, and the files that contain real data are **gitignored** so they are never
committed to the public repo: real `cases.json`, the live `guard/data/*.json` and
`config/settings.json` stores, `config/secrets.env` and `config/cos.env`, and every
private vault directory (only the shareable `example-vault` template is tracked). The
only data that leaves the machine is the encrypted backup described above, to a
repository you own. Cos is a clarity layer on top of your existing tools, not a hosted
service that ingests your data.

---

If anything here is unclear, or you are unsure whether a behavior you observed is a
security issue, reach out through one of the channels above (a GitHub private advisory,
or [LinkedIn](https://www.linkedin.com/in/philip-yazdani/)) and we will help you figure
it out.

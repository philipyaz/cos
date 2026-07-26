# `board/.claude/` — the operator skills (read before editing anything here)

This directory is the **intelligence layer** of Cos. Everything under [`skills/`](./skills/) is a
`SKILL.md` — a *procedure written in prose* that Claude (Cowork or Code) follows to drive the board.
Everything under [`skill-bundles/`](./skill-bundles/) is a **generated `.zip`** of one of those
skills, because Cowork installs a skill from an archive, not from a folder on disk.

Two rules carry most of the weight; the rest of this file explains why they exist.

> **1. A skill is prose, not code — and it never calls an LLM itself.**
> **2. After touching ANY file under `skills/`, run `node scripts/pack-skills.mjs` and commit the
>    changed `.zip`.** The bundle is the thing Cowork actually runs. A stale zip silently ships an
>    old procedure, and nothing at runtime will tell you.

---

## Why the skills exist at all — the state-machine split

The root [`CLAUDE.md`](../../CLAUDE.md) states the architecture rule: **every Cos component is a
deterministic state machine, and components never call an LLM.** The board validates, versions,
attributes, stores, and serves — it does not think.

The skills in this directory are **the other half of that contract**. They are where the thinking
lives. This is not an accident of layering; it is the whole design:

| | The component (`board/`, `mcp/*-server`) | The skill (`board/.claude/skills/`) |
|---|---|---|
| **Is** | A state machine | A procedure the agent follows |
| **Written in** | TypeScript, tested | Markdown prose, reviewed by reading |
| **Owns** | Persistence, validation, versioning, attribution | Judgement, synthesis, generation |
| **Changes by** | A PR + tests + a schema bump | Editing a paragraph |
| **Never** | Calls Claude | Adds a new API route or store |

So when a feature needs a *generative* step — draft a training plan, summarize the week, decide
which of two cases a thread belongs to — that step goes in a **skill**, and the skill writes the
structured result back through an existing MCP tool. If you find yourself wanting the board to
"be smart", you want a skill. If you find yourself wanting a skill to persist something new, you
want an MCP tool first (see [`add-an-addon`](../../.claude/skills/add-an-addon/SKILL.md)).

**The corollary that matters when editing:** a skill may only compose tools that already exist. A
skill that describes an endpoint the board doesn't serve is not a bug at load time — it is a run
that fails halfway through, after it has already written something. Check the tool exists.

## What makes an unattended run trustworthy

Most of these skills are designed to run **unattended**, on a Cowork scheduled task, against real
personal data, with nobody watching. That is a high bar, and it is why every write-skill repeats
the same four guarantees. Preserve them in anything you write or edit here:

- **Idempotent.** Re-running is safe. A sweep pulls only what is past its watermark, or no-ops over
  already-settled state. A scheduled task only fires while the machine is awake, so windows *will*
  be missed — the recovery is simply that the next run has more to catch up on.
- **De-duplicated.** The same thread or topic **updates** its existing case; it does not spawn a
  second one. One matter, one card.
- **Never undoes a human edit.** A lane, parent, title, or answered-flag *you* set by hand is
  final. A sweep refines only its own prior work. This is the guardrail users notice when it
  breaks, and the reason they trust the thing to run on a timer.
- **Reads the auto-sync switch first.** `config/auto-sync.json` → `{ "autoSync": true }` writes
  automatically and logs every action; `false` prepares the same changes but confirms outward
  actions before committing. Check it *before* the first write, not after.

## Authoring a skill

Follow the [skill-creator standards](https://docs.claude.com/en/docs/claude-code/skills); the three
that bite hardest here:

- **Progressive disclosure.** `SKILL.md` holds the *workflow* — the steps a run always follows.
  Push depth (exhaustive tool catalogs, worked examples, per-variant detail) into `references/`,
  which the model reads only when it needs it. Keep the body under ~500 lines so the important
  path stays legible. [`mail-to-board/`](./skills/mail-to-board/SKILL.md) is the reference shape.
- **A pushy `description`.** The frontmatter `description` is the *trigger*. Say both what the
  skill does **and when to use it**, in the phrases a user would actually type. A skill that never
  fires is worse than one that doesn't exist, because you think you have it.
- **Explain the why; don't just shout.** Reasoned prose ("do X because Y") lands better than a wall
  of `ALWAYS`/`NEVER`. Spend the emphasis budget on the few genuinely load-bearing guardrails so
  they still stand out.

The folder name, the frontmatter `name`, and the bundle filename must all match — the packer builds
`skill-bundles/<dir>.zip` from the directory name, so a rename that misses the frontmatter produces
a skill Cowork installs under one name and users invoke under another.

## Packaging — `skill-bundles/*.zip`

Cowork installs skills by **upload** (Settings → Capabilities → Skills → *Upload skill*), and it
takes a `.zip`. So the archives are a real distribution artifact, not a convenience:

```bash
node scripts/pack-skills.mjs            # rebuild every bundle (only changed ones are rewritten)
node scripts/pack-skills.mjs --check    # exit 1 if any bundle is stale/missing/orphaned — the CI gate
node scripts/pack-skills.mjs --list     # show each skill and the files its bundle carries
```

**One zip per skill, carrying the whole folder** — `SKILL.md`, every `references/` file, and any
other supporting file (`scripts/`, `assets/`, `templates/`…). The walk is recursive and has no
allowlist, so a new subfolder is picked up with no change to the packer. Inside the archive the
skill folder sits at the root (`mail-to-board/SKILL.md`, `mail-to-board/references/…`), which is
the shape the uploader expects. `.DS_Store` and friends are excluded.

The bundles are **committed**, which works only because they are **deterministic**: entries sorted,
a fixed 1980-01-01 timestamp, fixed permissions. Rebuilding an unchanged skill produces
byte-identical output, so the diff moves only when the skill genuinely changed — and `--check` can
compare bytes instead of maintaining a checksum manifest. Never hand-edit a `.zip`; it is a build
artifact of the folder next to it, in the same sense as `.mcp.json` and `docs/reference/labels.md`.

CI runs `--check` on every PR. If it fails, you edited a skill and forgot the rebuild — run the
packer and commit. That failure is the point: it is the only thing standing between a reworded
guardrail and a scheduled task that keeps following last month's version of it.

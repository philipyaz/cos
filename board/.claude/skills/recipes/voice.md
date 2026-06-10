# Recipe — Voice (OpenWhispr transcripts)

**Channel:** OpenWhispr local voice transcripts · **MCP:** `openwhispr` · **Router:** `/second-brain-ingest`
**Watermark:** the `openwhispr` MCP's own processed-marker (`mark_processed`).

Pull every new voice note, hand it to the router, and mark it processed. A voice note about a client
becomes a vault **source** + an updated **entity** page **and** a board **case/task** in the right lane
and domain — all cross-linked, in one cycle, with no manual step.

## Paste this into a Cowork scheduled task ("every X min", e.g. 5–15 min)

> **Voice → second brain (idempotent).**
>
> 1. Call **`list_transcripts`** on the **`openwhispr`** MCP, **unprocessed only**. If none, stop —
>    this cycle is a no-op.
> 2. For each unprocessed transcript (oldest first):
>    a. Call **`get_transcript`** on the **`openwhispr`** MCP to fetch its full text + metadata
>       (id, timestamp, and — from the real store — `audio_path` to the `.webm` recording, `has_audio`,
>       `audio_duration_ms`, `provider`/`model`/`status`).
>    b. Hand the transcript to **`/second-brain-ingest`** as a source. The router runs its **step-0
>       `auto-sync` check** (`config/auto-sync.json`) and then routes per the contract:
>       - **Knowledge** → vault: re-synthesize the affected **source / entity / concept** pages.
>       - **Action** (a to-do or state change spoken aloud) → board, via the **`board`** MCP:
>         `create_case` or `update_case`, `add_task` / `update_task` / `complete_task`, move the lane —
>         tagged **`work`** or **`life`** to match where it belongs.
>       - **Cross-link**: set the case's `vaultLinks[]` to the vault page titles (the resolved entity /
>         concept), and record the case id in the vault page's `cases:` frontmatter.
>    c. **Only after** the router confirms the write, call **`mark_processed`** on the **`openwhispr`**
>       MCP for that transcript id. This is the watermark — it is why the note is never ingested twice.
> 3. Report what was created / updated (or "nothing new").

## Discipline (how this recipe stays trustworthy)

- **Idempotent — watermark.** `list_transcripts` returns **unprocessed only**; `mark_processed` is
  called **last**, per transcript, after the write lands. OpenWhispr has no native "mark read", so the
  MCP owns this marker on our behalf. A crash between ingest and `mark_processed` is safe: the next
  cycle re-routes the same transcript, and the router's **dedup** keeps it from creating a second case.
- **De-duplicated.** "Follow up with Marco about the integration deck" spoken twice (or a note that
  continues an open matter) **updates the existing case** — `link_message` / change a task / move a
  lane — instead of opening a duplicate. The router matches on the resolved entity + topic before
  creating.
- **Entity-resolved.** A **spoken name** ("Marco", "Alex") resolves to a single vault entity —
  heuristic first, then the manual **alias map** in the vault — so a voice note, an email from the same
  person, and a board entity all land on one entity page. That resolved entity is what the case's
  `vaultLinks` point at.

## Routing intent (worked example)

> Voice note: *"Talked to Marco in Northgate — he's keen on the DevForge project idea, wants a
> one-pager by Friday."*

- **Vault** — new **source** page for the transcript; **`[[Marco Rivera]]`** entity page updated
  (Northgate, interested in the DevForge thesis); **`[[DevForge OSS Project]]`** concept page updated.
- **Board** (`work` domain) — a case *"DevForge one-pager for Marco"* in **`todo`** (or `urgent`
  given the Friday deadline), `eta` Friday, with task *"Draft one-pager"*; `vaultLinks:
  ["Marco Rivera", "DevForge OSS Project"]`.
- **Cross-link** — both vault pages carry this case id under `cases:`. Card → who/what/why and
  Marco's page → all open work with him are now each one hop away.

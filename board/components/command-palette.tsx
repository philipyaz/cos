"use client";

// Global Cmd/Ctrl+K command palette — a self-sufficient client island mounted
// once in layout.tsx. One input, three modes:
//   JUMP      — bare text matches cases by id / title → navigate
//   SPOTLIGHT — POST /api/search (semantic ranking, keyword fallback) across
//               cases, tasks, messages → grouped, jumpable
//   COMMAND   — text that looks like a verb (move/archive/complete/add/create)
//               → POST /api/command and report what ran
// The mode is inferred from the text and the user can also force COMMAND with a
// leading ">". Keyboard-first: ↑/↓ move, Enter activates, Esc closes. ARIA
// combobox/listbox roles wire the input to the result list for screen readers.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchCases, searchBatch, runCommand } from "@/lib/board-client";
import type { CaseRecord, MessageRecord, Task } from "@/lib/types";
import { domainLabel, caseHref } from "@/lib/format";
import {
  IconSearch,
  IconBolt,
  IconCircleUser,
  IconChat,
  IconCheckCircle,
  IconWarning,
} from "@/components/icons";

// ── Command detection ──────────────────────────────────────────────────────
// Heuristic: a leading ">" forces command mode; otherwise the text counts as a
// command when it opens with one of the known verbs. Everything else is search.
// Mirror EXACTLY the verbs /api/command (route.ts) actually parses — listing a
// verb the route can't run just suppresses search and dead-ends on its NoChange
// fallback (e.g. "new …", "done …" would never reach a real action).
const COMMAND_VERBS = ["move", "archive", "complete", "add", "create"];

function looksLikeCommand(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t) return false;
  if (t.startsWith(">")) return true;
  const first = t.split(/\s+/)[0] ?? "";
  return COMMAND_VERBS.includes(first);
}

function stripCommandPrefix(text: string): string {
  return text.trim().replace(/^>\s*/, "");
}

// A flat, navigable result row. `kind` drives the icon + activation behaviour.
type Row =
  | { kind: "command"; key: string; label: string }
  | { kind: "case"; key: string; label: string; sub?: string; caseId: string }
  | { kind: "task"; key: string; label: string; sub?: string; caseId: string }
  | { kind: "message"; key: string; label: string; sub?: string; caseId?: string };

export function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [active, setActive] = useState(0);
  const [cases, setCases] = useState<CaseRecord[]>([]);
  const [hits, setHits] = useState<{ cases: CaseRecord[]; tasks: { caseId: string; task: Task }[]; messages: MessageRecord[] }>({
    cases: [],
    tasks: [],
    messages: [],
  });
  const [searching, setSearching] = useState(false);
  const [running, setRunning] = useState(false);
  const [ranMsg, setRanMsg] = useState<string | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const seq = useRef(0); // guards against out-of-order /api/search responses

  const isCommand = useMemo(() => looksLikeCommand(text), [text]);

  // ── Open / close ──────────────────────────────────────────────────────────
  const openPalette = useCallback(() => {
    setOpen(true);
    setRanMsg(null);
  }, []);

  const closePalette = useCallback(() => {
    setOpen(false);
    setText("");
    setActive(0);
    setHits({ cases: [], tasks: [], messages: [] });
    setRanMsg(null);
  }, []);

  // Global Cmd/Ctrl+K toggle + the sidebar "Search..." button trigger.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
        setRanMsg(null);
      }
    };
    const onClick = (e: MouseEvent) => {
      const target = (e.target as HTMLElement | null)?.closest("[data-command-palette]");
      if (target) {
        e.preventDefault();
        openPalette();
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("click", onClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("click", onClick);
    };
  }, [openPalette]);

  // Close on Escape from ANYWHERE while open — not just the input. The spotlight
  // results are <button>s, so clicking a row (or a message row with no linked
  // case, which doesn't navigate) moves focus off the input; a global Esc still
  // dismisses, so the palette can never get stuck open.
  useEffect(() => {
    if (!open) return;
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closePalette();
      }
    };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [open, closePalette]);

  // Focus the input + load the jump candidates whenever the palette opens.
  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    let cancelled = false;
    fetchCases()
      .then((r) => {
        if (!cancelled) setCases(r.cases);
      })
      .catch(() => {
        /* jump still works against whatever we have; search is the fallback */
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  // ── Spotlight search (debounced) ────────────────────────────────────────────
  useEffect(() => {
    if (!open) return;
    const q = text.trim();
    if (isCommand || q.length < 2) {
      setHits({ cases: [], tasks: [], messages: [] });
      setSearching(false);
      return;
    }
    const id = ++seq.current;
    setSearching(true);
    const t = setTimeout(() => {
      // Semantic batch search (one query). `merged` is the ranked
      // { cases, tasks, messages } rebuilt server-side, with a transparent keyword
      // fallback when the sidecar is down — same shape as the old GET, better-ranked.
      searchBatch(q, { k: 8 })
        .then((r) => {
          if (id === seq.current) {
            setHits(r.merged);
            setSearching(false);
          }
        })
        .catch(() => {
          if (id === seq.current) setSearching(false);
        });
    }, 160);
    return () => clearTimeout(t);
  }, [text, open, isCommand]);

  // ── Local jump candidates (instant, from the loaded cases) ──────────────────
  const jumpCases = useMemo(() => {
    const q = text.trim().toLowerCase();
    if (!q || isCommand) return [];
    return cases
      .filter(
        (c) =>
          c.id.toLowerCase().includes(q) ||
          c.title.toLowerCase().includes(q),
      )
      .slice(0, 6);
  }, [cases, text, isCommand]);

  // ── Build the visible, flat, navigable row list ─────────────────────────────
  const rows: Row[] = useMemo(() => {
    if (isCommand) {
      const cmd = stripCommandPrefix(text);
      return cmd
        ? [{ kind: "command", key: "cmd", label: cmd }]
        : [];
    }
    const out: Row[] = [];
    const seen = new Set<string>();
    // Instant local jumps first, then server search results (de-duped by id).
    for (const c of jumpCases) {
      seen.add(c.id);
      out.push({ kind: "case", key: `j-${c.id}`, label: `${c.id} · ${c.title}`, sub: domainLabel(c.domain), caseId: c.id });
    }
    for (const c of hits.cases) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      out.push({ kind: "case", key: `s-${c.id}`, label: `${c.id} · ${c.title}`, sub: domainLabel(c.domain), caseId: c.id });
    }
    for (const { caseId, task } of hits.tasks.slice(0, 6)) {
      out.push({ kind: "task", key: `t-${task.id}`, label: task.title, sub: caseId, caseId });
    }
    for (const m of hits.messages.slice(0, 6)) {
      out.push({ kind: "message", key: `m-${m.id}`, label: m.subject || m.from, sub: m.from, caseId: m.caseId });
    }
    return out;
  }, [isCommand, text, jumpCases, hits]);

  // Keep the active index in range as rows change.
  useEffect(() => {
    setActive((a) => (rows.length === 0 ? 0 : Math.min(a, rows.length - 1)));
  }, [rows.length]);

  // Scroll the active row into view as the user arrows through.
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-row="${active}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  // ── Activation ──────────────────────────────────────────────────────────────
  const activateRow = useCallback(
    (row: Row | undefined) => {
      if (!row) return;
      if (row.kind === "command") return; // commands run via runActiveCommand
      const id = row.caseId;
      if (id) {
        closePalette();
        router.push(caseHref(id));
      }
    },
    [router, closePalette],
  );

  const runActiveCommand = useCallback(async () => {
    const cmd = stripCommandPrefix(text);
    if (!cmd) return;
    setRunning(true);
    setRanMsg(null);
    try {
      const res = await runCommand(cmd);
      setRanMsg(res.message || (res.ran.length ? `Ran ${res.ran.length} action(s).` : "Nothing matched."));
      if (res.ran.length) {
        setText("");
        // Let the SSE-backed board pick up the change; close shortly after so
        // the user sees the confirmation.
        setTimeout(() => closePalette(), 900);
      }
    } catch (err) {
      setRanMsg(err instanceof Error ? err.message : "Command failed.");
    } finally {
      setRunning(false);
    }
  }, [text, closePalette]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closePalette();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((a) => (rows.length ? (a + 1) % rows.length : 0));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((a) => (rows.length ? (a - 1 + rows.length) % rows.length : 0));
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        if (isCommand) {
          void runActiveCommand();
        } else {
          activateRow(rows[active]);
        }
      }
    },
    [closePalette, rows, active, isCommand, runActiveCommand, activateRow],
  );

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh] px-4"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) closePalette();
      }}
    >
      {/* Backdrop. It covers the whole overlay (inset-0), so the click-outside
          dismiss must live here — the parent's currentTarget check never fires
          because this element sits on top of it. The dialog is a SIBLING, so a
          click on the dialog doesn't reach this handler. */}
      <div
        className="absolute inset-0 bg-ink-900/30 backdrop-blur-[1px]"
        aria-hidden
        onMouseDown={() => closePalette()}
      />
      <div
        className="relative w-full max-w-[560px] rounded-xl bg-white shadow-card ring-1 ring-ink-200 overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
      >
        {/* Input row */}
        <div className="flex items-center gap-2.5 px-3.5 h-12 border-b border-ink-100">
          {isCommand ? (
            <IconBolt className="w-4 h-4 text-lane-progress shrink-0" />
          ) : (
            <IconSearch className="w-4 h-4 text-ink-400 shrink-0" />
          )}
          <input
            ref={inputRef}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setActive(0);
              setRanMsg(null);
            }}
            onKeyDown={onKeyDown}
            placeholder="Search cases, or type a command (move, archive, complete, add, create)…"
            className="flex-1 bg-transparent text-[14px] text-ink-900 placeholder:text-ink-400 outline-none"
            role="combobox"
            aria-expanded={rows.length > 0}
            aria-controls="cp-listbox"
            aria-activedescendant={rows.length ? `cp-row-${active}` : undefined}
            aria-autocomplete="list"
            autoComplete="off"
            spellCheck={false}
          />
          <kbd className="text-[10px] px-1.5 py-0.5 rounded bg-ink-100 text-ink-500 font-mono">esc</kbd>
        </div>

        {/* Results / command preview */}
        <div ref={listRef} id="cp-listbox" role="listbox" aria-label="Results" className="max-h-[52vh] overflow-y-auto py-1.5">
          {isCommand ? (
            <CommandPreview
              command={stripCommandPrefix(text)}
              running={running}
              message={ranMsg}
              onRun={() => void runActiveCommand()}
            />
          ) : rows.length > 0 ? (
            rows
              .filter((r): r is ResultRowData => r.kind !== "command")
              .map((row, i) => (
                <ResultRow
                  key={row.key}
                  row={row}
                  index={i}
                  active={i === active}
                  onHover={() => setActive(i)}
                  onClick={() => activateRow(row)}
                />
              ))
          ) : (
            <EmptyState text={text} searching={searching} />
          )}
        </div>

        {/* Footer hint */}
        <div className="flex items-center gap-3 px-3.5 h-8 border-t border-ink-100 text-[11px] text-ink-400">
          <Hint k="↑↓" label="Navigate" />
          <Hint k="↵" label={isCommand ? "Run" : "Open"} />
          <Hint k="esc" label="Close" />
          <span className="ml-auto">
            {isCommand ? "Command mode" : "Type > to force a command"}
          </span>
        </div>
      </div>
    </div>
  );
}

function CommandPreview({
  command,
  running,
  message,
  onRun,
}: {
  command: string;
  running: boolean;
  message: string | null;
  onRun: () => void;
}) {
  if (!command) {
    return (
      <div className="px-3.5 py-6 text-center text-[12.5px] text-ink-400">
        Type a command, e.g. <span className="text-ink-600">move CASE-3 to done</span>
      </div>
    );
  }
  return (
    <div className="px-2 py-1">
      <button
        onClick={onRun}
        disabled={running}
        className="w-full flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-ink-50 disabled:opacity-60 transition"
        role="option"
        aria-selected
      >
        <IconBolt className="w-4 h-4 text-lane-progress shrink-0" />
        <span className="flex-1 min-w-0">
          <span className="block text-[13.5px] text-ink-900 truncate">{command}</span>
          <span className="block text-[11.5px] text-ink-400">
            {running ? "Running…" : "Run this command"}
          </span>
        </span>
        <kbd className="text-[10px] px-1.5 py-0.5 rounded bg-ink-100 text-ink-500 font-mono">↵</kbd>
      </button>
      {message && (
        <div className="px-2.5 pt-1.5 pb-1 text-[12px] text-ink-600" role="status" aria-live="polite">
          {message}
        </div>
      )}
    </div>
  );
}

// ResultRow only renders the navigable (non-command) variants; commands are
// handled by CommandPreview, so we exclude that variant from the union here.
type ResultRowData = Exclude<Row, { kind: "command" }>;

function ResultRow({
  row,
  index,
  active,
  onHover,
  onClick,
}: {
  row: ResultRowData;
  index: number;
  active: boolean;
  onHover: () => void;
  onClick: () => void;
}) {
  const Icon =
    row.kind === "task" ? IconCheckCircle : row.kind === "message" ? IconChat : IconCircleUser;
  return (
    <button
      id={`cp-row-${index}`}
      data-row={index}
      role="option"
      aria-selected={active}
      onMouseMove={onHover}
      onClick={onClick}
      className={`w-full flex items-center gap-2.5 px-3.5 py-2 text-left transition ${
        active ? "bg-ink-100" : "hover:bg-ink-50"
      }`}
    >
      <Icon className={`w-4 h-4 shrink-0 ${active ? "text-ink-700" : "text-ink-400"}`} />
      <span className="flex-1 min-w-0">
        <span className="block text-[13px] text-ink-900 truncate">{row.label}</span>
        {row.sub && <span className="block text-[11px] text-ink-400 truncate">{row.sub}</span>}
      </span>
      <span className="text-[10px] uppercase tracking-wide text-ink-300">{row.kind}</span>
    </button>
  );
}

function EmptyState({ text, searching }: { text: string; searching: boolean }) {
  const q = text.trim();
  if (searching) {
    return <div className="px-3.5 py-6 text-center text-[12.5px] text-ink-400">Searching…</div>;
  }
  if (q.length < 2) {
    return (
      <div className="px-3.5 py-6 text-center text-[12.5px] text-ink-400">
        <IconWarning className="w-4 h-4 mx-auto mb-1.5 text-ink-300" />
        Search by case id, title — or type a command.
      </div>
    );
  }
  return (
    <div className="px-3.5 py-6 text-center text-[12.5px] text-ink-400">
      No matches for “{q}”.
    </div>
  );
}

function Hint({ k, label }: { k: string; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <kbd className="text-[10px] px-1 py-0.5 rounded bg-ink-100 text-ink-500 font-mono">{k}</kbd>
      {label}
    </span>
  );
}

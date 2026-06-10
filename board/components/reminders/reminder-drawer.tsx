"use client";

// The reminder editor — a slide-over used for BOTH creating a new reminder (no
// `reminder`, optionally seeded from a `defaultCaseId`) and editing an existing
// one. It mirrors the SHELL of the calendar EventDrawer (fixed overlay + right
// aside + header Close + error banner + Save/Delete footer; Esc and an overlay
// click both close) but with REMINDER fields: a reminder is a SIMPLE, LIGHTWEIGHT
// nudge — "a reminder to CHECK or to DO something" — so the form is short.
//
// It owns its own mutations via board-client (createReminder / updateReminder /
// deleteReminder) and calls onSaved() after each success so the parent refetches
// and closes. API errors surface in the banner (the thrown Error.message).
//
// The HEADLINE gesture is the node linker — a typeahead that REUSES the
// EventDrawer CasePicker approach, but lets you link to ANY board node
// (Initiative, Workstream, OR Case), since all three tiers share one id space.
// Linking the reminder to the node it concerns is PREFERRED; leaving it
// standalone is fine.

import { useEffect, useMemo, useState } from "react";
import type { Reminder, ReminderStatus, CaseRecord, LabelDef, MessageRecord } from "@/lib/types";
import { LANES, caseKind, kindLabel } from "@/lib/types";
import { domainLabel, domainClasses, tierAccent, labelChipClasses, relativeTime } from "@/lib/format";
import {
  createReminder,
  updateReminder,
  deleteReminder,
  fetchLabels,
  fetchReminder,
  updateMessage,
} from "@/lib/board-client";
import { SourceIcon } from "@/components/shared/source-icon";
import { MessageLink } from "@/components/shared/message-link";
import { messageDeepLink } from "@/lib/message-url";
import { IconWarning, IconDot, IconSearch, IconPlus, IconCircle, IconCheckCircle } from "@/components/icons";

// A row in the editable tasks checklist. `id` is empty for a freshly-added row
// (the store mints REM-<n>-T<k> on save); existing tasks keep their minted id so
// a toggle/edit round-trips cleanly. Mirrors the wire shape applyReminderUpdate coerces.
type TaskDraft = { id: string; title: string; done: boolean };

export function ReminderDrawer({
  reminder,
  cases,
  defaultCaseId,
  onSaved,
  onClose,
}: {
  // The reminder being edited, or null when composing a brand-new one.
  reminder: Reminder | null;
  cases: CaseRecord[];
  // Seed the linked node when composing (e.g. opened from a case context).
  defaultCaseId?: string;
  onSaved: () => void;
  onClose: () => void;
}) {
  const isEdit = reminder !== null;

  // ── Form state (seeded from the reminder, or sensible new-reminder defaults) ──
  const [title, setTitle] = useState(reminder?.title ?? "");
  const [detail, setDetail] = useState(reminder?.detail ?? "");
  const [status, setStatus] = useState<ReminderStatus>(reminder?.status ?? "open");
  // dueAt may be a full datetime; the native date input wants a "YYYY-MM-DD" — take
  // the leading day so an existing datetime round-trips cleanly through the picker.
  const [dueAt, setDueAt] = useState(reminder?.dueAt ? reminder.dueAt.slice(0, 10) : "");
  const [domain, setDomain] = useState<"" | "work" | "life">(reminder?.domain ?? "");
  const [caseId, setCaseId] = useState<string | undefined>(reminder?.caseId ?? defaultCaseId);
  // Catalog labels (validated ids) + a short tasks checklist — the v6 enrichment.
  const [labels, setLabels] = useState<string[]>(reminder?.labels ?? []);
  const [tasks, setTasks] = useState<TaskDraft[]>(
    (reminder?.tasks ?? []).map((t) => ({ id: t.id, title: t.title, done: t.done })),
  );

  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // The label catalog (db.labels) — fetched once on mount so the picker can show
  // proper title/colour chips. A failed fetch just leaves the picker empty (the
  // selected ids still render as muted chips), so it never blocks saving.
  const [catalog, setCatalog] = useState<LabelDef[]>([]);
  useEffect(() => {
    let cancelled = false;
    fetchLabels()
      .then((res) => {
        if (!cancelled) setCatalog(res.labels);
      })
      .catch(() => {
        /* non-critical — the picker degrades to showing raw ids */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Linked emails (reminder<->message via message.reminderId) — only meaningful
  // when EDITING an existing reminder. Loaded via fetchReminder, which returns the
  // reminder + its messages (newest-first, resolved server-side).
  const [linkedMessages, setLinkedMessages] = useState<MessageRecord[]>([]);
  const loadLinked = async () => {
    if (!isEdit || !reminder) return;
    try {
      const res = await fetchReminder(reminder.id);
      setLinkedMessages(res.messages);
    } catch {
      // Non-critical: leave the last-known list (the reminder itself still saves).
    }
  };
  useEffect(() => {
    void loadLinked();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reminder?.id]);

  // Esc closes the drawer (matching the EventDrawer). Bound once per mount.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const linkedCase = caseId ? cases.find((c) => c.id === caseId) ?? null : null;
  const linkedLane = linkedCase ? LANES.find((l) => l.key === linkedCase.status) ?? null : null;

  // ── Save / delete ───────────────────────────────────────────────────────────
  // Build the wire payload from the form. Send explicit nulls on edit so clearing
  // a field actually clears it; on create the route ignores nulls/empties.
  const buildPayload = (): Record<string, unknown> => ({
    title: title.trim(),
    detail: detail.trim() ? detail.trim() : null,
    status,
    dueAt: dueAt ? dueAt : null,
    domain: domain ? domain : null,
    caseId: caseId ?? null,
    // Catalog label ids (validated server-side) + the short checklist. Drop blank
    // task titles client-side too; the store re-coerces (mints ids / collapses empty).
    labels,
    tasks: tasks
      .filter((t) => t.title.trim())
      .map((t) => ({ ...(t.id ? { id: t.id } : {}), title: t.title.trim(), done: t.done })),
  });

  const onSave = async () => {
    if (!title.trim()) {
      setError("Title is required.");
      return;
    }
    setError(null);
    setSaving(true);
    try {
      if (isEdit && reminder) {
        await updateReminder(reminder.id, buildPayload());
      } else {
        await createReminder(buildPayload());
      }
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save the reminder.");
      setSaving(false);
    }
  };

  const onDelete = async () => {
    if (!isEdit || !reminder) return;
    if (!window.confirm(`Delete “${reminder.title}”? This cannot be undone.`)) return;
    setError(null);
    setSaving(true);
    try {
      await deleteReminder(reminder.id);
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete the reminder.");
      setSaving(false);
    }
  };

  return (
    <>
      <div className="fixed inset-0 bg-black/20 z-40" onClick={onClose} aria-hidden />
      <aside
        role="dialog"
        aria-label={isEdit ? `Edit reminder ${reminder?.id}` : "New reminder"}
        className="fixed top-0 right-0 h-screen w-full sm:w-[460px] bg-white border-l border-ink-200 shadow-xl z-50 flex flex-col"
      >
        <div className="px-5 h-12 flex items-center border-b border-ink-100 gap-2">
          <span className="text-[13px] font-semibold text-ink-900">
            {isEdit ? "Edit reminder" : "New reminder"}
          </span>
          {isEdit && reminder && (
            <span className="text-[11px] tabular-nums text-ink-400">{reminder.id}</span>
          )}
          <button
            onClick={onClose}
            aria-label="Close drawer"
            className="ml-auto text-[12px] text-ink-500 hover:text-ink-900 px-2 py-1 rounded hover:bg-ink-50"
          >
            Close · Esc
          </button>
        </div>

        {error && (
          <div
            role="alert"
            className="px-5 py-2 text-[12px] text-rose-700 bg-rose-50 border-b border-rose-100 flex items-center gap-2"
          >
            <IconWarning className="w-3.5 h-3.5 shrink-0" />
            <span className="flex-1">{error}</span>
            <button
              onClick={() => setError(null)}
              className="text-rose-500 hover:text-rose-700 px-1"
              aria-label="Dismiss error"
            >
              ×
            </button>
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {/* Title — the nudge itself. */}
          <Field label="Title">
            <input
              type="text"
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="What to check or do?"
              aria-label="Title"
              className="w-full bg-white border border-ink-200 rounded-md px-2 py-1.5 text-[13px] text-ink-900 outline-none focus:border-sky-300 focus:ring-2 focus:ring-sky-100 placeholder:text-ink-400"
            />
          </Field>

          {/* Linked node — the headline gesture. Prefer linking to the node it concerns. */}
          <Field label="Linked node">
            <NodePicker
              cases={cases}
              linkedCase={linkedCase}
              linkedLane={linkedLane}
              onLink={(id) => setCaseId(id)}
              onUnlink={() => setCaseId(undefined)}
            />
          </Field>

          {/* Due date + status */}
          <div className="flex gap-3">
            <div className="flex-1">
              <Field label="Due date">
                <input
                  type="date"
                  value={dueAt}
                  onChange={(e) => setDueAt(e.target.value)}
                  aria-label="Due date"
                  className="w-full bg-white border border-ink-200 rounded-md px-2 py-1.5 text-[12.5px] text-ink-900 outline-none focus:border-sky-300 focus:ring-2 focus:ring-sky-100"
                />
              </Field>
            </div>
            <div className="flex-1">
              <Field label="Status">
                <select
                  value={status}
                  onChange={(e) => setStatus(e.target.value as ReminderStatus)}
                  aria-label="Status"
                  className="w-full bg-white border border-ink-200 rounded-md px-2 py-1.5 text-[12.5px] text-ink-900 outline-none focus:border-sky-300 focus:ring-2 focus:ring-sky-100"
                >
                  <option value="open">Open</option>
                  <option value="done">Done</option>
                  <option value="dismissed">Dismissed</option>
                </select>
              </Field>
            </div>
          </div>

          {/* Domain — optional/advisory work/life tag. */}
          <Field label="Domain">
            <select
              value={domain}
              onChange={(e) => setDomain(e.target.value as "" | "work" | "life")}
              aria-label="Domain"
              className="w-full bg-white border border-ink-200 rounded-md px-2 py-1.5 text-[12.5px] text-ink-900 outline-none focus:border-sky-300 focus:ring-2 focus:ring-sky-100"
            >
              <option value="">No domain</option>
              <option value="work">Work</option>
              <option value="life">Life</option>
            </select>
          </Field>

          {/* Detail — optional elaboration / context. */}
          <Field label="Detail">
            <textarea
              value={detail}
              onChange={(e) => setDetail(e.target.value)}
              rows={3}
              placeholder="Optional context…"
              aria-label="Detail"
              className="w-full bg-white border border-ink-200 rounded-md px-2 py-1.5 text-[12.5px] text-ink-900 outline-none focus:border-sky-300 focus:ring-2 focus:ring-sky-100 placeholder:text-ink-400 resize-y"
            />
          </Field>

          {/* Labels — catalog-backed ids (validated server-side), like a case's labels. */}
          <Field label="Labels">
            <LabelPicker catalog={catalog} selected={labels} onChange={setLabels} />
          </Field>

          {/* Tasks — a SHORT checklist; ids are minted by the store on save. */}
          <Field label="Tasks">
            <TasksEditor tasks={tasks} onChange={setTasks} />
          </Field>

          {/* Linked emails — read-only (edit only): many emails about ONE matter can
              point at this reminder via message.reminderId. Unlinking clears that id. */}
          {isEdit && (
            <Field label="Linked emails">
              <LinkedEmails messages={linkedMessages} onUnlink={loadLinked} />
            </Field>
          )}
        </div>

        {/* Footer — Save (create/patch) + Delete on an existing reminder. */}
        <div className="px-5 h-14 flex items-center gap-2 border-t border-ink-100 bg-ink-50/40">
          {isEdit && (
            <button
              onClick={onDelete}
              disabled={saving}
              className="text-[12px] text-rose-600 hover:text-rose-700 px-2.5 py-1 rounded-md hover:bg-rose-50 border border-rose-200 disabled:opacity-50"
            >
              Delete
            </button>
          )}
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={onClose}
              disabled={saving}
              className="text-[12px] text-ink-600 hover:text-ink-900 px-2.5 py-1 rounded-md border border-ink-200 hover:bg-white disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={onSave}
              disabled={saving}
              className="text-[12px] px-3 py-1 rounded-md bg-ink-900 text-white hover:bg-ink-700 transition disabled:opacity-50"
            >
              {saving ? "Saving…" : isEdit ? "Save changes" : "Create reminder"}
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}

// A labelled form row (mirrors the EventDrawer's Field).
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-ink-400 mb-1">{label}</div>
      {children}
    </div>
  );
}

// The node typeahead — REUSES the EventDrawer CasePicker approach, but links to ANY
// board node (Initiative, Workstream, OR Case): all three tiers are CaseRecords in
// one id space, so a single caseId reference covers them all. When a node is linked
// it shows id + a tier badge (for containers) + a lane dot + the title + an Unlink
// button; otherwise a "Link to a node" button opens a search box filtered to live
// (not-done, not-archived) nodes matching id/title, capped to ~8.
function NodePicker({
  cases,
  linkedCase,
  linkedLane,
  onLink,
  onUnlink,
}: {
  cases: CaseRecord[];
  linkedCase: CaseRecord | null;
  linkedLane: (typeof LANES)[number] | null;
  onLink: (id: string) => void;
  onUnlink: () => void;
}) {
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState("");

  // Exclude done/archived nodes — you link a reminder to live work.
  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase();
    return cases
      .filter((c) => c.status !== "done" && !c.archivedAt)
      .filter((c) =>
        q === ""
          ? true
          : c.id.toLowerCase().includes(q) ||
            c.title.toLowerCase().includes(q),
      )
      .slice(0, 8);
  }, [cases, query]);

  // Linked state: show the node + tier badge (containers only) + lane dot + Unlink.
  if (linkedCase) {
    const kind = caseKind(linkedCase);
    return (
      <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-md border border-ink-100 bg-ink-50/40">
        <span className="tabular-nums text-ink-500 font-medium text-[12px] shrink-0">
          {linkedCase.id}
        </span>
        {kind !== "case" && (
          <span
            className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded-full font-medium ${tierAccent(kind)}`}
          >
            {kindLabel(kind)}
          </span>
        )}
        <span className="text-ink-900 text-[12.5px] truncate flex-1">{linkedCase.title}</span>
        {linkedLane && (
          <span
            className={`shrink-0 inline-flex items-center gap-1 text-[10.5px] ${linkedLane.tone}`}
          >
            <IconDot className={`w-2 h-2 ${linkedLane.dotClass.replace("bg-", "text-")}`} />
            {linkedLane.label}
          </span>
        )}
        <button
          onClick={onUnlink}
          className="shrink-0 text-[11px] text-ink-400 hover:text-rose-600 transition px-1"
        >
          Unlink
        </button>
      </div>
    );
  }

  // Unlinked + not picking: the "Link to a node" affordance.
  if (!picking) {
    return (
      <button
        onClick={() => setPicking(true)}
        className="inline-flex items-center gap-1.5 text-[12px] px-2.5 py-1 rounded-md border border-ink-200 text-ink-700 hover:bg-ink-50 transition"
      >
        Link to a node
      </button>
    );
  }

  // Picking: the search box + results, exactly like the EventDrawer CasePicker.
  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <div className="flex-1 flex items-center gap-2 px-2 py-1 rounded-md border border-ink-200 bg-white">
          <IconSearch className="w-3.5 h-3.5 text-ink-400" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                setPicking(false);
              }
            }}
            placeholder="Search initiatives, workstreams, cases…"
            aria-label="Search nodes to link"
            className="flex-1 min-w-0 text-[12px] outline-none bg-transparent text-ink-900 placeholder:text-ink-400"
          />
        </div>
        <button
          onClick={() => setPicking(false)}
          className="text-[11px] text-ink-400 hover:text-ink-700"
        >
          Cancel
        </button>
      </div>
      <div
        className="max-h-48 overflow-y-auto rounded-md border border-ink-100 divide-y divide-ink-50"
        role="listbox"
        aria-label="Nodes"
      >
        {candidates.length === 0 ? (
          <div className="px-3 py-3 text-[12px] text-ink-400 text-center">No matching open nodes</div>
        ) : (
          candidates.map((c) => {
            const lane = LANES.find((l) => l.key === c.status);
            const kind = caseKind(c);
            return (
              <button
                key={c.id}
                role="option"
                onClick={() => {
                  onLink(c.id);
                  setPicking(false);
                  setQuery("");
                }}
                className="w-full text-left flex items-center gap-2 px-3 py-2 text-[12.5px] hover:bg-ink-50 transition"
              >
                <span className="tabular-nums text-ink-500 font-medium shrink-0">{c.id}</span>
                {kind !== "case" && (
                  <span
                    className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded-full font-medium ${tierAccent(kind)}`}
                  >
                    {kindLabel(kind)}
                  </span>
                )}
                <span className="text-ink-900 truncate">{c.title}</span>
                <span
                  className={`ml-auto shrink-0 text-[10px] px-1.5 py-0.5 rounded-full font-medium ${domainClasses(
                    c.domain,
                  )}`}
                >
                  {domainLabel(c.domain)}
                </span>
                {lane && (
                  <span
                    className={`shrink-0 inline-flex items-center gap-1 text-[10.5px] ${lane.tone}`}
                  >
                    <IconDot className={`w-2 h-2 ${lane.dotClass.replace("bg-", "text-")}`} />
                    {lane.label}
                  </span>
                )}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

// Catalog-backed label picker — the same model the case-detail-drawer's LabelPicker
// uses (assigned chips via labelChipClasses + a "+" that opens a checklist popover
// of the catalog), BUT controlled: it calls onChange with the next id array instead
// of persisting immediately (the drawer persists on Save). Ids assigned but absent
// from the catalog (a deleted label) still render as a muted, removable chip.
function LabelPicker({
  catalog,
  selected,
  onChange,
}: {
  catalog: LabelDef[];
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const byId = useMemo(() => new Map(catalog.map((l) => [l.id, l])), [catalog]);
  const sel = new Set(selected);

  const toggle = (id: string) => {
    const next = new Set(sel);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(Array.from(next));
  };

  return (
    <div className="relative">
      <div className="flex flex-wrap items-center gap-1">
        {selected.length === 0 && <span className="text-ink-400 text-[12.5px]">No labels.</span>}
        {selected.map((id) => {
          const def = byId.get(id);
          return (
            <span
              key={id}
              title={def?.description ?? `Unknown label: ${id}`}
              className={`inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded-full font-medium ${labelChipClasses(def?.color)} ${
                def ? "" : "opacity-60 italic"
              }`}
            >
              {def?.title ?? id}
              <button
                type="button"
                onClick={() => toggle(id)}
                aria-label={`Remove ${def?.title ?? id}`}
                className="leading-none hover:opacity-70"
              >
                ×
              </button>
            </span>
          );
        })}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={open}
          className="inline-flex items-center gap-1 text-[11.5px] px-1.5 py-0.5 rounded-full border border-dashed border-ink-300 text-ink-500 hover:bg-ink-50 hover:text-ink-900 transition"
        >
          <IconPlus className="w-3 h-3" />
          Label
        </button>
      </div>

      {open && (
        <div
          role="menu"
          className="absolute z-20 mt-1 w-[300px] max-h-72 overflow-y-auto bg-white rounded-md border border-ink-200 shadow-card py-1"
        >
          {catalog.length === 0 ? (
            <div className="px-3 py-3 text-[12px] text-ink-400">
              No labels in the catalog yet. Open the <span className="font-medium">Labels</span> manager
              on the board toolbar to install a bundle or add one.
            </div>
          ) : (
            catalog.map((l) => {
              const on = sel.has(l.id);
              return (
                <button
                  key={l.id}
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={on}
                  onClick={() => toggle(l.id)}
                  className="w-full text-left px-3 py-1.5 hover:bg-ink-50 flex items-start gap-2"
                >
                  <span
                    className={`mt-0.5 w-3.5 h-3.5 rounded grid place-items-center shrink-0 border ${
                      on ? "bg-ink-900 border-ink-900 text-white" : "border-ink-300"
                    }`}
                  >
                    {on ? "✓" : ""}
                  </span>
                  <span className="min-w-0">
                    <span
                      className={`inline-block text-[11px] px-1.5 py-0.5 rounded-full font-medium ${labelChipClasses(l.color)}`}
                    >
                      {l.title}
                    </span>
                    {l.description && (
                      <span className="block text-[11.5px] text-ink-500 mt-0.5 leading-snug">{l.description}</span>
                    )}
                  </span>
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

// The SHORT tasks checklist editor — rows of [done toggle · title input · remove],
// plus an add-row. Controlled: every edit calls onChange with the next draft list.
// Empty-title rows are dropped at save time (buildPayload) and re-coerced by the
// store, so a half-typed row never persists. Mirrors the case TasksSection's add
// affordance but kept deliberately concise (a reminder's checklist is light).
function TasksEditor({
  tasks,
  onChange,
}: {
  tasks: TaskDraft[];
  onChange: (next: TaskDraft[]) => void;
}) {
  const setAt = (i: number, patch: Partial<TaskDraft>) =>
    onChange(tasks.map((t, j) => (j === i ? { ...t, ...patch } : t)));
  const removeAt = (i: number) => onChange(tasks.filter((_, j) => j !== i));
  const add = () => onChange([...tasks, { id: "", title: "", done: false }]);

  return (
    <div className="space-y-1">
      {tasks.map((t, i) => (
        <div key={t.id || `new-${i}`} className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setAt(i, { done: !t.done })}
            aria-label={t.done ? "Mark task not done" : "Mark task done"}
            className="shrink-0"
          >
            {t.done ? (
              <IconCheckCircle className="w-4 h-4 text-lane-done" />
            ) : (
              <IconCircle className="w-4 h-4 text-ink-300" />
            )}
          </button>
          <input
            type="text"
            value={t.title}
            onChange={(e) => setAt(i, { title: e.target.value })}
            placeholder="Task…"
            aria-label="Task title"
            className={`flex-1 min-w-0 bg-white border border-ink-200 rounded-md px-2 py-1 text-[12.5px] outline-none focus:border-sky-300 focus:ring-2 focus:ring-sky-100 placeholder:text-ink-400 ${
              t.done ? "text-ink-400 line-through" : "text-ink-900"
            }`}
          />
          <button
            type="button"
            onClick={() => removeAt(i)}
            aria-label="Remove task"
            className="shrink-0 text-ink-300 hover:text-rose-600 text-[14px] leading-none px-1"
          >
            ×
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={add}
        className="inline-flex items-center gap-1 text-[11.5px] text-ink-500 hover:text-ink-900 px-1.5 py-0.5 rounded hover:bg-ink-50"
      >
        <IconPlus className="w-3 h-3" />
        Add task
      </button>
    </div>
  );
}

// Read-only list of emails linked to this reminder (message.reminderId). Each row
// shows the source icon, from, subject, and a relative-time stamp; an Unlink button
// clears message.reminderId (then refreshes via onUnlink). Shown only when editing.
function LinkedEmails({
  messages,
  onUnlink,
}: {
  messages: MessageRecord[];
  onUnlink: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);

  const unlink = async (id: string) => {
    if (busy) return;
    setBusy(id);
    try {
      await updateMessage(id, { reminderId: null });
      onUnlink();
    } catch {
      // Non-critical: leave the row; the next refresh reconciles.
    } finally {
      setBusy(null);
    }
  };

  if (messages.length === 0) {
    return <span className="text-ink-400 text-[12.5px]">No linked emails.</span>;
  }

  return (
    <div className="rounded-md border border-ink-100 divide-y divide-ink-50 overflow-hidden">
      {messages.map((m) => (
        <div key={m.id} className="flex items-center gap-2 px-2.5 py-1.5">
          <SourceIcon source={m.source} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-[12px] font-medium text-ink-900 truncate">{m.from}</span>
              <span className="ml-auto shrink-0 text-[10.5px] text-ink-400">
                {relativeTime(m.receivedAt)} ago
              </span>
              {/* Deep-link back to the original message (Gmail thread, etc.) when captured. */}
              <MessageLink url={messageDeepLink(m)} />
            </div>
            <div className="text-[11.5px] text-ink-500 truncate">{m.subject}</div>
          </div>
          <button
            type="button"
            onClick={() => unlink(m.id)}
            disabled={busy === m.id}
            className="shrink-0 text-[11px] text-ink-400 hover:text-rose-600 transition px-1 disabled:opacity-50"
          >
            Unlink
          </button>
        </div>
      ))}
    </div>
  );
}

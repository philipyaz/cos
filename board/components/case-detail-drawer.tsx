"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type {
  CaseRecord,
  CaseActivity,
  CaseKind,
  CaseNote,
  CaseDomain,
  CaseStatus,
  LabelDef,
  MessageRecord,
  Priority,
  Reminder,
  Subtask,
  Task,
  TaskStatus,
} from "@/lib/types";
import { LANES, VALID_PRIORITY, VALID_TASK_STATUS, TIERS, caseKind, kindLabel } from "@/lib/types";
import {
  initials,
  colorFor,
  relativeTime,
  progress,
  domainLabel,
  domainClasses,
  dueLabel,
  dueClasses,
  labelChipClasses,
  formatDate,
} from "@/lib/format";
import { dueStatus, slaStatus, lineageOfCases, childrenOfCases, rollupFor, sortReminders } from "@/lib/selectors";
import { messageContent } from "@/lib/inbox";
import {
  updateCase as apiUpdateCase,
  starCase as apiStarCase,
  archiveCase as apiArchiveCase,
  restoreCase as apiRestoreCase,
  setParent as apiSetParent,
  addTask as apiAddTask,
  updateTask as apiUpdateTask,
  completeTask as apiCompleteTask,
  deleteTask as apiDeleteTask,
  addNote as apiAddNote,
  fetchReminders as apiFetchReminders,
  createReminder as apiCreateReminder,
  completeReminder as apiCompleteReminder,
  updateReminder as apiUpdateReminder,
  deleteReminder as apiDeleteReminder,
} from "@/lib/board-client";
import {
  IconCheckCircle,
  IconCircle,
  IconWarning,
  IconDot,
  IconSpark,
  IconPlus,
  IconStar,
  IconChevronDown,
  IconChevronRight,
} from "@/components/icons";
import { SourceIcon } from "@/components/shared/source-icon";
import { MessageLink } from "@/components/shared/message-link";
import { messageDeepLink } from "@/lib/message-url";
import { Markdown, ReadMore } from "@/components/shared/markdown";

// ── Drawer ────────────────────────────────────────────────────────────────────
// The full card-detail editor. Props are PINNED: it owns its own mutations via
// board-client and calls onChanged() after each success so the shell refetches.
// Every field is click-to-edit (scoped updateCase on blur/enter); tasks/notes
// have their own composers; the activity log is the trust ledger; vault pills
// preview their page in-app.
export function CaseDetailDrawer({
  caseRec,
  messages,
  allCases = [],
  labelCatalog = [],
  onClose,
  onChanged,
}: {
  caseRec: CaseRecord | null;
  messages: MessageRecord[];
  allCases?: CaseRecord[];
  labelCatalog?: LabelDef[];
  onClose: () => void;
  onChanged?: () => void;
}) {
  // A drawer-level error banner for whole-case failures (field rows surface their
  // own inline errors; this covers actions + composers).
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!caseRec) return;
    setError(null);
    const onKey = (e: KeyboardEvent) => {
      // Esc closes the drawer — but only when no inline edit is mid-flight (those
      // stop propagation so Esc cancels the edit first).
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [caseRec, onClose]);

  if (!caseRec) return null;

  const lane = LANES.find((l) => l.key === caseRec.status)!;
  const p = progress(caseRec.tasks);
  const dStatus = dueStatus(caseRec.dueAt);
  const sla = slaStatus(caseRec);

  // Shared mutation runner: clears the banner, runs the call, refetches on
  // success, surfaces the API error text on failure. Returns whether it worked.
  const run = async (fn: () => Promise<unknown>): Promise<boolean> => {
    setError(null);
    try {
      await fn();
      onChanged?.();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
      return false;
    }
  };

  const patchCase = (patch: Record<string, unknown>) =>
    run(() => apiUpdateCase(caseRec.id, patch));

  // ── Actions ───────────────────────────────────────────────────────────────
  const onDelete = async () => {
    if (!window.confirm(`Delete ${caseRec.id}? It moves to Trash (restorable).`)) return;
    const ok = await run(() => apiArchiveCase(caseRec.id));
    if (ok) onClose();
  };

  const onRestore = async () => {
    const ok = await run(() => apiRestoreCase(caseRec.id));
    if (ok) onChanged?.();
  };

  return (
    <>
      <div className="fixed inset-0 bg-black/20 z-40" onClick={onClose} aria-hidden />
      <aside
        role="dialog"
        aria-label={`Case ${caseRec.id} detail`}
        className="fixed top-0 right-0 h-screen w-full sm:w-[560px] bg-white border-l border-ink-200 shadow-xl z-50 flex flex-col"
      >
        <div className="px-5 h-12 flex items-center border-b border-ink-100 gap-2">
          <span className="text-[12px] tabular-nums text-ink-500 font-medium">{caseRec.id}</span>
          <LaneInline
            status={caseRec.status}
            onSave={(status) => patchCase({ status })}
          />
          {/* Star toggle — the favorite/pin. Filled amber when starred, outline
              otherwise; flips via starCase through the same `run` (refetch +
              error-banner) path the rest of the drawer uses. */}
          <button
            type="button"
            onClick={() => run(() => apiStarCase(caseRec.id, !caseRec.starred))}
            aria-pressed={!!caseRec.starred}
            aria-label={caseRec.starred ? "Unstar this case" : "Star this case"}
            title={caseRec.starred ? "Starred — click to unstar" : "Star — pin to Priorities"}
            className={`grid place-items-center w-6 h-6 rounded transition ${
              caseRec.starred
                ? "text-amber-500 hover:bg-amber-50"
                : "text-ink-300 hover:text-amber-500 hover:bg-ink-50"
            }`}
          >
            <IconStar className="w-3.5 h-3.5" fill={caseRec.starred ? "currentColor" : "none"} />
          </button>
          {caseRec.archivedAt && (
            <span className="text-[11px] px-2 py-0.5 rounded-full bg-ink-100 text-ink-500">Deleted</span>
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

        <div className="flex-1 overflow-y-auto">
          {/* Title + summary + due/SLA chips */}
          <div className="px-5 py-4 border-b border-ink-100">
            <div className="flex items-start gap-2 flex-wrap mb-1.5">
              <span
                className={`inline-flex items-center text-[11px] px-1.5 py-0.5 rounded-full font-medium ${dueClasses(dStatus)}`}
                title="Due"
              >
                {dueLabel(caseRec.dueAt)}
              </span>
              {sla && (
                <span
                  className={`inline-flex items-center text-[11px] px-1.5 py-0.5 rounded-full font-medium ${
                    sla.breached
                      ? "bg-rose-50 text-rose-700 ring-1 ring-rose-200"
                      : "bg-amber-50 text-amber-700 ring-1 ring-amber-200"
                  }`}
                  title="Time idle in waiting-for-input"
                >
                  Waiting {sla.days}d{sla.breached ? " · SLA breached" : ""}
                </span>
              )}
              {caseRec.priority && (
                <span className="inline-flex items-center text-[11px] px-1.5 py-0.5 rounded-full font-medium bg-ink-100 text-ink-700">
                  {caseRec.priority}
                </span>
              )}
            </div>
            <EditableText
              label="Title"
              value={caseRec.title}
              onSave={(v) => patchCase({ title: v })}
              className="text-[18px] font-semibold text-ink-900 leading-snug"
              placeholder="Untitled case"
            />
            <EditableText
              label="Summary"
              value={caseRec.summary}
              onSave={(v) => patchCase({ summary: v })}
              className="mt-2 text-[13px] text-ink-700 leading-relaxed"
              placeholder="Add a summary…"
              multiline
              markdown
              readMore
            />
          </div>

          {/* Structured fields — the primary four stay visible; labels, tags and
              the lesser meta tuck into a collapsed "Details" disclosure below. */}
          <div className="px-5 py-4 border-b border-ink-100 space-y-3">
            <div className="grid grid-cols-2 gap-y-3 gap-x-4 text-[12.5px]">
              <FieldRow label="Domain">
                <SelectInline
                  value={caseRec.domain}
                  options={[
                    { value: "work", label: "Work" },
                    { value: "life", label: "Life" },
                  ]}
                  onSave={(v) => patchCase({ domain: v as CaseDomain })}
                  render={(v) => (
                    <span
                      className={`inline-flex items-center text-[11px] px-1.5 py-0.5 rounded-full font-medium ${domainClasses(v)}`}
                    >
                      {domainLabel(v)}
                    </span>
                  )}
                />
              </FieldRow>

              <FieldRow label="Priority">
                <SelectInline
                  value={caseRec.priority ?? ""}
                  options={[
                    { value: "", label: "None" },
                    ...VALID_PRIORITY.map((p) => ({ value: p, label: p })),
                  ]}
                  onSave={(v) => patchCase({ priority: v === "" ? null : (v as Priority) })}
                  render={(v) => <span className="text-ink-900">{v || "—"}</span>}
                />
              </FieldRow>

              <FieldRow label="Due date">
                <DateInline value={caseRec.dueAt} onSave={(v) => patchCase({ dueAt: v })} />
              </FieldRow>
            </div>

            <MetaDetails>
              <FieldRow label="ETA (free text)">
                <EditableText
                  label="ETA"
                  value={caseRec.eta ?? ""}
                  onSave={(v) => patchCase({ eta: v })}
                  className="text-ink-900"
                  placeholder="—"
                />
              </FieldRow>

              <FieldRow label="Updated">
                <span className="text-ink-900">{relativeTime(caseRec.updatedAt)} ago</span>
              </FieldRow>

              <div className="col-span-2">
                <FieldRow label="Labels">
                  <LabelPicker
                    catalog={labelCatalog}
                    selected={caseRec.labels ?? []}
                    onSave={(ids) => patchCase({ labels: ids })}
                  />
                </FieldRow>
              </div>

              <div className="col-span-2">
                <FieldRow label="Tags">
                  <CsvInline
                    values={caseRec.tags ?? []}
                    onSave={(arr) => patchCase({ tags: arr })}
                    placeholder="Add tags (comma separated)…"
                    render={(arr) =>
                      arr.length ? (
                        <span className="inline-flex flex-wrap gap-1">
                          {arr.map((t) => (
                            <span key={t} className="text-[11px] px-1.5 py-0.5 rounded bg-ink-50 text-ink-700">
                              {t}
                            </span>
                          ))}
                        </span>
                      ) : (
                        <span className="text-ink-400">—</span>
                      )
                    }
                  />
                </FieldRow>
              </div>
            </MetaDetails>
          </div>

          {/* Hierarchy — tier (kind), parent lineage + picker, and (for a
              container) its children with a rollup bar. Reads the tree from the
              allCases prop; writes via board-client. */}
          <HierarchySection caseRec={caseRec} allCases={allCases} patchCase={patchCase} run={run} />

          {/* Vault context — violet pills + in-app preview */}
          <VaultSection
            links={caseRec.vaultLinks ?? []}
            onSave={(arr) => patchCase({ vaultLinks: arr })}
          />

          {/* Tasks */}
          <TasksSection
            caseId={caseRec.id}
            tasks={caseRec.tasks}
            done={p.done}
            total={p.total}
            run={run}
          />

          {/* Notes */}
          <NotesSection caseId={caseRec.id} notes={caseRec.notes ?? []} run={run} />

          {/* Reminders — the lightweight nudges linked to THIS node (the bidirectional
              twin of the reminders surface). Owns its own fetch/state like VaultSection;
              onChanged bubbles each mutation so the drawer's activity log refetches. */}
          <RemindersSection
            caseId={caseRec.id}
            domain={caseRec.domain}
            labelCatalog={labelCatalog}
            onChanged={onChanged}
          />

          {/* Messages — the already-rolled-up, newest-first list from board-view.
              On a container this INHERITS the mail of every descendant case, so an
              inherited message (caseId ≠ this node) gets an owning-case chip and the
              header notes how many came from children. A leaf shows only its own. */}
          {(() => {
            // Same predicate the per-row chip uses (isInherited), so the header
            // count and the chips can never disagree about what's "inherited".
            const inheritedCount = messages.filter((m) => isInherited(m, caseRec.id)).length;
            return (
              <Section
                title={`Messages · ${messages.length}${
                  inheritedCount > 0 ? ` · ${inheritedCount} from child cases` : ""
                }`}
              >
                <div className="space-y-3">
                  {messages.length === 0 && (
                    <div className="text-[12px] text-ink-400">No linked messages.</div>
                  )}
                  {messages.map((m) => (
                    <MessageRow key={m.id} message={m} ownerId={caseRec.id} allCases={allCases} />
                  ))}
                </div>
              </Section>
            );
          })()}

          {/* Activity log — the trust ledger */}
          <ActivitySection activity={caseRec.activity ?? []} />
        </div>

        {/* Actions row */}
        <div className="px-5 h-12 flex items-center gap-2 border-t border-ink-100 bg-ink-50/40">
          <div className="ml-auto flex items-center gap-2">
            {caseRec.archivedAt ? (
              <button
                onClick={onRestore}
                className="text-[12px] text-ink-600 hover:text-ink-900 px-2 py-1 rounded hover:bg-white border border-ink-200"
              >
                Restore
              </button>
            ) : (
              <button
                onClick={onDelete}
                className="text-[12px] text-rose-600 hover:text-rose-700 px-2 py-1 rounded hover:bg-rose-50 border border-rose-200"
              >
                Delete
              </button>
            )}
          </div>
        </div>
      </aside>
    </>
  );
}

// ── Hierarchy (Initiative > Workstream > Case) ─────────────────────────────────
// This node's TIER (with a converter), its place in the tree (lineage + a parent
// picker constrained to legal containers), and — for a container — its children
// with a rollup bar. The board's assertHierarchy is the backstop: an illegal move
// returns a 400 that `run`/`patchCase` surface in the drawer's error banner. All
// hierarchy facts are derived from the allCases prop; writes go through board-client.
function HierarchySection({
  caseRec,
  allCases,
  patchCase,
  run,
}: {
  caseRec: CaseRecord;
  allCases: CaseRecord[];
  patchCase: (patch: Record<string, unknown>) => Promise<boolean>;
  run: (fn: () => Promise<unknown>) => Promise<boolean>;
}) {
  const kind = caseKind(caseRec);
  const lineage = lineageOfCases(allCases, caseRec.id);
  const ancestors = lineage.slice(0, -1); // everything above self (root → parent)
  const children = childrenOfCases(allCases, caseRec.id);
  const rollup = rollupFor(allCases, caseRec.id);

  const initiatives = allCases.filter(
    (c) => caseKind(c) === "initiative" && !c.archivedAt && c.id !== caseRec.id,
  );
  const workstreams = allCases.filter(
    (c) => caseKind(c) === "workstream" && !c.archivedAt && c.id !== caseRec.id,
  );

  // Valid parent options for THIS node's tier (mirrors the server invariants):
  //  - initiative: none (always top-level);
  //  - workstream: any initiative (no detach — it must have one);
  //  - case: top-level, any initiative, or any workstream.
  const parentOptions: { value: string; label: string }[] = (() => {
    if (kind === "initiative") return [];
    const opts: { value: string; label: string }[] = [];
    if (kind === "case") opts.push({ value: "", label: "Top-level (no parent)" });
    for (const i of initiatives) opts.push({ value: i.id, label: `Initiative · ${i.title}` });
    if (kind === "case") for (const w of workstreams) opts.push({ value: w.id, label: `Workstream · ${w.title}` });
    return opts;
  })();

  const setParentTo = (parentId: string) =>
    run(() => apiSetParent(caseRec.id, parentId === "" ? null : parentId));

  const changeKind = (next: CaseKind) => {
    if (next === kind) return;
    // Promoting to an Initiative also clears the parent (an initiative is a root).
    if (next === "initiative") patchCase({ kind: "initiative", parentId: null });
    else patchCase({ kind: next });
  };

  const tierAccent =
    kind === "initiative"
      ? "text-violet-600 bg-violet-50"
      : kind === "workstream"
        ? "text-sky-600 bg-sky-50"
        : "text-ink-600 bg-ink-100";

  return (
    <div className="px-5 py-4 border-b border-ink-100 space-y-3">
      <div className="flex items-center gap-2">
        <div className="text-[11px] uppercase tracking-wide text-ink-400">Hierarchy</div>
        <span className={`text-[10.5px] px-1.5 py-0.5 rounded-full font-medium ${tierAccent}`}>
          {kindLabel(kind)}
        </span>
        <select
          value={kind}
          aria-label="Tier"
          title="Change tier — illegal changes are rejected by the board"
          onChange={(e) => changeKind(e.target.value as CaseKind)}
          className="ml-auto bg-white border border-ink-200 rounded px-1.5 py-1 text-[11.5px] text-ink-700 outline-none focus:border-sky-300"
        >
          {TIERS.map((t) => (
            <option key={t.kind} value={t.kind}>
              {t.label}
            </option>
          ))}
        </select>
      </div>

      {ancestors.length > 0 && (
        <div className="flex items-center gap-1 flex-wrap text-[11.5px]">
          <span className="text-ink-400">Part of:</span>
          {ancestors.map((a, i) => (
            <span key={a.id} className="inline-flex items-center gap-1">
              {i > 0 && <span className="text-ink-300">›</span>}
              <span className={caseKind(a) === "initiative" ? "text-violet-600 font-medium" : "text-sky-600 font-medium"}>
                {a.title}
              </span>
            </span>
          ))}
        </div>
      )}

      {kind !== "initiative" && (
        <FieldRow label={kind === "workstream" ? "Initiative" : "Parent"}>
          <select
            value={caseRec.parentId ?? ""}
            aria-label="Parent"
            onChange={(e) => setParentTo(e.target.value)}
            className="bg-white border border-ink-200 rounded px-1.5 py-1 text-[12.5px] text-ink-900 outline-none focus:border-sky-300 focus:ring-2 focus:ring-sky-100 max-w-full"
          >
            {/* Keep an out-of-list current parent (e.g. archived) visible. */}
            {caseRec.parentId && !parentOptions.some((o) => o.value === caseRec.parentId) && (
              <option value={caseRec.parentId}>{caseRec.parentId}</option>
            )}
            {parentOptions.length === 0 && <option value="">No initiatives yet — create one first</option>}
            {parentOptions.map((o) => (
              <option key={o.value || "none"} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </FieldRow>
      )}

      {kind !== "case" && (
        <div>
          <div className="flex items-center gap-2 mb-1.5">
            <div className="text-[11px] uppercase tracking-wide text-ink-400">
              {kind === "initiative" ? "Workstreams & cases" : "Cases"} · {children.length}
            </div>
            <div className="ml-auto flex items-center gap-2">
              <div className="h-1.5 w-20 rounded-full overflow-hidden bg-ink-100" title="Done / total cases">
                <div className="h-full bg-emerald-500" style={{ width: `${Math.round(rollup.ratio * 100)}%` }} />
              </div>
              <span className="text-[11px] tabular-nums text-ink-500">
                {rollup.doneCases}/{rollup.totalCases}
              </span>
            </div>
          </div>
          {children.length === 0 ? (
            <div className="text-[12px] text-ink-400">
              No children yet — group cases here from the board or the strategy view.
            </div>
          ) : (
            <div className="rounded-md border border-ink-100 divide-y divide-ink-50">
              {children.map((ch) => {
                const lane = LANES.find((l) => l.key === ch.status);
                const ck = caseKind(ch);
                return (
                  <div key={ch.id} className="flex items-center gap-2 px-2.5 py-1.5">
                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${lane?.dotClass ?? "bg-ink-300"}`} aria-hidden />
                    <span className="text-[11px] tabular-nums text-ink-400 shrink-0">{ch.id}</span>
                    {ck !== "case" && (
                      <span
                        className={`text-[10px] px-1 py-0.5 rounded shrink-0 ${
                          ck === "workstream" ? "text-sky-600 bg-sky-50" : "text-violet-600 bg-violet-50"
                        }`}
                      >
                        {kindLabel(ck)}
                      </span>
                    )}
                    <span className="text-[12.5px] text-ink-800 truncate">{ch.title}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Layout primitives ─────────────────────────────────────────────────────────
function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-ink-400 mb-0.5">{label}</div>
      <div>{children}</div>
    </div>
  );
}

// Collapsible "Details" disclosure for the secondary case fields — labels, tags, and
// the lesser meta (ETA, updated). Collapsed by default so the drawer leads with the
// essentials; renders its children in the same 2-col grid the primary fields use.
function MetaDetails({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-ink-400 hover:text-ink-600"
      >
        {open ? <IconChevronDown className="w-3.5 h-3.5" /> : <IconChevronRight className="w-3.5 h-3.5" />}
        Labels, tags &amp; details
      </button>
      {open && <div className="mt-3 grid grid-cols-2 gap-y-3 gap-x-4 text-[12.5px]">{children}</div>}
    </div>
  );
}

function Section({
  title,
  right,
  children,
}: {
  title: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="px-5 py-4 border-b border-ink-100">
      <div className="flex items-center mb-2.5">
        <div className="text-[11px] uppercase tracking-wide text-ink-400">{title}</div>
        {right && <div className="ml-auto">{right}</div>}
      </div>
      {children}
    </div>
  );
}

// ── Inline editors ─────────────────────────────────────────────────────────────
// Click-to-edit text (single line or textarea). Commits on Enter/blur; Esc
// cancels the edit (and stops the drawer Esc handler from also firing).
function EditableText({
  label,
  value,
  onSave,
  className,
  placeholder,
  multiline,
  render,
  markdown,
  readMore,
}: {
  label: string;
  value: string;
  onSave: (v: string) => void;
  className?: string;
  placeholder?: string;
  multiline?: boolean;
  render?: (v: string) => React.ReactNode;
  markdown?: boolean; // render the resting value as formatted markdown (editing stays raw)
  readMore?: boolean; // clamp the rendered markdown with a "Read more" toggle
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);

  // Seed the draft + caret only when entering edit mode. Keyed on `editing` alone
  // (NOT `value`) so a live SSE/agent refetch of the same field mid-edit can't
  // re-run this and clobber the user's in-progress text.
  useEffect(() => {
    if (!editing) return;
    setDraft(value);
    const el = inputRef.current;
    if (el) {
      el.focus();
      const len = el.value.length;
      el.setSelectionRange(len, len);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  const commit = () => {
    setEditing(false);
    if (draft !== value) onSave(draft);
  };
  const cancel = () => {
    setEditing(false);
    setDraft(value);
  };

  if (editing) {
    const common = {
      ref: inputRef as never,
      value: draft,
      "aria-label": label,
      onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft(e.target.value),
      onBlur: commit,
      onKeyDown: (e: React.KeyboardEvent) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          cancel();
        } else if (e.key === "Enter" && !(multiline && e.shiftKey)) {
          e.preventDefault();
          commit();
        }
      },
      className:
        "w-full bg-white border border-sky-300 rounded px-1.5 py-1 text-[13px] text-ink-900 outline-none focus:ring-2 focus:ring-sky-100",
    };
    return multiline ? (
      <textarea {...common} rows={3} placeholder={placeholder} />
    ) : (
      <input {...common} type="text" placeholder={placeholder} />
    );
  }

  // Markdown fields render their value as formatted prose at rest (optionally clamped
  // with "Read more") and expose an explicit hover "Edit" button — so inline links stay
  // clickable instead of every click entering edit mode. Empty falls back to the plain
  // click-to-edit placeholder below.
  if (markdown && value.trim()) {
    const body = <Markdown>{value}</Markdown>;
    return (
      <div className={`group/edit relative ${className ?? ""}`}>
        {readMore ? <ReadMore>{body}</ReadMore> : body}
        <button
          type="button"
          onClick={() => setEditing(true)}
          aria-label={`Edit ${label}`}
          title={`Edit ${label}`}
          className="absolute -top-1 right-0 opacity-0 group-hover/edit:opacity-100 focus:opacity-100 transition text-[10.5px] text-ink-500 hover:text-ink-900 bg-white/90 ring-1 ring-ink-200 rounded px-1.5 py-0.5"
        >
          Edit
        </button>
      </div>
    );
  }

  const display = render ? (
    render(value)
  ) : value ? (
    value
  ) : (
    <span className="text-ink-400">{placeholder ?? "—"}</span>
  );

  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      title="Click to edit"
      className={`block w-full text-left rounded px-1 -mx-1 hover:bg-ink-50 transition cursor-text ${className ?? ""}`}
    >
      {display}
    </button>
  );
}

// Click-to-edit native <select>. Saves on change; render() shows the resting chip.
function SelectInline({
  value,
  options,
  onSave,
  render,
}: {
  value: string;
  options: { value: string; label: string }[];
  onSave: (v: string) => void;
  render: (v: string) => React.ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const ref = useRef<HTMLSelectElement | null>(null);

  useEffect(() => {
    if (editing) ref.current?.focus();
  }, [editing]);

  if (editing) {
    return (
      <select
        ref={ref}
        value={value}
        aria-label="Select value"
        onChange={(e) => {
          setEditing(false);
          if (e.target.value !== value) onSave(e.target.value);
        }}
        onBlur={() => setEditing(false)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            setEditing(false);
          }
        }}
        className="bg-white border border-sky-300 rounded px-1.5 py-1 text-[12.5px] text-ink-900 outline-none focus:ring-2 focus:ring-sky-100"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      title="Click to edit"
      className="block text-left rounded px-1 -mx-1 hover:bg-ink-50 transition"
    >
      {render(value)}
    </button>
  );
}

// Click-to-edit date. Stores ISO (the date input's yyyy-mm-dd is sent as-is —
// the store treats it as an ISO date). Clearing the field saves null.
function DateInline({ value, onSave }: { value?: string; onSave: (v: string | null) => void }) {
  const [editing, setEditing] = useState(false);
  const ref = useRef<HTMLInputElement | null>(null);
  const asDate = value ? new Date(value) : null;
  const inputVal = asDate && !Number.isNaN(asDate.getTime()) ? toDateInput(asDate) : "";

  useEffect(() => {
    if (editing) ref.current?.focus();
  }, [editing]);

  if (editing) {
    return (
      <input
        ref={ref}
        type="date"
        defaultValue={inputVal}
        aria-label="Due date"
        onBlur={(e) => {
          setEditing(false);
          const v = e.target.value;
          if (v !== inputVal) onSave(v ? v : null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            setEditing(false);
          } else if (e.key === "Enter") {
            (e.target as HTMLInputElement).blur();
          }
        }}
        className="bg-white border border-sky-300 rounded px-1.5 py-1 text-[12.5px] text-ink-900 outline-none focus:ring-2 focus:ring-sky-100"
      />
    );
  }

  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      title="Click to edit"
      className="block text-left rounded px-1 -mx-1 hover:bg-ink-50 transition text-ink-900"
    >
      {value ? formatDate(value) : <span className="text-ink-400">—</span>}
    </button>
  );
}

// Click-to-edit comma-separated list (tags, vaultLinks). Splits/trims/dedupes.
function CsvInline({
  values,
  onSave,
  placeholder,
  render,
}: {
  values: string[];
  onSave: (arr: string[]) => void;
  placeholder?: string;
  render: (arr: string[]) => React.ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const ref = useRef<HTMLInputElement | null>(null);
  const joined = values.join(", ");

  useEffect(() => {
    if (editing) {
      setDraft(joined);
      ref.current?.focus();
    }
  }, [editing, joined]);

  const commit = () => {
    setEditing(false);
    const arr = Array.from(
      new Set(
        draft
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      ),
    );
    if (arr.join("\u0000") !== values.join("\u0000")) onSave(arr);
  };

  if (editing) {
    return (
      <input
        ref={ref}
        type="text"
        value={draft}
        aria-label="Comma separated list"
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            setEditing(false);
          } else if (e.key === "Enter") {
            e.preventDefault();
            commit();
          }
        }}
        className="w-full bg-white border border-sky-300 rounded px-1.5 py-1 text-[12.5px] text-ink-900 outline-none focus:ring-2 focus:ring-sky-100"
      />
    );
  }

  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      title="Click to edit"
      className="block w-full text-left rounded px-1 -mx-1 hover:bg-ink-50 transition"
    >
      {render(values)}
    </button>
  );
}

// Catalog-backed label picker. Resting state shows the assigned label chips; the
// "+" opens a checklist popover of the catalog (title + description so you pick the
// right one). Each toggle persists immediately via onSave. Ids assigned but not in
// the catalog (e.g. a label deleted without scrub) render as a muted chip you can
// still remove. Falls back to a hint when the catalog is empty.
function LabelPicker({
  catalog,
  selected,
  onSave,
}: {
  catalog: LabelDef[];
  selected: string[];
  onSave: (ids: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const byId = new Map(catalog.map((l) => [l.id, l]));
  const sel = new Set(selected);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDoc);
    return () => window.removeEventListener("mousedown", onDoc);
  }, [open]);

  const toggle = (id: string) => {
    const next = new Set(sel);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onSave(Array.from(next));
  };

  return (
    <div ref={ref} className="relative">
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

// Lane selector in the header — a compact chip that becomes a <select> on click.
function LaneInline({ status, onSave }: { status: CaseStatus; onSave: (v: CaseStatus) => void }) {
  const [editing, setEditing] = useState(false);
  const ref = useRef<HTMLSelectElement | null>(null);
  const lane = LANES.find((l) => l.key === status)!;

  useEffect(() => {
    if (editing) ref.current?.focus();
  }, [editing]);

  if (editing) {
    return (
      <select
        ref={ref}
        value={status}
        aria-label="Lane / status"
        onChange={(e) => {
          setEditing(false);
          if (e.target.value !== status) onSave(e.target.value as CaseStatus);
        }}
        onBlur={() => setEditing(false)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            setEditing(false);
          }
        }}
        className="bg-white border border-sky-300 rounded px-1.5 py-0.5 text-[11.5px] text-ink-900 outline-none focus:ring-2 focus:ring-sky-100"
      >
        {LANES.map((l) => (
          <option key={l.key} value={l.key}>
            {l.label}
          </option>
        ))}
      </select>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      title="Click to change lane"
      className={`inline-flex items-center gap-1.5 text-[11.5px] px-2 py-0.5 rounded-full bg-ink-50 hover:ring-1 hover:ring-ink-200 transition ${lane.tone}`}
    >
      <IconDot className={`w-2.5 h-2.5 ${lane.dotClass.replace("bg-", "text-")}`} />
      {lane.label}
    </button>
  );
}

// ── Vault context ──────────────────────────────────────────────────────────────
function VaultSection({ links, onSave }: { links: string[]; onSave: (arr: string[]) => void }) {
  const [preview, setPreview] = useState<{
    title: string;
    state: "loading" | "ok" | "missing" | "error";
    markdown?: string;
    path?: string;
    error?: string;
  } | null>(null);

  // The Obsidian deep-link target, resolved from config (NOT hardcoded). We PREFER the
  // unique 16-char vault ID: addressing by ID is unambiguous even when two registered
  // Obsidian vaults share a folder name (e.g. a repo copy + an older external copy) —
  // the name form would open whichever Obsidian picks, which may be the wrong vault.
  // Falls back to the display name when no ID is configured. Fetched once on mount from
  // /api/vault (no title ⇒ identity-only response).
  const [vaultLink, setVaultLink] = useState<{ id: string | null; name: string | null }>({
    id: null,
    name: null,
  });
  useEffect(() => {
    let alive = true;
    fetch("/api/vault")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { obsidianVaultId?: string | null; obsidianVaultName?: string | null; vaultName?: string } | null) => {
        if (!alive || !d) return;
        setVaultLink({
          id: d.obsidianVaultId ?? null,
          name: d.obsidianVaultName ?? d.vaultName ?? null,
        });
      })
      .catch(() => {
        /* identity unavailable ⇒ the arrow stays disabled (see render) */
      });
    return () => {
      alive = false;
    };
  }, []);
  // Prefer the unique ID; else the display name. Null until identity resolves (brief).
  const vaultTarget = vaultLink.id || vaultLink.name;

  const openPreview = async (title: string) => {
    if (preview?.title === title) {
      setPreview(null); // toggle off
      return;
    }
    setPreview({ title, state: "loading" });
    try {
      const res = await fetch(`/api/vault?title=${encodeURIComponent(title)}`);
      if (res.status === 404) {
        setPreview({ title, state: "missing" });
        return;
      }
      if (!res.ok) {
        setPreview({ title, state: "error", error: `Failed (${res.status})` });
        return;
      }
      const data = (await res.json()) as { title: string; path: string; markdown: string };
      setPreview({
        title,
        state: "ok",
        markdown: data.markdown.split("\n").slice(0, 40).join("\n"),
        path: data.path,
      });
    } catch (e) {
      setPreview({ title, state: "error", error: e instanceof Error ? e.message : "Failed to load" });
    }
  };

  return (
    <Section title="Vault context">
      <CsvInline
        values={links}
        onSave={onSave}
        placeholder="Add wikilink titles (comma separated)…"
        render={(arr) =>
          arr.length ? (
            <div className="flex flex-wrap gap-1.5">
              {arr.map((title) => (
                <span key={title} className="inline-flex items-center">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      openPreview(title);
                    }}
                    title={`Preview “${title}”`}
                    className={`inline-flex items-center gap-1 text-[12px] pl-2 pr-1.5 py-0.5 rounded-l-full bg-violet-50 text-violet-700 ring-1 ring-violet-200 hover:bg-violet-100 transition ${
                      preview?.title === title ? "bg-violet-100" : ""
                    }`}
                  >
                    <IconSpark className="w-3 h-3" />
                    {title}
                  </button>
                  {vaultTarget ? (
                    <a
                      href={`obsidian://open?vault=${encodeURIComponent(vaultTarget)}&file=${encodeURIComponent(title)}`}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      title={`Open “${title}” in Obsidian`}
                      className="inline-flex items-center text-[11px] px-1.5 py-0.5 rounded-r-full bg-violet-50 text-violet-700 ring-1 ring-l-0 ring-violet-200 hover:bg-violet-100 transition"
                    >
                      ↗
                    </a>
                  ) : (
                    <span
                      title="Open in Obsidian — register this vault in Obsidian (see setup-vault) to enable deep-links"
                      onClick={(e) => e.stopPropagation()}
                      className="inline-flex items-center text-[11px] px-1.5 py-0.5 rounded-r-full bg-violet-50 text-violet-300 ring-1 ring-l-0 ring-violet-200 cursor-default"
                    >
                      ↗
                    </span>
                  )}
                </span>
              ))}
            </div>
          ) : (
            <span className="text-ink-400 text-[12.5px]">No vault links. Click to add.</span>
          )
        }
      />

      {preview && (
        <div className="mt-3 rounded-md border border-violet-200 bg-violet-50/40 overflow-hidden">
          <div className="px-3 py-1.5 flex items-center gap-2 border-b border-violet-100">
            <IconSpark className="w-3 h-3 text-violet-500" />
            <span className="text-[12px] font-medium text-violet-700 truncate">{preview.title}</span>
            <button
              onClick={() => setPreview(null)}
              className="ml-auto text-violet-500 hover:text-violet-700 px-1 text-[14px] leading-none"
              aria-label="Close preview"
            >
              ×
            </button>
          </div>
          <div className="px-3 py-2">
            {preview.state === "loading" && (
              <div className="text-[12px] text-ink-400">Loading…</div>
            )}
            {preview.state === "missing" && (
              <div className="text-[12px] text-ink-400">Not in vault yet.</div>
            )}
            {preview.state === "error" && (
              <div className="text-[12px] text-rose-600">{preview.error}</div>
            )}
            {preview.state === "ok" && (
              <div className="max-h-72 overflow-y-auto">
                <Markdown className="text-[12px] text-ink-600 leading-relaxed">{preview.markdown}</Markdown>
              </div>
            )}
            {preview.state === "ok" && preview.path && (
              <div className="mt-1 text-[10.5px] text-ink-400 truncate">{preview.path}</div>
            )}
          </div>
        </div>
      )}
    </Section>
  );
}

// ── Tasks ──────────────────────────────────────────────────────────────────────
function TasksSection({
  caseId,
  tasks,
  done,
  total,
  run,
}: {
  caseId: string;
  tasks: Task[];
  done: number;
  total: number;
  run: (fn: () => Promise<unknown>) => Promise<boolean>;
}) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const addRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (adding) addRef.current?.focus();
  }, [adding]);

  const commitAdd = async () => {
    const title = draft.trim();
    if (!title) {
      setAdding(false);
      return;
    }
    const ok = await run(() => apiAddTask(caseId, { title }));
    if (ok) {
      setDraft("");
      // keep adding for fast multi-entry
      addRef.current?.focus();
    }
  };

  return (
    <Section
      title={`Tasks · ${done} / ${total}`}
      right={
        <button
          onClick={() => setAdding(true)}
          className="inline-flex items-center gap-1 text-[11.5px] text-ink-500 hover:text-ink-900 px-1.5 py-0.5 rounded hover:bg-ink-50"
          aria-label="Add task"
        >
          <IconPlus className="w-3 h-3" />
          Add
        </button>
      }
    >
      <div className="space-y-1">
        {tasks.map((t) => (
          <TaskRow key={t.id} caseId={caseId} task={t} run={run} />
        ))}
        {tasks.length === 0 && !adding && (
          <div className="text-[12px] text-ink-400">No tasks yet.</div>
        )}
        {adding && (
          <div className="flex items-center gap-2 py-1">
            <IconCircle className="w-4 h-4 text-ink-300 shrink-0" />
            <input
              ref={addRef}
              type="text"
              value={draft}
              aria-label="New task title"
              placeholder="New task title…"
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commitAdd}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.stopPropagation();
                  setAdding(false);
                  setDraft("");
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  commitAdd();
                }
              }}
              className="flex-1 bg-white border border-sky-300 rounded px-1.5 py-1 text-[13px] text-ink-900 outline-none focus:ring-2 focus:ring-sky-100"
            />
          </div>
        )}
      </div>
    </Section>
  );
}

function taskIcon(status: TaskStatus) {
  if (status === "done") return <IconCheckCircle className="w-4 h-4 text-lane-done" />;
  if (status === "blocked") return <IconWarning className="w-4 h-4 text-lane-urgent" />;
  if (status === "in_progress") return <IconCircle className="w-4 h-4 text-lane-todo" />;
  return <IconCircle className="w-4 h-4 text-ink-300" />;
}

function TaskRow({
  caseId,
  task,
  run,
}: {
  caseId: string;
  task: Task;
  run: (fn: () => Promise<unknown>) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [newSub, setNewSub] = useState("");

  const patchTask = (patch: Record<string, unknown>) =>
    run(() => apiUpdateTask(caseId, task.id, patch));

  const toggleDone = () => {
    if (task.status === "done") {
      patchTask({ status: "open" });
    } else {
      run(() => apiCompleteTask(caseId, task.id));
    }
  };

  const onDelete = () => {
    if (!window.confirm(`Delete task “${task.title}”?`)) return;
    run(() => apiDeleteTask(caseId, task.id));
  };

  const subtasks = task.subtasks ?? [];
  const subDone = subtasks.filter((s) => s.done).length;

  const toggleSub = (sub: Subtask) => {
    const next = subtasks.map((s) => (s.id === sub.id ? { ...s, done: !s.done } : s));
    patchTask({ subtasks: next });
  };
  const deleteSub = (sub: Subtask) => {
    patchTask({ subtasks: subtasks.filter((s) => s.id !== sub.id) });
  };
  const addSub = () => {
    const title = newSub.trim();
    if (!title) return;
    const id = `${task.id}-S${(subtasks.length ? Math.max(...subtasks.map(subNum)) : 0) + 1}`;
    patchTask({ subtasks: [...subtasks, { id, title, done: false }] });
    setNewSub("");
  };

  return (
    <div className="rounded-md hover:bg-ink-50/60 transition">
      <div className="flex items-start gap-2 py-1.5 px-1">
        <button
          onClick={toggleDone}
          className="mt-0.5 shrink-0"
          aria-label={task.status === "done" ? "Mark task open" : "Mark task done"}
          title={task.status === "done" ? "Mark open" : "Mark done"}
        >
          {taskIcon(task.status)}
        </button>
        <div className="flex-1 min-w-0">
          <InlineTaskTitle
            value={task.title}
            done={task.status === "done"}
            onSave={(v) => patchTask({ title: v })}
          />
          <InlineTaskDetail value={task.detail ?? ""} onSave={(v) => patchTask({ detail: v })} />
          <div className="flex items-center gap-2 mt-0.5 flex-wrap text-[11px] text-ink-400">
            <TaskStatusInline value={task.status} onSave={(v) => patchTask({ status: v })} />
            <span>·</span>
            <TaskOwnerInline value={task.owner ?? ""} onSave={(v) => patchTask({ owner: v })} />
            <span>·</span>
            <TaskDueInline value={task.dueAt} onSave={(v) => patchTask({ dueAt: v })} />
            {subtasks.length > 0 && (
              <>
                <span>·</span>
                <button
                  onClick={() => setOpen((o) => !o)}
                  className="inline-flex items-center gap-0.5 hover:text-ink-700"
                  aria-expanded={open}
                >
                  {open ? <IconChevronDown className="w-3 h-3" /> : <IconChevronRight className="w-3 h-3" />}
                  {subDone}/{subtasks.length} sub
                </button>
              </>
            )}
            {subtasks.length === 0 && (
              <>
                <span>·</span>
                <button onClick={() => setOpen(true)} className="hover:text-ink-700">
                  + subtask
                </button>
              </>
            )}
          </div>
        </div>
        <button
          onClick={onDelete}
          aria-label="Delete task"
          title="Delete task"
          className="mt-0.5 shrink-0 text-ink-300 hover:text-rose-600 text-[14px] leading-none px-1"
        >
          ×
        </button>
      </div>

      {open && (
        <div className="pl-8 pr-2 pb-2 space-y-1">
          {subtasks.map((s) => (
            <div key={s.id} className="flex items-center gap-2 group">
              <button onClick={() => toggleSub(s)} aria-label={s.done ? "Uncheck subtask" : "Check subtask"}>
                {s.done ? (
                  <IconCheckCircle className="w-3.5 h-3.5 text-lane-done" />
                ) : (
                  <IconCircle className="w-3.5 h-3.5 text-ink-300" />
                )}
              </button>
              <span className={`text-[12px] flex-1 ${s.done ? "text-ink-400 line-through" : "text-ink-700"}`}>
                {s.title}
              </span>
              <button
                onClick={() => deleteSub(s)}
                aria-label="Delete subtask"
                className="text-ink-300 hover:text-rose-600 text-[13px] leading-none px-1 opacity-0 group-hover:opacity-100"
              >
                ×
              </button>
            </div>
          ))}
          <div className="flex items-center gap-2">
            <IconCircle className="w-3.5 h-3.5 text-ink-200" />
            <input
              type="text"
              value={newSub}
              aria-label="New subtask"
              placeholder="Add subtask…"
              onChange={(e) => setNewSub(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.stopPropagation();
                  setNewSub("");
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  addSub();
                }
              }}
              className="flex-1 bg-white border border-ink-200 rounded px-1.5 py-0.5 text-[12px] text-ink-900 outline-none focus:border-sky-300 focus:ring-2 focus:ring-sky-100"
            />
          </div>
        </div>
      )}
    </div>
  );
}

function subNum(s: Subtask): number {
  const m = /-S(\d+)$/.exec(s.id);
  return m ? Number(m[1]) : 0;
}

// Task title inline edit (single line, strikethrough when done).
function InlineTaskTitle({
  value,
  done,
  onSave,
}: {
  value: string;
  done: boolean;
  onSave: (v: string) => void;
}) {
  return (
    <EditableText
      label="Task title"
      value={value}
      onSave={onSave}
      className={`text-[13px] ${done ? "text-ink-400 line-through" : "text-ink-900"}`}
    />
  );
}

function InlineTaskDetail({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  return (
    <EditableText
      label="Task detail"
      value={value}
      onSave={onSave}
      className="text-[12px] text-ink-500 leading-snug"
      placeholder="Add detail…"
      multiline
      markdown
    />
  );
}

function TaskStatusInline({ value, onSave }: { value: TaskStatus; onSave: (v: TaskStatus) => void }) {
  return (
    <SelectInline
      value={value}
      options={VALID_TASK_STATUS.map((s) => ({ value: s, label: s.replace("_", " ") }))}
      onSave={(v) => onSave(v as TaskStatus)}
      render={(v) => <span className="capitalize">{v.replace("_", " ")}</span>}
    />
  );
}

function TaskOwnerInline({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  return (
    <EditableText
      label="Task owner"
      value={value}
      onSave={onSave}
      className="text-[11px] text-ink-400"
      placeholder="owner"
    />
  );
}

function TaskDueInline({ value, onSave }: { value?: string; onSave: (v: string | null) => void }) {
  return (
    <span className="inline-flex items-center">
      <DateInlineCompact value={value} onSave={onSave} />
    </span>
  );
}

// A tighter date inline for the task meta row.
function DateInlineCompact({ value, onSave }: { value?: string; onSave: (v: string | null) => void }) {
  const [editing, setEditing] = useState(false);
  const ref = useRef<HTMLInputElement | null>(null);
  const asDate = value ? new Date(value) : null;
  const inputVal = asDate && !Number.isNaN(asDate.getTime()) ? toDateInput(asDate) : "";

  useEffect(() => {
    if (editing) ref.current?.focus();
  }, [editing]);

  if (editing) {
    return (
      <input
        ref={ref}
        type="date"
        defaultValue={inputVal}
        aria-label="Task due date"
        onBlur={(e) => {
          setEditing(false);
          const v = e.target.value;
          if (v !== inputVal) onSave(v ? v : null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            setEditing(false);
          } else if (e.key === "Enter") {
            (e.target as HTMLInputElement).blur();
          }
        }}
        className="bg-white border border-sky-300 rounded px-1 py-0.5 text-[11px] text-ink-900 outline-none"
      />
    );
  }

  return (
    <button onClick={() => setEditing(true)} className="hover:text-ink-700" title="Set due date">
      {value ? dueLabel(value) : "no due"}
    </button>
  );
}

// ── Notes ──────────────────────────────────────────────────────────────────────
function NotesSection({
  caseId,
  notes,
  run,
}: {
  caseId: string;
  notes: CaseNote[];
  run: (fn: () => Promise<unknown>) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState("");

  const submit = async () => {
    const body = draft.trim();
    if (!body) return;
    const ok = await run(() => apiAddNote(caseId, body));
    if (ok) setDraft("");
  };

  // Render NEWEST-FIRST (fresh → old), mirroring the Messages section. Notes are
  // stored append-only (oldest-first), so sort a copy by createdAt desc; normalize
  // a bad/absent createdAt (NaN) so it sinks to the bottom deterministically rather
  // than landing in an engine-dependent spot among the valid rows.
  const createdMs = (n: CaseNote): number => {
    const t = new Date(n.createdAt).getTime();
    return Number.isNaN(t) ? -Infinity : t;
  };
  const orderedNotes = [...notes].sort((a, b) => createdMs(b) - createdMs(a));

  return (
    <Section title={`Notes · ${notes.length}`}>
      <div className="space-y-2.5">
        {notes.length === 0 && <div className="text-[12px] text-ink-400">No notes yet.</div>}
        {orderedNotes.map((n) => (
          <div key={n.id} className="rounded-md border border-ink-100 bg-ink-50/40 px-3 py-2">
            <div className="flex items-center gap-2 mb-1">
              <span className="inline-flex items-center gap-1 text-[11px] text-ink-500">
                {n.author === "agent" ? (
                  <IconSpark className="w-3 h-3 text-violet-500" />
                ) : (
                  <span
                    className={`w-3.5 h-3.5 rounded-full ${colorFor(n.author)} text-white text-[8px] font-medium grid place-items-center`}
                  >
                    {initials(n.author)}
                  </span>
                )}
                <span className="capitalize">{n.author}</span>
              </span>
              <span className="ml-auto text-[11px] text-ink-400">{relativeTime(n.createdAt)} ago</span>
            </div>
            <ReadMore collapsedHeight={160} fadeClass="from-ink-50">
              <Markdown className="text-[12.5px] text-ink-700 leading-relaxed">{n.body}</Markdown>
            </ReadMore>
          </div>
        ))}
      </div>

      <div className="mt-3">
        <textarea
          value={draft}
          aria-label="Add a note"
          placeholder="Add a note…"
          rows={2}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              submit();
            }
          }}
          className="w-full bg-white border border-ink-200 rounded px-2 py-1.5 text-[12.5px] text-ink-900 outline-none focus:border-sky-300 focus:ring-2 focus:ring-sky-100 resize-none"
        />
        <div className="flex items-center justify-between mt-1">
          <span className="text-[10.5px] text-ink-400">⌘/Ctrl + Enter to add</span>
          <button
            onClick={submit}
            disabled={!draft.trim()}
            className="text-[12px] px-2 py-1 rounded bg-ink-900 text-white hover:bg-ink-700 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Add note
          </button>
        </div>
      </div>
    </Section>
  );
}

// ── Reminders ────────────────────────────────────────────────────────────────────
// The lightweight nudges linked to THIS node (the bidirectional twin of the
// reminders surface). SELF-CONTAINED: owns its own fetch + state (like VaultSection
// does for its preview), so it doesn't widen the drawer's props or touch any sibling
// section. The link is reminder.caseId — we fetch only the reminders for this id, so
// it works identically for an Initiative, a Workstream, or a leaf Case. New
// reminders prefill caseId + mirror the case domain. After ANY mutation we re-fetch
// locally AND call onChanged?.() so the parent refetches the case (its activity log
// reflects the linked-reminder change).
function RemindersSection({
  caseId,
  domain,
  labelCatalog = [],
  onChanged,
}: {
  caseId: string;
  domain: CaseDomain;
  labelCatalog?: LabelDef[];
  onChanged?: () => void;
}) {
  // id → LabelDef for resolving a reminder's label ids to title/colour chips.
  const labelById = useMemo(() => new Map(labelCatalog.map((l) => [l.id, l])), [labelCatalog]);
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const addRef = useRef<HTMLInputElement | null>(null);

  // (Re)load this node's reminders on mount and whenever caseId changes. The
  // cancelled flag guards against a setState after the drawer swaps cases /
  // unmounts mid-flight (the open drawer can switch to another card).
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiFetchReminders({ caseId })
      .then((res) => {
        if (cancelled) return;
        setReminders(sortReminders(res.reminders));
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Failed to load reminders.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [caseId]);

  useEffect(() => {
    if (adding) addRef.current?.focus();
  }, [adding]);

  // Re-pull this node's reminders after a mutation, then bubble to the parent so
  // the linked-case activity log refetches. Surfaces any failure inline.
  const reload = async () => {
    try {
      const res = await apiFetchReminders({ caseId });
      setReminders(sortReminders(res.reminders));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load reminders.");
    }
  };

  // Shared mutation runner mirroring the drawer's `run`: clear the banner, run the
  // call, refetch locally + bubble on success, surface the error text on failure.
  const run = async (fn: () => Promise<unknown>): Promise<boolean> => {
    setError(null);
    try {
      await fn();
      await reload();
      onChanged?.();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
      return false;
    }
  };

  const commitAdd = async () => {
    const title = draft.trim();
    if (!title) {
      setAdding(false);
      return;
    }
    const ok = await run(() => apiCreateReminder({ title, caseId, domain }));
    if (ok) {
      setDraft("");
      // keep adding for fast multi-entry (mirrors TasksSection)
      addRef.current?.focus();
    }
  };

  const toggleDone = (r: Reminder) =>
    r.status === "open"
      ? run(() => apiCompleteReminder(r.id))
      : run(() => apiUpdateReminder(r.id, { status: "open" }));

  const onDelete = (r: Reminder) => {
    if (!window.confirm(`Delete reminder “${r.title}”?`)) return;
    run(() => apiDeleteReminder(r.id));
  };

  return (
    <Section
      title={`Reminders · ${reminders.length}`}
      right={
        <button
          onClick={() => setAdding(true)}
          className="inline-flex items-center gap-1 text-[11.5px] text-ink-500 hover:text-ink-900 px-1.5 py-0.5 rounded hover:bg-ink-50"
          aria-label="Add reminder"
        >
          <IconPlus className="w-3 h-3" />
          Add
        </button>
      }
    >
      {error && (
        <div
          role="alert"
          className="mb-2 text-[11.5px] text-rose-700 bg-rose-50 border border-rose-100 rounded px-2 py-1 flex items-center gap-1.5"
        >
          <IconWarning className="w-3 h-3 shrink-0" />
          <span className="flex-1">{error}</span>
        </div>
      )}

      <div className="space-y-1">
        {loading ? (
          <div className="text-[12px] text-ink-400">Loading…</div>
        ) : (
          <>
            {reminders.length === 0 && !adding && (
              <div className="text-[12px] text-ink-400">No reminders linked to this case.</div>
            )}
            {reminders.map((r) => {
              const open = r.status === "open";
              const labelIds = r.labels ?? [];
              const tasks = r.tasks ?? [];
              const tasksDone = tasks.filter((t) => t.done).length;
              return (
                <div key={r.id} className="flex items-start gap-2 py-1 px-1 rounded-md hover:bg-ink-50/60 transition">
                  <button
                    onClick={() => toggleDone(r)}
                    className="mt-0.5 shrink-0"
                    aria-label={open ? "Mark reminder done" : "Reopen reminder"}
                    title={open ? "Mark done" : "Reopen"}
                  >
                    {open ? (
                      <IconCircle className="w-4 h-4 text-ink-300" />
                    ) : (
                      <IconCheckCircle className="w-4 h-4 text-lane-done" />
                    )}
                  </button>
                  <div className="flex-1 min-w-0">
                    <div className={`text-[13px] ${open ? "text-ink-900" : "text-ink-400 line-through"}`}>
                      {r.title}
                    </div>
                    {r.detail && (
                      <Markdown className="text-[12px] text-ink-500 leading-snug mt-0.5">{r.detail}</Markdown>
                    )}
                    {(labelIds.length > 0 || tasks.length > 0) && (
                      <div className="flex items-center gap-1 flex-wrap mt-1">
                        {labelIds.map((id) => {
                          const def = labelById.get(id);
                          return (
                            <span
                              key={id}
                              title={def?.description ?? `Unknown label: ${id}`}
                              className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${labelChipClasses(def?.color)} ${
                                def ? "" : "opacity-60 italic"
                              }`}
                            >
                              {def?.title ?? id}
                            </span>
                          );
                        })}
                        {tasks.length > 0 && (
                          <span
                            className="text-[10px] tabular-nums px-1.5 py-0.5 rounded-full font-medium bg-ink-100 text-ink-600"
                            title="Checklist progress"
                          >
                            {tasksDone}/{tasks.length}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                  {r.dueAt && (
                    <span
                      className={`mt-0.5 shrink-0 inline-flex items-center text-[11px] px-1.5 py-0.5 rounded-full font-medium ${dueClasses(dueStatus(r.dueAt))}`}
                      title="When to be reminded"
                    >
                      {dueLabel(r.dueAt)}
                    </span>
                  )}
                  <button
                    onClick={() => onDelete(r)}
                    aria-label="Delete reminder"
                    title="Delete reminder"
                    className="mt-0.5 shrink-0 text-ink-300 hover:text-rose-600 text-[14px] leading-none px-1"
                  >
                    ×
                  </button>
                </div>
              );
            })}
            {adding && (
              <div className="flex items-center gap-2 py-1">
                <IconCircle className="w-4 h-4 text-ink-300 shrink-0" />
                <input
                  ref={addRef}
                  type="text"
                  value={draft}
                  aria-label="New reminder title"
                  placeholder="New reminder…"
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={commitAdd}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      e.stopPropagation();
                      setAdding(false);
                      setDraft("");
                    } else if (e.key === "Enter") {
                      e.preventDefault();
                      commitAdd();
                    }
                  }}
                  className="flex-1 bg-white border border-sky-300 rounded px-1.5 py-1 text-[13px] text-ink-900 outline-none focus:ring-2 focus:ring-sky-100"
                />
              </div>
            )}
          </>
        )}
      </div>
    </Section>
  );
}

// ── Activity ────────────────────────────────────────────────────────────────────
function ActivitySection({ activity }: { activity: CaseActivity[] }) {
  const [open, setOpen] = useState(false);
  // newest first
  const ordered = [...activity].reverse();

  return (
    <div className="px-5 py-4">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-ink-400 hover:text-ink-600"
        aria-expanded={open}
      >
        {open ? <IconChevronDown className="w-3.5 h-3.5" /> : <IconChevronRight className="w-3.5 h-3.5" />}
        Activity · {activity.length}
      </button>

      {open && (
        <div className="mt-3">
          {ordered.length === 0 ? (
            <div className="text-[12px] text-ink-400">No activity recorded.</div>
          ) : (
            <ol className="space-y-2 border-l border-ink-100 pl-3">
              {ordered.map((a, i) => (
                <li key={`${a.ts}-${i}`} className="relative">
                  <span className="absolute -left-[15px] top-1.5 w-1.5 h-1.5 rounded-full bg-ink-200" aria-hidden />
                  <div className="flex items-baseline gap-1.5 text-[12px]">
                    <ActivityActor actor={a.actor} />
                    <span className="text-ink-700 font-medium">{a.verb.replace(/_/g, " ")}</span>
                    {a.detail && <span className="text-ink-500">— {a.detail}</span>}
                  </div>
                  <div className="text-[11px] text-ink-400">{relativeTime(a.ts)} ago</div>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}

function ActivityActor({ actor }: { actor: CaseActivity["actor"] }) {
  if (actor === "agent")
    return (
      <span className="inline-flex items-center gap-1 text-violet-600">
        <IconSpark className="w-3 h-3" /> agent
      </span>
    );
  if (actor === "system") return <span className="text-ink-400">system</span>;
  return <span className="text-ink-500">you</span>;
}

// ── Messages ────────────────────────────────────────────────────────────────────
// Whether a message is INHERITED into the open node's rolled-up list — i.e. it
// belongs to a DIFFERENT case (a descendant), not this node itself. A message with
// no caseId, or one whose caseId is the open node, is the node's OWN mail. Shared
// by the section-header count and the per-row chip so the two can never disagree.
function isInherited(m: MessageRecord, ownerId: string): boolean {
  return m.caseId !== undefined && m.caseId !== "" && m.caseId !== ownerId;
}

// A row in the (possibly rolled-up) Messages list. When the open node is a
// container, the list inherits its descendants' mail — so a message whose caseId
// differs from the open node's id is INHERITED, and we tag it with a small chip
// naming the owning child case ("from CASE-7 · <title>", resolved from allCases)
// so the provenance is never lost. The node's OWN mail (caseId === ownerId, or no
// caseId at all) shows no chip — it already belongs here.
function MessageRow({
  message,
  ownerId,
  allCases,
}: {
  message: MessageRecord;
  ownerId: string;
  allCases: CaseRecord[];
}) {
  const inherited = isInherited(message, ownerId);
  const owner = inherited ? allCases.find((c) => c.id === message.caseId) : undefined;
  // Show the body when present; for a summary-only stub (empty body) fall back to
  // the preview so the row is never blank. This compact row is already a snippet
  // view, so the fallback needs no label (cf. the inbox reading pane, which does).
  const { text: bodyText } = messageContent(message);
  return (
    <div className="rounded-md border border-ink-100 bg-ink-50/40">
      <div className="px-3 py-2 flex items-center gap-2 border-b border-ink-100">
        <SourceIcon source={message.source} />
        <span className="text-[12.5px] font-medium text-ink-900 truncate">{message.from}</span>
        <span className="ml-auto text-[11px] text-ink-400">{relativeTime(message.receivedAt)}</span>
        {/* Deep-link back to the original message (Gmail thread, etc.) when captured. */}
        <MessageLink url={messageDeepLink(message)} />
      </div>
      <div className="px-3 py-2">
        {inherited && (
          <div
            className="inline-flex items-center gap-1 text-[10.5px] text-ink-500 bg-ink-100 rounded-full px-1.5 py-0.5 mb-1.5"
            title={owner ? `Inherited from ${owner.id} · ${owner.title}` : `Inherited from ${message.caseId}`}
          >
            <span className="text-ink-400">from</span>
            <span className="tabular-nums font-medium text-ink-600">{message.caseId}</span>
            {owner && (
              <>
                <span className="text-ink-300">·</span>
                <span className="truncate max-w-[180px]">{owner.title}</span>
              </>
            )}
          </div>
        )}
        <div className="text-[12.5px] font-medium text-ink-900 mb-1">{message.subject}</div>
        <div className="text-[12px] text-ink-500 whitespace-pre-line leading-relaxed line-clamp-6">
          {bodyText || <span className="italic text-ink-400">(no message content)</span>}
        </div>
      </div>
    </div>
  );
}

// ── helpers ─────────────────────────────────────────────────────────────────────
// Local yyyy-mm-dd for the native date input (avoids UTC off-by-one from toISOString).
function toDateInput(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

"use client";

// The calendar event editor — a slide-over used for BOTH creating a new event
// (no `event`, just a prefilled `date`) and editing an existing one. It mirrors
// the SHELL of CaseDetailDrawer (fixed overlay + right aside + header Close +
// error banner) but is SELF-CONTAINED: native inputs, no private drawer internals.
//
// It owns its own mutations via board-client (createEvent / updateEvent /
// deleteEvent) and calls onSaved() after each success so the parent refetches and
// closes. API errors surface in the banner (the thrown Error.message). Esc and an
// overlay click both close.
//
// The headline gesture is the linked-case picker — a typeahead that REUSES the
// inbox TriagePanel approach (filter cases to not-done && not-archived, match on
// id/title, cap ~8, show a lane dot). Linking the appointment to a case is
// PREFERRED; leaving it unlinked is fine.

import { useEffect, useMemo, useRef, useState } from "react";
import type { CalendarEvent, CaseRecord } from "@/lib/types";
import { LANES } from "@/lib/types";
import { domainLabel, domainClasses } from "@/lib/format";
import { createEvent, updateEvent, deleteEvent } from "@/lib/board-client";
import { IconWarning, IconDot, IconSearch } from "@/components/icons";

export function EventDrawer({
  event,
  date,
  cases,
  onSaved,
  onClose,
}: {
  // The event being edited, or null when composing a brand-new one.
  event: CalendarEvent | null;
  // Seed date for a new event (and the default when an edited event has no date).
  date: string;
  cases: CaseRecord[];
  onSaved: () => void;
  onClose: () => void;
}) {
  const isEdit = event !== null;

  // ── Form state (seeded from the event, or sensible new-event defaults) ──────
  const [title, setTitle] = useState(event?.title ?? "");
  const [day, setDay] = useState(event?.date ?? date);
  const [allDay, setAllDay] = useState(event?.allDay ?? false);
  const [startTime, setStartTime] = useState(event?.startTime ?? "");
  const [endTime, setEndTime] = useState(event?.endTime ?? "");
  const [description, setDescription] = useState(event?.description ?? "");
  const [location, setLocation] = useState(event?.location ?? "");
  const [caseId, setCaseId] = useState<string | undefined>(event?.caseId);

  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Esc closes the drawer (matching CaseDetailDrawer). Bound once per mount.
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
  // Build the wire payload from the form. Times only ride along when timed; an
  // empty time string is omitted (the route treats absent as "no time").
  const buildPayload = (): Record<string, unknown> => {
    const payload: Record<string, unknown> = {
      title: title.trim(),
      date: day,
      allDay,
      // Send explicit nulls on edit so clearing a field actually clears it; on
      // create the route just ignores nulls/empties.
      startTime: !allDay && startTime ? startTime : null,
      endTime: !allDay && endTime ? endTime : null,
      description: description.trim() ? description.trim() : null,
      location: location.trim() ? location.trim() : null,
      caseId: caseId ?? null,
    };
    return payload;
  };

  const onSave = async () => {
    if (!title.trim()) {
      setError("Title is required.");
      return;
    }
    setError(null);
    setSaving(true);
    try {
      if (isEdit && event) {
        await updateEvent(event.id, buildPayload());
      } else {
        await createEvent(buildPayload());
      }
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save the event.");
      setSaving(false);
    }
  };

  const onDelete = async () => {
    if (!isEdit || !event) return;
    if (!window.confirm(`Delete “${event.title}”? This cannot be undone.`)) return;
    setError(null);
    setSaving(true);
    try {
      await deleteEvent(event.id);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete the event.");
      setSaving(false);
    }
  };

  return (
    <>
      <div className="fixed inset-0 bg-black/20 z-40" onClick={onClose} aria-hidden />
      <aside
        role="dialog"
        aria-label={isEdit ? `Edit event ${event?.id}` : "New appointment"}
        className="fixed top-0 right-0 h-screen w-full sm:w-[460px] bg-white border-l border-ink-200 shadow-xl z-50 flex flex-col"
      >
        <div className="px-5 h-12 flex items-center border-b border-ink-100 gap-2">
          <span className="text-[13px] font-semibold text-ink-900">
            {isEdit ? "Edit appointment" : "New appointment"}
          </span>
          {isEdit && event && (
            <span className="text-[11px] tabular-nums text-ink-400">{event.id}</span>
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
          {/* Title */}
          <Field label="Title">
            <input
              type="text"
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="What's the appointment?"
              aria-label="Title"
              className="w-full bg-white border border-ink-200 rounded-md px-2 py-1.5 text-[13px] text-ink-900 outline-none focus:border-sky-300 focus:ring-2 focus:ring-sky-100 placeholder:text-ink-400"
            />
          </Field>

          {/* Date + all-day */}
          <div className="flex items-end gap-3">
            <div className="flex-1">
              <Field label="Date">
                <input
                  type="date"
                  value={day}
                  onChange={(e) => setDay(e.target.value)}
                  aria-label="Date"
                  className="w-full bg-white border border-ink-200 rounded-md px-2 py-1.5 text-[12.5px] text-ink-900 outline-none focus:border-sky-300 focus:ring-2 focus:ring-sky-100"
                />
              </Field>
            </div>
            <label className="flex items-center gap-1.5 text-[12.5px] text-ink-700 pb-1.5 select-none cursor-pointer">
              <input
                type="checkbox"
                checked={allDay}
                onChange={(e) => setAllDay(e.target.checked)}
                className="accent-ink-900"
              />
              All-day
            </label>
          </div>

          {/* Start / end time — only when timed */}
          {!allDay && (
            <div className="flex gap-3">
              <div className="flex-1">
                <Field label="Start time">
                  <input
                    type="time"
                    value={startTime}
                    onChange={(e) => setStartTime(e.target.value)}
                    aria-label="Start time"
                    className="w-full bg-white border border-ink-200 rounded-md px-2 py-1.5 text-[12.5px] text-ink-900 outline-none focus:border-sky-300 focus:ring-2 focus:ring-sky-100"
                  />
                </Field>
              </div>
              <div className="flex-1">
                <Field label="End time">
                  <input
                    type="time"
                    value={endTime}
                    onChange={(e) => setEndTime(e.target.value)}
                    aria-label="End time"
                    className="w-full bg-white border border-ink-200 rounded-md px-2 py-1.5 text-[12.5px] text-ink-900 outline-none focus:border-sky-300 focus:ring-2 focus:ring-sky-100"
                  />
                </Field>
              </div>
            </div>
          )}

          {/* Linked case — the headline gesture. Prefer linking to live work. */}
          <Field label="Linked case">
            <CasePicker
              cases={cases}
              linkedCase={linkedCase}
              linkedLane={linkedLane}
              onLink={(id) => setCaseId(id)}
              onUnlink={() => setCaseId(undefined)}
            />
          </Field>

          {/* Location */}
          <Field label="Location">
            <input
              type="text"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="Optional — where is it?"
              aria-label="Location"
              className="w-full bg-white border border-ink-200 rounded-md px-2 py-1.5 text-[12.5px] text-ink-900 outline-none focus:border-sky-300 focus:ring-2 focus:ring-sky-100 placeholder:text-ink-400"
            />
          </Field>

          {/* Description */}
          <Field label="Description">
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              placeholder="Optional notes…"
              aria-label="Description"
              className="w-full bg-white border border-ink-200 rounded-md px-2 py-1.5 text-[12.5px] text-ink-900 outline-none focus:border-sky-300 focus:ring-2 focus:ring-sky-100 placeholder:text-ink-400 resize-y"
            />
          </Field>
        </div>

        {/* Footer — Save (create/patch) + Delete on an existing event */}
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
              {saving ? "Saving…" : isEdit ? "Save changes" : "Create appointment"}
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}

// A labelled form row (mirrors the drawer's FieldRow uppercase-label look).
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-ink-400 mb-1">{label}</div>
      {children}
    </div>
  );
}

// The linked-case typeahead — REUSES the inbox TriagePanel approach. When a case
// is linked it shows "CASE-n — title" + a lane dot + an Unlink button; otherwise a
// "Link to existing case" button opens a search box filtered to live (not-done,
// not-archived) cases matching id/title, capped to ~8.
function CasePicker({
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

  // Exclude done/archived cases — you link an appointment to live work.
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

  // Linked state: show the case + lane dot + Unlink.
  if (linkedCase) {
    return (
      <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-md border border-ink-100 bg-ink-50/40">
        <span className="tabular-nums text-ink-500 font-medium text-[12px] shrink-0">
          {linkedCase.id}
        </span>
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

  // Unlinked + not picking: the "Link to existing case" affordance.
  if (!picking) {
    return (
      <button
        onClick={() => setPicking(true)}
        className="inline-flex items-center gap-1.5 text-[12px] px-2.5 py-1 rounded-md border border-ink-200 text-ink-700 hover:bg-ink-50 transition"
      >
        Link to existing case
      </button>
    );
  }

  // Picking: the search box + results, exactly like the inbox TriagePanel.
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
            placeholder="Search cases by id or title…"
            aria-label="Search cases to link"
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
        aria-label="Cases"
      >
        {candidates.length === 0 ? (
          <div className="px-3 py-3 text-[12px] text-ink-400 text-center">
            No matching open cases
          </div>
        ) : (
          candidates.map((c) => {
            const lane = LANES.find((l) => l.key === c.status);
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

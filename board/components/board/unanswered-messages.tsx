"use client";

import { useCallback, useEffect, useState } from "react";
import type { CaseRecord, MessageRecord } from "@/lib/types";
import { fetchUnanswered, markAnswered, subscribeToBoard } from "@/lib/board-client";
import { messageContent } from "@/lib/inbox";
import { relativeTime } from "@/lib/format";
import { SourceIcon } from "@/components/shared/source-icon";
import { MessageLink } from "@/components/shared/message-link";
import { messageDeepLink } from "@/lib/message-url";

// The "Unanswered" panel — a slide-over listing every message the user still owes a
// reply to (UNANSWERED === needsAnswer && !answeredAt). The flag is set only by the
// skill/MCP; this surface is view + mark-answered (no manual flag here). It OWNS its
// list: it fetches on open and on every board SSE version bump, so skill/agent writes
// appear live (the board's static `messages` prop would never refresh). Marking a row
// answered is optimistic (drop it) → markAnswered → revert + inline error on failure;
// the row leaves the view because the predicate no longer holds. Cloned from the
// LabelManager slide-over scaffold.
export function UnansweredMessages({
  open,
  onClose,
  cases,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  cases: CaseRecord[];
  onChanged?: () => void;
}) {
  const [messages, setMessages] = useState<MessageRecord[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Pull the unanswered set (newest-first). Best-effort: surfaces the API error text.
  const load = useCallback(async () => {
    try {
      const res = await fetchUnanswered();
      setMessages(res.messages);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load unanswered messages.");
    }
  }, []);

  // Fetch on open, and re-fetch on each SSE version bump while open, so a skill/agent
  // flagging or answering a message lands here without a reload. Plus the Escape close.
  useEffect(() => {
    if (!open) return;
    void load();
    const unsub = subscribeToBoard(() => {
      void load();
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      unsub();
      window.removeEventListener("keydown", onKey);
    };
  }, [open, load, onClose]);

  if (!open) return null;

  // Optimistically drop the row, then mark it answered server-side. On failure put the
  // row back and surface the error — mirrors inbox/inbox-view.tsx setRead.
  const onAnswer = async (m: MessageRecord): Promise<void> => {
    setError(null);
    setMessages((prev) => prev.filter((x) => x.id !== m.id));
    try {
      await markAnswered(m.id);
      onChanged?.();
    } catch (e) {
      setMessages((prev) => (prev.some((x) => x.id === m.id) ? prev : [m, ...prev]));
      setError(e instanceof Error ? e.message : "Failed to mark answered.");
    }
  };

  return (
    <>
      <div className="fixed inset-0 bg-black/20 z-[60]" onClick={onClose} aria-hidden />
      <aside
        role="dialog"
        aria-label="Unanswered messages"
        className="fixed top-0 right-0 h-screen w-full sm:w-[520px] bg-white border-l border-ink-200 shadow-xl z-[61] flex flex-col"
      >
        <div className="px-5 h-12 flex items-center border-b border-ink-100 gap-2">
          <span className="text-[13px] font-semibold text-ink-900">Unanswered</span>
          <span className="text-[11.5px] text-ink-400 tabular-nums">
            {messages.length} waiting
          </span>
          <button
            onClick={onClose}
            aria-label="Close unanswered messages"
            className="ml-auto text-[12px] text-ink-500 hover:text-ink-900 px-2 py-1 rounded hover:bg-ink-50"
          >
            Close · Esc
          </button>
        </div>

        {error && (
          <div role="alert" className="mx-5 mt-3 px-3 py-2 text-[12px] text-rose-700 bg-rose-50 border border-rose-100 rounded-md">
            {error}
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {messages.length === 0 ? (
            <div className="text-[12.5px] text-ink-400 py-10 text-center">
              Nothing waiting — you&apos;re all caught up
            </div>
          ) : (
            <div className="space-y-2">
              {messages.map((m) => (
                <UnansweredRow key={m.id} message={m} cases={cases} onAnswer={onAnswer} />
              ))}
            </div>
          )}
        </div>
      </aside>
    </>
  );
}

// One unanswered message: the source glyph + sender (who) + relative receivedAt (date)
// + the deep-link, the one-sentence context (the message's own `context`, else a chip
// resolving the linked case), the body snippet, and a "Mark answered" button. Reuses
// the MessageRow layout from case-detail-drawer.tsx.
function UnansweredRow({
  message,
  cases,
  onAnswer,
}: {
  message: MessageRecord;
  cases: CaseRecord[];
  onAnswer: (m: MessageRecord) => void;
}) {
  const { text: bodyText } = messageContent(message);
  // The one-line context: prefer the captured `context`; otherwise resolve the linked
  // case ("CASE-7 · <title>"), or note there's none.
  const linkedCase = message.caseId ? cases.find((c) => c.id === message.caseId) : undefined;
  const context =
    message.context?.trim() ||
    (linkedCase ? `${linkedCase.id} · ${linkedCase.title}` : "No linked case");

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
        <div className="text-[11.5px] text-ink-500 mb-1.5">{context}</div>
        <div className="text-[12px] text-ink-500 whitespace-pre-line leading-relaxed line-clamp-4">
          {bodyText || <span className="italic text-ink-400">(no message content)</span>}
        </div>
        <div className="mt-2 flex items-center">
          <button
            onClick={() => onAnswer(message)}
            className="ml-auto text-[12px] px-2.5 py-1 rounded-md border border-ink-200 text-ink-900 hover:bg-ink-50 transition"
          >
            Mark answered
          </button>
        </div>
      </div>
    </div>
  );
}

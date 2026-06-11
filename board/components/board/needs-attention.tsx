// The "needs attention" tray for the Today page. Pure projection over the
// cases via selectors.needsAttention — four buckets (overdue / aging-waiting /
// untriaged / unlinked), each with a count and jump links into the board. No
// client state: it's a read-only triage surface, so it stays a server component.

import Link from "next/link";
import type { CaseRecord } from "@/lib/types";
import { needsAttention, dueStatus } from "@/lib/selectors";
import { dueLabel, dueClasses, slaLabel, caseHref } from "@/lib/format";
import { IconWarning, IconChat, IconCircle, IconFolder, IconCheckCircle } from "@/components/icons";

type Bucket = {
  key: string;
  label: string;
  hint: string;
  tone: string; // ring/text accent for the count chip
  icon: React.ReactNode;
  cases: CaseRecord[];
  badge?: (c: CaseRecord) => React.ReactNode;
};

export function NeedsAttention({ cases, now }: { cases: CaseRecord[]; now?: Date }) {
  const at = needsAttention(cases, now);

  const buckets: Bucket[] = [
    {
      key: "overdue",
      label: "Overdue",
      hint: "Past their due date",
      tone: "text-rose-700 ring-rose-200 bg-rose-50",
      icon: <IconWarning className="w-3.5 h-3.5 text-lane-urgent" />,
      cases: at.overdue,
      badge: (c) => (
        <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${dueClasses(dueStatus(c.dueAt, now))}`}>
          {dueLabel(c.dueAt, now)}
        </span>
      ),
    },
    {
      key: "agingWaiting",
      label: "Aging — waiting",
      hint: "Waiting on someone > 3 days",
      tone: "text-sky-700 ring-sky-200 bg-sky-50",
      icon: <IconChat className="w-3.5 h-3.5 text-lane-client" />,
      cases: at.agingWaiting,
      badge: (c) => (
        <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-sky-50 text-sky-700 ring-1 ring-sky-200">
          {slaLabel(c, now)}
        </span>
      ),
    },
    {
      key: "untriaged",
      label: "Untriaged",
      hint: "In To-do, no tasks or priority",
      tone: "text-amber-700 ring-amber-200 bg-amber-50",
      icon: <IconCircle className="w-3.5 h-3.5 text-lane-todo" />,
      cases: at.untriaged,
    },
    {
      key: "unlinked",
      label: "No knowledge linked",
      hint: "No vault links yet",
      tone: "text-violet-700 ring-violet-200 bg-violet-50",
      icon: <IconFolder className="w-3.5 h-3.5 text-lane-progress" />,
      cases: at.unlinked,
    },
  ];

  const total = buckets.reduce((n, b) => n + b.cases.length, 0);

  if (total === 0) {
    return (
      <section aria-label="Needs attention" className="rounded-lg border border-ink-100 bg-white p-5">
        <div className="flex items-center gap-2 text-[13px] text-ink-500">
          <IconCheckCircle className="w-4 h-4 text-lane-done" />
          Nothing needs attention — overdue, aging, untriaged and unlinked are all clear.
        </div>
      </section>
    );
  }

  return (
    <section aria-label="Needs attention" className="space-y-2">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {buckets.map((b) => (
          <BucketCard key={b.key} bucket={b} now={now} />
        ))}
      </div>
    </section>
  );
}

function BucketCard({ bucket, now }: { bucket: Bucket; now?: Date }) {
  const { label, hint, tone, icon, cases, badge } = bucket;
  return (
    <div className="rounded-lg border border-ink-100 bg-white p-3">
      <div className="flex items-center gap-2">
        {icon}
        <span className="text-[12.5px] font-medium text-ink-900">{label}</span>
        <span className={`ml-auto text-[11px] font-medium tabular-nums px-1.5 py-0.5 rounded-full ring-1 ${tone}`}>
          {cases.length}
        </span>
      </div>
      <p className="text-[11px] text-ink-400 mt-0.5">{hint}</p>

      {cases.length === 0 ? (
        <p className="text-[11.5px] text-ink-400 mt-2">All clear.</p>
      ) : (
        <ul className="mt-2 space-y-0.5">
          {cases.slice(0, 5).map((c) => (
            <li key={c.id}>
              <Link
                href={caseHref(c.id)}
                className="group flex items-center gap-2 rounded-md px-1.5 py-1 -mx-1.5 hover:bg-ink-50 transition"
              >
                <span className="text-[11px] text-ink-400 tabular-nums shrink-0">{c.id}</span>
                <span className="text-[12px] text-ink-700 truncate flex-1 group-hover:text-ink-900">
                  {c.title}
                </span>
                {badge?.(c)}
              </Link>
            </li>
          ))}
          {cases.length > 5 && (
            <li className="text-[11px] text-ink-400 px-1.5 pt-0.5">+{cases.length - 5} more</li>
          )}
        </ul>
      )}
    </div>
  );
}

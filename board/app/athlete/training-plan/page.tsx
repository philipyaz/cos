"use client";

import { useState } from "react";
import { TopBar } from "@/components/topbar";

// ── Types ────────────────────────────────────────────────────────────────────

interface PlanDay {
  date: string;
  day: string;
  type: string;
  sport: string;
  duration_min: number;
  intensity: string;
  description: string;
  zones: string;
}

interface TrainingPlan {
  week: string;
  generated_at: string;
  recovery_status: string;
  days: PlanDay[];
  weekly_notes: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

// Keyed on the English intensity vocabulary the /api/athlete/training-plan route emits
// ("easy" | "moderate" | "hard").
const INTENSITY_COLORS: Record<string, string> = {
  easy: "bg-emerald-50 text-emerald-700 border-emerald-200",
  moderate: "bg-amber-50 text-amber-700 border-amber-200",
  hard: "bg-red-50 text-red-700 border-red-200",
};

const INTENSITY_LABEL: Record<string, string> = {
  easy: "Easy",
  moderate: "Moderate",
  hard: "Hard",
};

const RECOVERY_BADGE: Record<string, { label: string; cls: string }> = {
  good: { label: "Good recovery", cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  moderate: { label: "Moderate recovery", cls: "bg-amber-50 text-amber-700 border-amber-200" },
  poor: { label: "Poor recovery", cls: "bg-red-50 text-red-700 border-red-200" },
};

// Keyed on the English day-type vocabulary ("training" | "rest" | "active_recovery").
const TYPE_ICON: Record<string, string> = {
  training: "●",
  rest: "○",
  active_recovery: "◐",
};

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    day: "numeric",
    month: "short",
  });
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function TrainingPlanPage() {
  const [plan, setPlan] = useState<TrainingPlan | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pushing, setPushing] = useState(false);
  const [pushResult, setPushResult] = useState<{ created: number; failed: number } | null>(null);

  const pushToCalendar = async () => {
    if (!plan) return;
    setPushing(true);
    setPushResult(null);
    try {
      const res = await fetch("/api/athlete/push-plan-to-calendar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan }),
      });
      const data = await res.json();
      if (res.ok) {
        setPushResult({ created: data.created, failed: data.failed });
      } else {
        setError(data.error ?? "Calendar error");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setPushing(false);
    }
  };

  const generate = async () => {
    setLoading(true);
    setError(null);
    setPlan(null);
    try {
      const res = await fetch("/api/athlete/training-plan");
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Unknown error");
        return;
      }
      setPlan(data.plan);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setLoading(false);
    }
  };

  const totalMin = plan?.days.reduce((s, d) => s + (d.duration_min || 0), 0) ?? 0;
  const trainingDays = plan?.days.filter((d) => d.type === "training").length ?? 0;

  return (
    <>
      <TopBar crumbs={["Cos", "Athlete", "Training plan"]} />
      <main className="flex-1 overflow-y-auto p-5 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <h1 className="text-[15px] font-semibold text-ink-900">
            Training plan
          </h1>
          <div className="flex items-center gap-2">
            {plan && (
              <button
                onClick={pushToCalendar}
                disabled={pushing}
                className="px-4 py-1.5 rounded-md border border-ink-200 bg-white text-ink-700 text-[13px] font-medium hover:bg-ink-50 disabled:opacity-50 transition flex items-center gap-2"
              >
                {pushing && <Spinner />}
                {pushing ? "Adding..." : "Add to calendar"}
              </button>
            )}
            <button
              onClick={generate}
              disabled={loading}
              className="px-4 py-1.5 rounded-md bg-ink-900 text-white text-[13px] font-medium hover:bg-ink-800 disabled:opacity-50 transition flex items-center gap-2"
            >
              {loading && <Spinner />}
              {loading ? "Generating..." : "Generate this week's plan"}
            </button>
          </div>
        </div>

        {/* Push result */}
        {pushResult && (
          <div className={`rounded-lg border px-4 py-3 ${pushResult.failed === 0 ? "border-emerald-200 bg-emerald-50" : "border-amber-200 bg-amber-50"}`}>
            <p className={`text-[13px] ${pushResult.failed === 0 ? "text-emerald-700" : "text-amber-700"}`}>
              {pushResult.created} event{pushResult.created > 1 ? "s" : ""} added to the calendar
              {pushResult.failed > 0 && ` (${pushResult.failed} failed)`}
            </p>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3">
            <p className="text-[13px] text-red-700">{error}</p>
          </div>
        )}

        {/* Empty state */}
        {!plan && !loading && !error && (
          <div className="rounded-lg border border-ink-100 bg-white p-8 text-center shadow-card">
            <p className="text-[13px] text-ink-500">
              Click &quot;Generate this week&apos;s plan&quot; to get a personalized
              plan based on your profile and your health data.
            </p>
          </div>
        )}

        {/* Loading skeleton */}
        {loading && (
          <div className="rounded-lg border border-ink-100 bg-white p-6 shadow-card space-y-3">
            {Array.from({ length: 7 }, (_, i) => (
              <div key={i} className="h-14 rounded-md bg-ink-50 animate-pulse" />
            ))}
          </div>
        )}

        {/* Plan */}
        {plan && (
          <>
            {/* Summary cards */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <SummaryCard label="Week" value={plan.week} />
              <SummaryCard label="Sessions" value={`${trainingDays} days`} />
              <SummaryCard label="Total volume" value={`${Math.round(totalMin / 60 * 10) / 10}h`} />
              <div className="rounded-lg border border-ink-100 bg-white px-4 py-3 shadow-card">
                <p className="text-[11px] font-medium uppercase tracking-wider text-ink-400">
                  Recovery
                </p>
                <p className="mt-1">
                  <span
                    className={`inline-block text-[12px] font-medium px-2 py-0.5 rounded-full border ${
                      RECOVERY_BADGE[plan.recovery_status]?.cls ?? "bg-ink-50 text-ink-600 border-ink-200"
                    }`}
                  >
                    {RECOVERY_BADGE[plan.recovery_status]?.label ?? plan.recovery_status}
                  </span>
                </p>
              </div>
            </div>

            {/* Day-by-day plan */}
            <div className="rounded-lg border border-ink-100 bg-white shadow-card overflow-hidden">
              <div className="divide-y divide-ink-100">
                {plan.days.map((day) => (
                  <div key={day.date} className="px-5 py-4">
                    <div className="flex items-start gap-4">
                      {/* Date column */}
                      <div className="w-20 shrink-0">
                        <p className="text-[13px] font-semibold text-ink-900">
                          {day.day}
                        </p>
                        <p className="text-[11px] text-ink-400">
                          {fmtDate(day.date)}
                        </p>
                      </div>

                      {/* Content */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-[12px] text-ink-400">
                            {TYPE_ICON[day.type] ?? "●"}
                          </span>
                          <span className="text-[13px] font-medium text-ink-900">
                            {day.sport}
                          </span>
                          {day.type !== "rest" && (
                            <>
                              <span
                                className={`text-[11px] font-medium px-1.5 py-0.5 rounded border ${
                                  INTENSITY_COLORS[day.intensity] ?? "bg-ink-50 text-ink-600 border-ink-200"
                                }`}
                              >
                                {INTENSITY_LABEL[day.intensity] ?? day.intensity}
                              </span>
                              {day.duration_min > 0 && (
                                <span className="text-[12px] text-ink-500 tabular-nums">
                                  {day.duration_min} min
                                </span>
                              )}
                            </>
                          )}
                        </div>
                        {day.description && (
                          <p className="mt-1 text-[12px] text-ink-600 leading-relaxed">
                            {day.description}
                          </p>
                        )}
                        {day.zones && day.type !== "rest" && (
                          <p className="mt-0.5 text-[11px] text-ink-400">
                            Zones: {day.zones}
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Weekly notes */}
            {plan.weekly_notes && (
              <div className="rounded-lg border border-ink-100 bg-white px-5 py-4 shadow-card">
                <p className="text-[11px] font-medium uppercase tracking-wider text-ink-400 mb-1">
                  Weekly notes
                </p>
                <p className="text-[13px] text-ink-700 leading-relaxed whitespace-pre-line">
                  {plan.weekly_notes}
                </p>
              </div>
            )}
          </>
        )}
      </main>
    </>
  );
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-ink-100 bg-white px-4 py-3 shadow-card">
      <p className="text-[11px] font-medium uppercase tracking-wider text-ink-400">
        {label}
      </p>
      <p className="mt-1 text-[20px] font-semibold text-ink-900 tabular-nums leading-tight">
        {value}
      </p>
    </div>
  );
}

function Spinner() {
  return (
    <svg
      className="animate-spin h-3.5 w-3.5"
      viewBox="0 0 24 24"
      fill="none"
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
  );
}

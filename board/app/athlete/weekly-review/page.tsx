"use client";

import { useState } from "react";
import { TopBar } from "@/components/topbar";

// ── Types ────────────────────────────────────────────────────────────────────

interface TrainingBlock {
  sessions_done: number;
  total_volume_min: number;
  total_distance_km: number;
  sports_breakdown: Record<string, number>;
  vs_plan: string;
  highlights: string[];
}

interface SleepBlock {
  avg_duration_h: number;
  avg_deep_h: number;
  avg_rem_h: number;
  quality_trend: string;
  notes: string;
}

interface RecoveryBlock {
  avg_hrv: number;
  avg_resting_hr: number;
  fatigue_level: string;
  notes: string;
}

interface NutritionBlock {
  days_logged: number;
  avg_calories: number;
  notes: string;
}

interface WeeklyReview {
  week: string;
  generated_at: string;
  overall_score: number;
  summary: string;
  training: TrainingBlock;
  sleep: SleepBlock;
  recovery: RecoveryBlock;
  nutrition: NutritionBlock;
  recommendations: string[];
  next_week_focus: string;
  avg_form_score: number | null;
  form_trend: string | null;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function scoreColor(score: number): string {
  if (score >= 75) return "text-emerald-600";
  if (score >= 50) return "text-amber-600";
  return "text-red-600";
}

function scoreRing(score: number): string {
  if (score >= 75) return "border-emerald-300 bg-emerald-50";
  if (score >= 50) return "border-amber-300 bg-amber-50";
  return "border-red-300 bg-red-50";
}

const FATIGUE_BADGE: Record<string, string> = {
  faible: "bg-emerald-50 text-emerald-700 border-emerald-200",
  moderee: "bg-amber-50 text-amber-700 border-amber-200",
  elevee: "bg-red-50 text-red-700 border-red-200",
};

const TREND_BADGE: Record<string, string> = {
  "en hausse": "bg-emerald-50 text-emerald-700 border-emerald-200",
  hausse: "bg-emerald-50 text-emerald-700 border-emerald-200",
  stable: "bg-ink-50 text-ink-600 border-ink-200",
  "en baisse": "bg-red-50 text-red-700 border-red-200",
  baisse: "bg-red-50 text-red-700 border-red-200",
};

function fmtH(n: number | undefined | null): string {
  if (n == null || !Number.isFinite(n)) return "--";
  return `${n.toFixed(1)}h`;
}

function fmtNum(n: number | undefined | null): string {
  if (n == null || !Number.isFinite(n)) return "--";
  return n % 1 === 0 ? String(n) : n.toFixed(1);
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function WeeklyReviewPage() {
  const [review, setReview] = useState<WeeklyReview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const generate = async () => {
    setLoading(true);
    setError(null);
    setReview(null);
    try {
      const res = await fetch("/api/athlete/weekly-review");
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Erreur inconnue");
        return;
      }
      setReview(data.review);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erreur reseau");
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <TopBar crumbs={["Cos", "Athlete", "Bilan semaine"]} />
      <main className="flex-1 overflow-y-auto p-5 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <h1 className="text-[15px] font-semibold text-ink-900">
            Bilan de la semaine
          </h1>
          <button
            onClick={generate}
            disabled={loading}
            className="px-4 py-1.5 rounded-md bg-ink-900 text-white text-[13px] font-medium hover:bg-ink-800 disabled:opacity-50 transition flex items-center gap-2"
          >
            {loading && <Spinner />}
            {loading ? "Analyse en cours..." : "Generer le bilan de la semaine"}
          </button>
        </div>

        {/* Error */}
        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3">
            <p className="text-[13px] text-red-700">{error}</p>
          </div>
        )}

        {/* Empty */}
        {!review && !loading && !error && (
          <div className="rounded-lg border border-ink-100 bg-white p-8 text-center shadow-card">
            <p className="text-[13px] text-ink-500">
              Cliquez sur &quot;Generer le bilan de la semaine&quot; pour obtenir
              une analyse complete basee sur vos donnees de sante et nutrition.
            </p>
          </div>
        )}

        {/* Loading */}
        {loading && (
          <div className="rounded-lg border border-ink-100 bg-white p-6 shadow-card space-y-3">
            {Array.from({ length: 5 }, (_, i) => (
              <div key={i} className="h-16 rounded-md bg-ink-50 animate-pulse" />
            ))}
          </div>
        )}

        {/* Review */}
        {review && (
          <>
            {/* Score + Summary */}
            <div className="flex gap-4 items-start">
              <div
                className={`w-24 h-24 shrink-0 rounded-2xl border-2 flex flex-col items-center justify-center ${scoreRing(review.overall_score)}`}
              >
                <span className={`text-[32px] font-bold leading-none tabular-nums ${scoreColor(review.overall_score)}`}>
                  {review.overall_score}
                </span>
                <span className="text-[10px] font-medium text-ink-400 mt-0.5">/ 100</span>
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-[11px] font-medium uppercase tracking-wider text-ink-400">
                  {review.week}
                </p>
                <p className="mt-1 text-[14px] text-ink-800 leading-relaxed">
                  {review.summary}
                </p>
              </div>
            </div>

            {/* Grid: Training + Sleep */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {/* Training */}
              <Section title="Entrainement">
                <div className="grid grid-cols-3 gap-3 mb-3">
                  <MiniCard label="Seances" value={String(review.training.sessions_done)} />
                  <MiniCard
                    label="Volume"
                    value={`${Math.round(review.training.total_volume_min / 60 * 10) / 10}h`}
                  />
                  <MiniCard
                    label="Distance"
                    value={`${fmtNum(review.training.total_distance_km)} km`}
                  />
                </div>
                {Object.keys(review.training.sports_breakdown).length > 0 && (
                  <div className="mb-3">
                    <p className="text-[11px] font-medium text-ink-400 mb-1">Repartition</p>
                    <div className="flex flex-wrap gap-2">
                      {Object.entries(review.training.sports_breakdown).map(([sport, min]) => (
                        <span
                          key={sport}
                          className="text-[12px] px-2 py-0.5 rounded-full bg-ink-50 text-ink-700 border border-ink-100"
                        >
                          {sport}: {min} min
                        </span>
                      ))}
                    </div>
                  </div>
                )}
                <p className="text-[12px] text-ink-600">{review.training.vs_plan}</p>
                {review.training.highlights.length > 0 && (
                  <ul className="mt-2 space-y-0.5">
                    {review.training.highlights.map((h, i) => (
                      <li key={i} className="text-[12px] text-ink-600 flex gap-1.5">
                        <span className="text-emerald-500 shrink-0">+</span> {h}
                      </li>
                    ))}
                  </ul>
                )}
              </Section>

              {/* Sleep */}
              <Section title="Sommeil">
                <div className="grid grid-cols-3 gap-3 mb-3">
                  <MiniCard label="Duree moy." value={fmtH(review.sleep.avg_duration_h)} />
                  <MiniCard label="Profond" value={fmtH(review.sleep.avg_deep_h)} />
                  <MiniCard label="REM" value={fmtH(review.sleep.avg_rem_h)} />
                </div>
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-[11px] font-medium text-ink-400">Tendance :</span>
                  <Badge
                    label={review.sleep.quality_trend}
                    cls={TREND_BADGE[review.sleep.quality_trend] ?? "bg-ink-50 text-ink-600 border-ink-200"}
                  />
                </div>
                {review.sleep.notes && (
                  <p className="text-[12px] text-ink-600">{review.sleep.notes}</p>
                )}
              </Section>
            </div>

            {/* Grid: Recovery + Nutrition */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {/* Recovery */}
              <Section title="Recuperation">
                <div className="grid grid-cols-2 gap-3 mb-3">
                  <MiniCard label="HRV moy." value={`${fmtNum(review.recovery.avg_hrv)} ms`} />
                  <MiniCard label="FC repos" value={`${fmtNum(review.recovery.avg_resting_hr)} bpm`} />
                </div>
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-[11px] font-medium text-ink-400">Fatigue :</span>
                  <Badge
                    label={review.recovery.fatigue_level}
                    cls={FATIGUE_BADGE[review.recovery.fatigue_level] ?? "bg-ink-50 text-ink-600 border-ink-200"}
                  />
                </div>
                {review.recovery.notes && (
                  <p className="text-[12px] text-ink-600">{review.recovery.notes}</p>
                )}
              </Section>

              {/* Nutrition */}
              <Section title="Nutrition">
                <div className="grid grid-cols-2 gap-3 mb-3">
                  <MiniCard label="Jours logues" value={String(review.nutrition.days_logged)} />
                  <MiniCard label="Kcal moy." value={fmtNum(review.nutrition.avg_calories)} />
                </div>
                {review.nutrition.notes && (
                  <p className="text-[12px] text-ink-600">{review.nutrition.notes}</p>
                )}
              </Section>
            </div>

            {/* Form Score */}
            {review.avg_form_score != null && (
              <Section title="Score de forme moyen">
                <div className="flex items-center gap-4">
                  <div
                    className={`w-16 h-16 shrink-0 rounded-2xl border-2 flex flex-col items-center justify-center ${scoreRing(review.avg_form_score)}`}
                  >
                    <span className={`text-[24px] font-bold leading-none tabular-nums ${scoreColor(review.avg_form_score)}`}>
                      {review.avg_form_score}
                    </span>
                    <span className="text-[9px] font-medium text-ink-400 mt-0.5">/ 100</span>
                  </div>
                  <div>
                    <p className="text-[12px] text-ink-600 mb-1">
                      Score de forme moyen sur la semaine
                    </p>
                    {review.form_trend && (
                      <div className="flex items-center gap-2">
                        <span className="text-[11px] font-medium text-ink-400">Tendance :</span>
                        <Badge
                          label={review.form_trend}
                          cls={TREND_BADGE[review.form_trend] ?? "bg-ink-50 text-ink-600 border-ink-200"}
                        />
                      </div>
                    )}
                  </div>
                </div>
              </Section>
            )}

            {/* Recommendations */}
            {review.recommendations.length > 0 && (
              <Section title="Recommandations">
                <ul className="space-y-1.5">
                  {review.recommendations.map((r, i) => (
                    <li key={i} className="flex gap-2 text-[13px] text-ink-700">
                      <span className="shrink-0 w-5 h-5 rounded-full bg-violet-50 text-violet-600 text-[11px] font-semibold flex items-center justify-center border border-violet-200">
                        {i + 1}
                      </span>
                      <span className="pt-0.5">{r}</span>
                    </li>
                  ))}
                </ul>
              </Section>
            )}

            {/* Next week focus */}
            {review.next_week_focus && (
              <div className="rounded-lg border border-violet-200 bg-violet-50 px-5 py-4">
                <p className="text-[11px] font-medium uppercase tracking-wider text-violet-500 mb-1">
                  Focus semaine prochaine
                </p>
                <p className="text-[13px] text-violet-800 leading-relaxed">
                  {review.next_week_focus}
                </p>
              </div>
            )}
          </>
        )}
      </main>
    </>
  );
}

// ── Components ───────────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-ink-100 bg-white px-5 py-4 shadow-card">
      <p className="text-[11px] font-medium uppercase tracking-wider text-ink-400 mb-3">
        {title}
      </p>
      {children}
    </div>
  );
}

function MiniCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-ink-100 bg-ink-50/50 px-3 py-2">
      <p className="text-[10px] font-medium uppercase tracking-wider text-ink-400">{label}</p>
      <p className="text-[16px] font-semibold text-ink-900 tabular-nums leading-tight mt-0.5">
        {value}
      </p>
    </div>
  );
}

function Badge({ label, cls }: { label: string; cls: string }) {
  return (
    <span className={`text-[11px] font-medium px-2 py-0.5 rounded-full border ${cls}`}>
      {label}
    </span>
  );
}

function Spinner() {
  return (
    <svg className="animate-spin h-3.5 w-3.5" viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}

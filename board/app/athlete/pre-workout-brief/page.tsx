"use client";

import { useState } from "react";
import { TopBar } from "@/components/topbar";

interface RecommendedSession {
  sport: string;
  duration_min: number;
  intensity: string;
  description: string;
}

interface Brief {
  readiness: string;
  form_score: number;
  recommended_session: RecommendedSession;
  warnings: string[];
  green_lights: string[];
  one_liner: string;
}

const READINESS_STYLE: Record<string, { bg: string; border: string; text: string; badge: string }> = {
  pret: {
    bg: "bg-emerald-50",
    border: "border-emerald-200",
    text: "text-emerald-800",
    badge: "bg-emerald-100 text-emerald-700 border-emerald-300",
  },
  prudent: {
    bg: "bg-amber-50",
    border: "border-amber-200",
    text: "text-amber-800",
    badge: "bg-amber-100 text-amber-700 border-amber-300",
  },
  "repos recommande": {
    bg: "bg-red-50",
    border: "border-red-200",
    text: "text-red-800",
    badge: "bg-red-100 text-red-700 border-red-300",
  },
};

function scoreColor(s: number): string {
  if (s >= 75) return "text-emerald-600";
  if (s >= 50) return "text-amber-600";
  return "text-red-600";
}

function scoreRing(s: number): string {
  if (s >= 75) return "border-emerald-300 bg-emerald-50";
  if (s >= 50) return "border-amber-300 bg-amber-50";
  return "border-red-300 bg-red-50";
}

const INTENSITY_BADGE: Record<string, string> = {
  legere: "bg-emerald-50 text-emerald-700 border-emerald-200",
  moderee: "bg-amber-50 text-amber-700 border-amber-200",
  intense: "bg-red-50 text-red-700 border-red-200",
};

export default function PreWorkoutBriefPage() {
  const [brief, setBrief] = useState<Brief | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const generate = async () => {
    setLoading(true);
    setError(null);
    setBrief(null);
    try {
      const res = await fetch("/api/athlete/pre-workout-brief");
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Erreur inconnue");
        return;
      }
      setBrief(data.brief);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erreur reseau");
    } finally {
      setLoading(false);
    }
  };

  const style = brief ? (READINESS_STYLE[brief.readiness] ?? READINESS_STYLE.prudent) : null;

  return (
    <>
      <TopBar crumbs={["Cos", "Athlete", "Brief pre-entrainement"]} />
      <main className="flex-1 overflow-y-auto p-5 space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-[15px] font-semibold text-ink-900">
            Brief pre-entrainement
          </h1>
          <button
            onClick={generate}
            disabled={loading}
            className="px-4 py-1.5 rounded-md bg-ink-900 text-white text-[13px] font-medium hover:bg-ink-800 disabled:opacity-50 transition flex items-center gap-2"
          >
            {loading && <Spinner />}
            {loading ? "Analyse en cours..." : "Analyser ma forme maintenant"}
          </button>
        </div>

        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3">
            <p className="text-[13px] text-red-700">{error}</p>
          </div>
        )}

        {!brief && !loading && !error && (
          <div className="rounded-lg border border-ink-100 bg-white p-8 text-center shadow-card">
            <p className="text-[13px] text-ink-500">
              Cliquez sur &quot;Analyser ma forme maintenant&quot; pour obtenir
              un brief personnalise avant votre seance.
            </p>
          </div>
        )}

        {loading && (
          <div className="rounded-lg border border-ink-100 bg-white p-6 shadow-card space-y-3">
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="h-14 rounded-md bg-ink-50 animate-pulse" />
            ))}
          </div>
        )}

        {brief && style && (
          <>
            {/* Readiness banner + score */}
            <div className={`rounded-lg border ${style.border} ${style.bg} px-5 py-4`}>
              <div className="flex gap-4 items-center">
                <div
                  className={`w-16 h-16 shrink-0 rounded-2xl border-2 flex flex-col items-center justify-center ${scoreRing(brief.form_score)}`}
                >
                  <span className={`text-[24px] font-bold leading-none tabular-nums ${scoreColor(brief.form_score)}`}>
                    {brief.form_score}
                  </span>
                  <span className="text-[9px] font-medium text-ink-400 mt-0.5">/ 100</span>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className={`text-[12px] font-semibold px-2.5 py-0.5 rounded-full border ${style.badge}`}>
                      {brief.readiness}
                    </span>
                  </div>
                  <p className={`text-[14px] font-medium ${style.text} leading-relaxed`}>
                    {brief.one_liner}
                  </p>
                </div>
              </div>
            </div>

            {/* Recommended session */}
            <div className="rounded-lg border border-ink-100 bg-white px-5 py-4 shadow-card">
              <p className="text-[11px] font-medium uppercase tracking-wider text-ink-400 mb-3">
                Seance recommandee
              </p>
              <div className="flex items-center gap-3 mb-2">
                <span className="text-[14px] font-semibold text-ink-900">
                  {brief.recommended_session.sport}
                </span>
                <span className={`text-[11px] font-medium px-2 py-0.5 rounded-full border ${INTENSITY_BADGE[brief.recommended_session.intensity] ?? "bg-ink-50 text-ink-600 border-ink-200"}`}>
                  {brief.recommended_session.intensity}
                </span>
                <span className="text-[12px] text-ink-500 tabular-nums">
                  {brief.recommended_session.duration_min} min
                </span>
              </div>
              <p className="text-[12px] text-ink-600 leading-relaxed">
                {brief.recommended_session.description}
              </p>
            </div>

            {/* Warnings + Green lights */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {brief.warnings.length > 0 && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-5 py-4">
                  <p className="text-[11px] font-medium uppercase tracking-wider text-amber-500 mb-2">
                    Points de vigilance
                  </p>
                  <ul className="space-y-1">
                    {brief.warnings.map((w, i) => (
                      <li key={i} className="text-[12px] text-amber-800 flex gap-1.5">
                        <span className="shrink-0">!</span> {w}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {brief.green_lights.length > 0 && (
                <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-5 py-4">
                  <p className="text-[11px] font-medium uppercase tracking-wider text-emerald-500 mb-2">
                    Feux verts
                  </p>
                  <ul className="space-y-1">
                    {brief.green_lights.map((g, i) => (
                      <li key={i} className="text-[12px] text-emerald-800 flex gap-1.5">
                        <span className="shrink-0 text-emerald-500">+</span> {g}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </>
        )}
      </main>
    </>
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

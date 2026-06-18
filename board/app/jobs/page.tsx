"use client";

import { useEffect, useState, useCallback } from "react";
import { TopBar } from "@/components/topbar";

// ── Types ────────────────────────────────────────────────────────────────────

interface MatchAnalysis {
  match_score: number;
  strengths: string[];
  gaps: string[];
  recommendation: string;
  cover_letter_hook: string;
}

interface JobEntry {
  id: string;
  ts: string;
  title: string;
  company: string;
  location: string;
  url: string;
  description: string;
  source: "indeed" | "adzuna";
  match_score: number | null;
  match_analysis: MatchAnalysis | null;
  status: "new" | "reviewed" | "applied" | "rejected";
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("fr-FR", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function scoreBadgeColor(score: number | null): string {
  if (score === null) return "bg-ink-100 text-ink-500";
  if (score >= 75) return "bg-emerald-100 text-emerald-800";
  if (score >= 50) return "bg-amber-100 text-amber-800";
  return "bg-red-100 text-red-800";
}

function statusBadgeColor(status: string): string {
  switch (status) {
    case "new":
      return "bg-blue-100 text-blue-800";
    case "reviewed":
      return "bg-violet-100 text-violet-800";
    case "applied":
      return "bg-emerald-100 text-emerald-800";
    case "rejected":
      return "bg-red-100 text-red-800";
    default:
      return "bg-ink-100 text-ink-500";
  }
}

function recommendationLabel(rec: string): string {
  switch (rec) {
    case "postuler":
      return "Postuler";
    case "a_considerer":
      return "A considerer";
    case "passer":
      return "Passer";
    default:
      return rec;
  }
}

// ── Data fetching ────────────────────────────────────────────────────────────

async function fetchJobs(
  status?: string,
  minScore?: number
): Promise<JobEntry[]> {
  const params = new URLSearchParams();
  if (status) params.set("status", status);
  if (minScore !== undefined) params.set("min_score", String(minScore));
  const qs = params.toString();
  const res = await fetch(`/api/jobs${qs ? `?${qs}` : ""}`);
  if (!res.ok) return [];
  const data = await res.json();
  return data.entries ?? [];
}

async function updateStatus(jobId: string, status: string): Promise<boolean> {
  const res = await fetch("/api/jobs", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ job_id: jobId, status }),
  });
  return res.ok;
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function JobsPage() {
  const [jobs, setJobs] = useState<JobEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterStatus, setFilterStatus] = useState<string>("");
  const [filterMinScore, setFilterMinScore] = useState<string>("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [scraping, setScraping] = useState(false);
  const [scrapeQuery, setScrapeQuery] = useState("");
  const [scrapeLocation, setScrapeLocation] = useState("Zurich");
  const [scrapeResult, setScrapeResult] = useState<string | null>(null);
  const [analyzingId, setAnalyzingId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    const minScore =
      filterMinScore !== "" ? Number(filterMinScore) : undefined;
    const entries = await fetchJobs(
      filterStatus || undefined,
      minScore
    );
    setJobs(entries);
    setLoading(false);
  }, [filterStatus, filterMinScore]);

  useEffect(() => {
    reload();
  }, [reload]);

  const handleScrape = async () => {
    if (!scrapeQuery.trim()) return;
    setScraping(true);
    setScrapeResult(null);
    try {
      const res = await fetch("/api/jobs/scrape", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: scrapeQuery,
          location: scrapeLocation,
          limit: 20,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        setScrapeResult(
          `Exa: ${data.exa} resultats\n` +
          `Nouvelles offres ajoutees: ${data.added}\n` +
          `Total en base: ${data.total}`
        );
      } else {
        const data = await res.json().catch(() => ({}));
        setScrapeResult(`Erreur: ${data.error || `HTTP ${res.status}`}`);
      }
    } catch (e) {
      setScrapeResult(`Erreur: ${e instanceof Error ? e.message : "unknown"}`);
    }
    setScraping(false);
    reload();
  };

  const handleAnalyze = async (jobId: string) => {
    setAnalyzingId(jobId);
    try {
      const res = await fetch("/api/jobs/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ job_id: jobId }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        console.error("[jobs] analyze error:", data.error);
      }
      await reload();
    } catch {
      // silent — reload will show current state
    }
    setAnalyzingId(null);
  };

  const handleStatusChange = async (jobId: string, newStatus: string) => {
    await updateStatus(jobId, newStatus);
    reload();
  };

  return (
    <>
      <TopBar crumbs={["Jobs"]} />
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-5xl mx-auto px-5 py-6 space-y-6">
          {/* ── Search bar ──────────────────────────────────────────── */}
          <section className="rounded-xl border border-ink-100 bg-white p-4 space-y-3">
            <h2 className="text-sm font-semibold text-ink-900">
              Rechercher des offres
            </h2>
            <div className="flex flex-wrap gap-3">
              <input
                type="text"
                placeholder="Ex: software engineer, data scientist..."
                value={scrapeQuery}
                onChange={(e) => setScrapeQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleScrape()}
                className="flex-1 min-w-[200px] rounded-lg border border-ink-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500/30 focus:border-violet-500"
              />
              <input
                type="text"
                placeholder="Location..."
                value={scrapeLocation}
                onChange={(e) => setScrapeLocation(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleScrape()}
                className="w-40 rounded-lg border border-ink-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500/30 focus:border-violet-500"
              />
              <button
                onClick={handleScrape}
                disabled={scraping || !scrapeQuery.trim()}
                className="rounded-lg bg-ink-900 text-white px-4 py-2 text-sm font-medium hover:bg-ink-800 disabled:opacity-50 disabled:cursor-not-allowed transition"
              >
                {scraping ? "Scraping..." : "Scraper les offres"}
              </button>
            </div>
            {scrapeResult && (
              <pre className="text-xs text-ink-600 bg-ink-50 rounded-lg p-3 whitespace-pre-wrap">
                {scrapeResult}
              </pre>
            )}
          </section>

          {/* ── Filters ─────────────────────────────────────────────── */}
          <div className="flex flex-wrap items-center gap-3">
            <label className="text-xs font-medium text-ink-500 uppercase tracking-wider">
              Filtres
            </label>
            <select
              value={filterStatus}
              onChange={(e) => setFilterStatus(e.target.value)}
              className="rounded-lg border border-ink-200 px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-violet-500/30"
            >
              <option value="">Tous les statuts</option>
              <option value="new">Nouveau</option>
              <option value="reviewed">Analyse</option>
              <option value="applied">Postule</option>
              <option value="rejected">Rejete</option>
            </select>
            <input
              type="number"
              placeholder="Score min"
              min={0}
              max={100}
              value={filterMinScore}
              onChange={(e) => setFilterMinScore(e.target.value)}
              className="w-28 rounded-lg border border-ink-200 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500/30"
            />
            <span className="text-xs text-ink-400">
              {jobs.length} offre{jobs.length !== 1 ? "s" : ""}
            </span>
          </div>

          {/* ── Job list ────────────────────────────────────────────── */}
          {loading ? (
            <div className="text-center py-12 text-ink-400 text-sm">
              Chargement...
            </div>
          ) : jobs.length === 0 ? (
            <div className="text-center py-12 text-ink-400 text-sm">
              Aucune offre. Lancez une recherche pour commencer.
            </div>
          ) : (
            <div className="space-y-2">
              {jobs.map((job) => (
                <JobCard
                  key={job.id}
                  job={job}
                  expanded={expandedId === job.id}
                  onToggle={() =>
                    setExpandedId(expandedId === job.id ? null : job.id)
                  }
                  onAnalyze={() => handleAnalyze(job.id)}
                  analyzing={analyzingId === job.id}
                  onStatusChange={(s) => handleStatusChange(job.id, s)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

// ── Job Card ─────────────────────────────────────────────────────────────────

function JobCard({
  job,
  expanded,
  onToggle,
  onAnalyze,
  analyzing,
  onStatusChange,
}: {
  job: JobEntry;
  expanded: boolean;
  onToggle: () => void;
  onAnalyze: () => void;
  analyzing: boolean;
  onStatusChange: (status: string) => void;
}) {
  return (
    <div className="rounded-xl border border-ink-100 bg-white overflow-hidden">
      {/* Header row */}
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-ink-50/50 transition"
      >
        {/* Score badge */}
        <span
          className={`shrink-0 w-12 h-8 rounded-lg flex items-center justify-center text-xs font-bold ${scoreBadgeColor(job.match_score)}`}
        >
          {job.match_score !== null ? job.match_score : "—"}
        </span>

        {/* Title + company */}
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-ink-900 truncate">
            {job.title}
          </div>
          <div className="text-xs text-ink-500 truncate">
            {job.company}
            {job.location ? ` — ${job.location}` : ""}
          </div>
        </div>

        {/* Badges */}
        <span
          className={`shrink-0 px-2 py-0.5 rounded-full text-[10px] font-medium uppercase ${statusBadgeColor(job.status)}`}
        >
          {job.status}
        </span>
        <span className="shrink-0 px-2 py-0.5 rounded-full text-[10px] font-medium bg-ink-100 text-ink-600">
          {job.source}
        </span>
        <span className="shrink-0 text-[10px] text-ink-400">
          {fmtDate(job.ts)}
        </span>
      </button>

      {/* Expanded details */}
      {expanded && (
        <div className="border-t border-ink-100 px-4 py-4 space-y-4">
          {/* Description */}
          <p className="text-xs text-ink-600 leading-relaxed whitespace-pre-wrap">
            {job.description || "(pas de description)"}
          </p>

          {/* Actions */}
          <div className="flex flex-wrap items-center gap-2">
            <a
              href={job.url}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-lg bg-ink-100 px-3 py-1.5 text-xs font-medium text-ink-700 hover:bg-ink-200 transition"
            >
              Voir l&apos;offre
            </a>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onAnalyze();
              }}
              disabled={analyzing}
              className="rounded-lg bg-violet-600 text-white px-3 py-1.5 text-xs font-medium hover:bg-violet-700 disabled:opacity-50 transition"
            >
              {analyzing ? "Analyse..." : "Analyser"}
            </button>
            <select
              value={job.status}
              onChange={(e) => onStatusChange(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              className="rounded-lg border border-ink-200 px-2 py-1 text-xs bg-white focus:outline-none"
            >
              <option value="new">Nouveau</option>
              <option value="reviewed">Analyse</option>
              <option value="applied">Postule</option>
              <option value="rejected">Rejete</option>
            </select>
          </div>

          {/* Analysis results */}
          {job.match_analysis && (
            <div className="rounded-lg bg-ink-50 p-4 space-y-3">
              <div className="flex items-center gap-3">
                <span
                  className={`px-3 py-1 rounded-full text-sm font-bold ${scoreBadgeColor(job.match_score)}`}
                >
                  {job.match_score}/100
                </span>
                <span className="text-sm font-medium text-ink-700">
                  {recommendationLabel(job.match_analysis.recommendation)}
                </span>
              </div>

              {job.match_analysis.strengths?.length > 0 && (
                <div>
                  <h4 className="text-xs font-semibold text-emerald-700 mb-1">
                    Points forts
                  </h4>
                  <ul className="text-xs text-ink-600 space-y-0.5">
                    {job.match_analysis.strengths.map((s, i) => (
                      <li key={i}>+ {s}</li>
                    ))}
                  </ul>
                </div>
              )}

              {job.match_analysis.gaps?.length > 0 && (
                <div>
                  <h4 className="text-xs font-semibold text-red-700 mb-1">
                    Lacunes
                  </h4>
                  <ul className="text-xs text-ink-600 space-y-0.5">
                    {job.match_analysis.gaps.map((g, i) => (
                      <li key={i}>- {g}</li>
                    ))}
                  </ul>
                </div>
              )}

              {job.match_analysis.cover_letter_hook && (
                <div>
                  <h4 className="text-xs font-semibold text-ink-700 mb-1">
                    Accroche lettre de motivation
                  </h4>
                  <p className="text-xs text-ink-600 italic">
                    &ldquo;{job.match_analysis.cover_letter_hook}&rdquo;
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

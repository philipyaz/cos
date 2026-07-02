"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { TopBar } from "@/components/topbar";

type IngestStatus = "idle" | "extracting" | "uploading" | "pending" | "working" | "running" | "completed" | "failed" | "error";

interface ExtractedProfile {
  nom: string;
  titre: string;
  localisation: string;
  disponibilite: string;
  competences: string[];
  langues: string[];
  formations: string[];
}

export default function ProfilePage() {
  const [file, setFile] = useState<File | null>(null);
  const [profile, setProfile] = useState<ExtractedProfile | null>(null);
  const [status, setStatus] = useState<IngestStatus>("idle");
  const [jobId, setJobId] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Poll ingest_status until terminal
  const startPolling = useCallback((jid: string) => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/profile/status?job_id=${encodeURIComponent(jid)}`);
        if (!res.ok) return;
        const data = await res.json();
        const s = data.status as IngestStatus;
        setStatus(s);
        setStatusMessage(data.status_message || null);
        if (s === "completed") {
          setStatusMessage(
            typeof data.result === "string"
              ? data.result
              : data.result?.summary || "Ingestion terminee avec succes."
          );
          if (pollRef.current) clearInterval(pollRef.current);
        } else if (s === "failed" || s === "error") {
          setErrorMessage(
            typeof data.error === "string"
              ? data.error
              : data.error?.message || "Erreur lors de l'ingestion."
          );
          if (pollRef.current) clearInterval(pollRef.current);
        }
      } catch {
        // network error — keep polling
      }
    }, 3000);
  }, []);

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  // When a file is selected, auto-extract
  const handleFileSelected = async (f: File) => {
    setFile(f);
    setProfile(null);
    setStatus("extracting");
    setErrorMessage(null);
    setStatusMessage(null);
    setJobId(null);

    const formData = new FormData();
    formData.append("file", f);

    try {
      const res = await fetch("/api/profile/extract", {
        method: "POST",
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) {
        setStatus("error");
        setErrorMessage(data.error || `HTTP ${res.status}`);
        return;
      }
      setProfile(data);
      setStatus("idle");
    } catch (e) {
      setStatus("error");
      setErrorMessage(e instanceof Error ? e.message : "Extraction echouee");
    }
  };

  const handleIngest = async () => {
    if (!file && !profile) return;
    setStatus("uploading");
    setErrorMessage(null);
    setStatusMessage(null);
    setJobId(null);

    const formData = new FormData();
    if (file) formData.append("file", file);
    if (profile) formData.append("profile", JSON.stringify(profile));

    try {
      const res = await fetch("/api/profile/ingest", {
        method: "POST",
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) {
        setStatus("error");
        setErrorMessage(data.error || `HTTP ${res.status}`);
        return;
      }
      if (data.status === "saved") {
        // Profile saved locally — no async vault ingest, no polling needed
        setStatus("completed");
        setStatusMessage("Profil sauvegarde avec succes.");
      } else if (data.job_id) {
        setJobId(data.job_id);
        setStatus(data.status as IngestStatus);
        setStatusMessage("Ingestion soumise, en cours de traitement...");
        startPolling(data.job_id);
      }
    } catch (e) {
      setStatus("error");
      setErrorMessage(e instanceof Error ? e.message : "Erreur inconnue");
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const dropped = e.dataTransfer.files[0];
    if (dropped?.type === "application/pdf") handleFileSelected(dropped);
  };

  const isProcessing = status === "uploading" || status === "pending" || status === "working" || status === "running";
  const isExtracting = status === "extracting";

  return (
    <>
      <TopBar crumbs={["Profil"]} />
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto px-5 py-6 space-y-6">
          <h1 className="text-lg font-semibold text-ink-900">
            Profil candidat
          </h1>
          <p className="text-sm text-ink-500">
            Uploadez votre CV (PDF). Les informations seront extraites
            automatiquement puis ingerees dans le vault.
          </p>

          {/* ── PDF upload zone ──────────────────────────────────── */}
          <section
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
            onClick={() => !isExtracting && fileInputRef.current?.click()}
            className={`rounded-xl border-2 border-dashed p-8 text-center transition ${
              isExtracting
                ? "border-blue-300 bg-blue-50 cursor-wait"
                : dragOver
                  ? "border-violet-500 bg-violet-50 cursor-pointer"
                  : file
                    ? "border-emerald-300 bg-emerald-50 cursor-pointer"
                    : "border-ink-200 bg-ink-50 hover:border-ink-300 cursor-pointer"
            }`}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept="application/pdf"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleFileSelected(f);
              }}
            />
            {isExtracting ? (
              <div className="space-y-1">
                <p className="text-sm font-medium text-blue-800">
                  Extraction en cours...
                </p>
                <p className="text-xs text-blue-600">
                  Claude analyse votre CV
                </p>
              </div>
            ) : file ? (
              <div className="space-y-1">
                <p className="text-sm font-medium text-emerald-800">
                  {file.name}
                </p>
                <p className="text-xs text-emerald-600">
                  {(file.size / 1024).toFixed(0)} Ko — Cliquez pour changer
                </p>
              </div>
            ) : (
              <div className="space-y-1">
                <p className="text-sm font-medium text-ink-600">
                  Glissez votre CV (PDF) ici
                </p>
                <p className="text-xs text-ink-400">
                  ou cliquez pour parcourir
                </p>
              </div>
            )}
          </section>

          {/* ── Extracted profile (read-only confirmation) ────────── */}
          {profile && (
            <section className="rounded-xl border border-ink-100 bg-white p-4 space-y-4">
              <h2 className="text-sm font-semibold text-ink-900">
                Informations extraites
              </h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <ReadonlyField label="Nom" value={profile.nom} />
                <ReadonlyField label="Titre" value={profile.titre} />
                <ReadonlyField label="Localisation" value={profile.localisation} />
                <ReadonlyField label="Disponibilite" value={profile.disponibilite} />
              </div>
              {profile.competences?.length > 0 && (
                <div>
                  <span className="text-xs font-medium text-ink-500">Competences</span>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {profile.competences.map((c, i) => (
                      <span key={i} className="px-2 py-0.5 rounded-full bg-violet-100 text-violet-800 text-xs">
                        {c}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {profile.langues?.length > 0 && (
                <div>
                  <span className="text-xs font-medium text-ink-500">Langues</span>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {profile.langues.map((l, i) => (
                      <span key={i} className="px-2 py-0.5 rounded-full bg-blue-100 text-blue-800 text-xs">
                        {l}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {profile.formations?.length > 0 && (
                <div>
                  <span className="text-xs font-medium text-ink-500">Formations</span>
                  <ul className="mt-1 space-y-0.5">
                    {profile.formations.map((f, i) => (
                      <li key={i} className="text-xs text-ink-600">{f}</li>
                    ))}
                  </ul>
                </div>
              )}
            </section>
          )}

          {/* ── Submit ───────────────────────────────────────────── */}
          {profile && (
            <button
              onClick={handleIngest}
              disabled={isProcessing}
              className="w-full rounded-xl bg-ink-900 text-white py-3 text-sm font-medium hover:bg-ink-800 disabled:opacity-50 disabled:cursor-not-allowed transition"
            >
              {isProcessing ? "Ingestion en cours..." : "Confirmer et ingerer dans le vault"}
            </button>
          )}

          {/* ── Status display ───────────────────────────────────── */}
          {status !== "idle" && status !== "extracting" && (
            <section className={`rounded-xl border p-4 space-y-2 ${
              status === "completed"
                ? "border-emerald-200 bg-emerald-50"
                : status === "error" || status === "failed"
                  ? "border-red-200 bg-red-50"
                  : "border-blue-200 bg-blue-50"
            }`}>
              <div className="flex items-center gap-2">
                <StatusDot status={status} />
                <span className="text-sm font-medium text-ink-900">
                  {statusLabel(status)}
                </span>
                {jobId && (
                  <span className="text-xs text-ink-400 font-mono">
                    {jobId}
                  </span>
                )}
              </div>
              {statusMessage && (
                <p className="text-xs text-ink-600 whitespace-pre-wrap">
                  {statusMessage}
                </p>
              )}
              {errorMessage && (
                <p className="text-xs text-red-700 whitespace-pre-wrap">
                  {errorMessage}
                </p>
              )}
            </section>
          )}
        </div>
      </div>
    </>
  );
}

function ReadonlyField({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-0.5">
      <span className="text-xs font-medium text-ink-500">{label}</span>
      <p className="text-sm text-ink-900">{value || "—"}</p>
    </div>
  );
}

function StatusDot({ status }: { status: IngestStatus }) {
  const color =
    status === "completed"
      ? "bg-emerald-500"
      : status === "error" || status === "failed"
        ? "bg-red-500"
        : "bg-blue-500 animate-pulse";
  return <span className={`inline-block w-2 h-2 rounded-full ${color}`} />;
}

function statusLabel(status: IngestStatus): string {
  switch (status) {
    case "extracting": return "Extraction en cours...";
    case "uploading": return "Upload en cours...";
    case "pending": return "En attente de traitement";
    case "working": return "Ingestion en cours...";
    case "running": return "Ingestion en cours...";
    case "completed": return "Ingestion terminee";
    case "failed": return "Echec de l'ingestion";
    case "error": return "Erreur";
    default: return status;
  }
}

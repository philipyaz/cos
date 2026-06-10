// Entity-360 — the pre-call brief for a person, company, or topic. SSR. Given an
// entity name (its vault wikilink title) it assembles:
//   1. Vault facts  — GET /api/vault?title=<name> (the H1 + markdown, if any)
//   2. Related cases — every case whose vaultLinks include the entity (by wikilink)
//   3. Recent history — the latest activity across those cases (the timeline)
// 404-safe: an unknown entity with no cases and no vault page renders an honest
// "nothing on file" state rather than throwing.

import Link from "next/link";
import { headers } from "next/headers";
import { readDB } from "@/lib/store";
import { TopBar } from "@/components/topbar";
import { relativeTime, domainLabel, domainClasses, progress, caseHref } from "@/lib/format";
import { laneLabel, laneDot } from "@/lib/types";
import type { CaseRecord, CaseActivity } from "@/lib/types";
import { IconFolder, IconWarning, IconCircle, IconAgent, IconCircleUser } from "@/components/icons";

export const dynamic = "force-dynamic";

const norm = (s: string): string => s.trim().toLowerCase();

interface VaultPage {
  title: string;
  path: string;
  markdown: string;
}

// Fetch the vault page over the HTTP API (path-safe + same logic the agent uses).
// Builds an absolute URL from the incoming request host so it works under SSR.
async function fetchVaultPage(name: string): Promise<VaultPage | null> {
  try {
    const h = await headers();
    const host = h.get("x-forwarded-host") ?? h.get("host");
    if (!host) return null;
    const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
    const url = `${proto}://${host}/api/vault?title=${encodeURIComponent(name)}`;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    const data = (await res.json()) as Partial<VaultPage>;
    if (!data || typeof data.markdown !== "string") return null;
    return { title: data.title ?? name, path: data.path ?? "", markdown: data.markdown };
  } catch {
    return null;
  }
}

export default async function EntityPage({ params }: { params: Promise<{ name: string }> }) {
  const { name: raw } = await params;
  const name = decodeURIComponent(raw);
  const key = norm(name);

  const [db, vault] = await Promise.all([readDB(), fetchVaultPage(name)]);

  // Cases related to this entity: vaultLink (wikilink) match (case-insensitive).
  const related = db.cases
    .filter(
      (c) =>
        !c.archivedAt &&
        (c.vaultLinks ?? []).some((v) => norm(v) === key),
    )
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

  // Flattened recent activity across the related cases → the relationship timeline.
  const history: { caseId: string; caseTitle: string; entry: CaseActivity }[] = related
    .flatMap((c) =>
      (c.activity ?? []).map((entry) => ({ caseId: c.id, caseTitle: c.title, entry })),
    )
    .sort((a, b) => new Date(b.entry.ts).getTime() - new Date(a.entry.ts).getTime())
    .slice(0, 15);

  const openCount = related.filter((c) => c.status !== "done").length;
  const nothingOnFile = related.length === 0 && !vault;

  return (
    <>
      <TopBar crumbs={["Cos", "Entity", name]} live />
      <div className="flex-1 overflow-y-auto bg-ink-50">
        <div className="max-w-[900px] mx-auto px-6 py-6 space-y-7">
          {/* ── Header ──────────────────────────────────────────────────── */}
          <div className="flex items-start gap-3">
            <span className="grid place-items-center w-10 h-10 rounded-lg bg-violet-50 text-violet-700 ring-1 ring-violet-200 shrink-0">
              <IconCircleUser className="w-5 h-5" />
            </span>
            <div className="min-w-0">
              <h1 className="text-[18px] font-semibold text-ink-900 leading-tight truncate">{name}</h1>
              <p className="text-[12.5px] text-ink-400 mt-0.5">
                {related.length} case{related.length === 1 ? "" : "s"} ·{" "}
                {openCount} open · {vault ? "in the vault" : "no vault page"}
              </p>
            </div>
          </div>

          {nothingOnFile && (
            <div className="rounded-lg border border-ink-100 bg-white p-6 text-center">
              <IconWarning className="w-5 h-5 mx-auto text-ink-300" />
              <p className="text-[13px] text-ink-500 mt-2">Nothing on file for “{name}”.</p>
              <p className="text-[11.5px] text-ink-400 mt-1">
                No related cases and no vault page matched this name.
              </p>
            </div>
          )}

          {/* ── Vault facts ─────────────────────────────────────────────── */}
          {vault && (
            <section aria-label="Vault facts">
              <SectionHead title="Vault" icon={<IconFolder className="w-3.5 h-3.5 text-lane-progress" />} />
              <article className="mt-3 rounded-lg border border-ink-100 bg-white p-4">
                <div className="text-[11px] text-violet-700 font-mono mb-2 truncate" title={vault.path}>
                  {vault.path || vault.title}
                </div>
                <pre className="text-[12.5px] text-ink-700 leading-relaxed whitespace-pre-wrap font-sans">
                  {clampMarkdown(vault.markdown)}
                </pre>
              </article>
            </section>
          )}

          {/* ── Related cases ───────────────────────────────────────────── */}
          {related.length > 0 && (
            <section aria-label="Related cases">
              <SectionHead
                title="Related cases"
                count={related.length}
                icon={<IconCircleUser className="w-3.5 h-3.5 text-ink-400" />}
              />
              <ul className="mt-3 space-y-2">
                {related.map((c) => (
                  <li key={c.id}>
                    <Link
                      href={caseHref(c.id)}
                      className="group block bg-white rounded-lg border border-ink-100 hover:border-ink-200 hover:shadow-card transition p-3"
                    >
                      <div className="flex items-center gap-2 text-[11.5px] text-ink-500">
                        {c.status === "urgent" ? (
                          <IconWarning className="w-3.5 h-3.5 text-lane-urgent" />
                        ) : (
                          <span className={`w-1.5 h-1.5 rounded-full ${laneDot(c.status)}`} />
                        )}
                        <span className="font-medium tabular-nums">{c.id}</span>
                        <span className={`text-[10px] leading-none px-1.5 py-0.5 rounded-full font-medium ${domainClasses(c.domain)}`}>
                          {domainLabel(c.domain)}
                        </span>
                        <span className="text-ink-400">{laneLabel(c.status)}</span>
                        <span className="ml-auto tabular-nums text-ink-400">{relativeTime(c.updatedAt)}</span>
                      </div>
                      <div className="text-[13.5px] font-medium text-ink-900 leading-snug mt-1.5">{c.title}</div>
                      {c.summary && (
                        <div className="text-[12px] text-ink-500 leading-snug line-clamp-1 mt-0.5">{c.summary}</div>
                      )}
                      <RelatedMeta caseRec={c} />
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* ── History / timeline ──────────────────────────────────────── */}
          {history.length > 0 && (
            <section aria-label="Recent history">
              <SectionHead title="Recent history" icon={<IconAgent className="w-3.5 h-3.5 text-ink-400" />} />
              <ol className="mt-3 rounded-lg border border-ink-100 bg-white divide-y divide-ink-50">
                {history.map((h, i) => (
                  <li key={`${h.caseId}-${i}`} className="flex items-center gap-3 px-3.5 py-2 text-[12px]">
                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${actorDot(h.entry.actor)}`} />
                    <span className="text-ink-700 shrink-0 capitalize">{h.entry.verb.replace(/_/g, " ")}</span>
                    <Link href={caseHref(h.caseId)} className="text-ink-500 truncate hover:text-ink-900 transition flex-1">
                      {h.caseId} · {h.caseTitle}
                    </Link>
                    <span className="text-ink-400 tabular-nums shrink-0">{relativeTime(h.entry.ts)}</span>
                  </li>
                ))}
              </ol>
            </section>
          )}
        </div>
      </div>
    </>
  );
}

function RelatedMeta({ caseRec }: { caseRec: CaseRecord }) {
  const p = progress(caseRec.tasks);
  if (p.total === 0 && !caseRec.priority) return null;
  return (
    <div className="flex items-center gap-2 pt-2 text-[11px] text-ink-400">
      {caseRec.priority && (
        <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-ink-100 text-ink-600">
          {caseRec.priority}
        </span>
      )}
      {p.total > 0 && (
        <span className="flex items-center gap-1 tabular-nums">
          <IconCircle className="w-3.5 h-3.5 text-ink-300" />
          {p.done}/{p.total}
        </span>
      )}
    </div>
  );
}

function SectionHead({
  title,
  count,
  icon,
}: {
  title: string;
  count?: number;
  icon?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2">
      {icon}
      <h2 className="text-[13px] font-semibold text-ink-900">{title}</h2>
      {count !== undefined && <span className="text-[11px] text-ink-400 tabular-nums">{count}</span>}
    </div>
  );
}

function actorDot(actor: CaseActivity["actor"]): string {
  if (actor === "agent") return "bg-lane-progress";
  if (actor === "system") return "bg-ink-300";
  return "bg-lane-done";
}

// Keep the vault excerpt readable in the brief — show the first chunk; the full
// page lives in the vault. (Roughly the lead section.)
function clampMarkdown(md: string): string {
  const MAX = 1600;
  if (md.length <= MAX) return md;
  return md.slice(0, MAX).replace(/\s+\S*$/, "") + "\n\n…";
}

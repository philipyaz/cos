import { TopBar } from "@/components/topbar";
import { fetchGuardConfig, fetchQuarantineList, fetchTrustList } from "@/lib/guard";
import { GuardControl } from "@/components/security/guard-control";
import { QuarantineView } from "@/components/security/quarantine-view";
import { WhitelistView } from "@/components/security/whitelist-view";
import { IconShield, IconWarning } from "@/components/icons";

// The Security surface — the single home for the prompt-injection GUARD. A server
// component (like the other pages) that SSR-seeds the interactive client views, then
// leaves them to refetch imperatively. It is a stack of three titled sections, in this
// order: (1) the GUARD master toggle (the ON/OFF control + deps gate + model catalog),
// (2) the QUARANTINE review queue, and (3) the sender-trust WHITELIST (moved here from
// the retired /settings page).
//
// dynamic="force-dynamic": every artefact here lives in the guard SIDECAR (:8009), not
// in cases.json, so this page must never be statically cached — each load reflects the
// live store (or the offline banner when the sidecar is down). The three SSR seeds use
// the SAME helpers the GET routes use (lib/guard.ts), so the seed and the client's
// later refetches read one source. lib/guard.ts is server-only; the client views never
// import it (they refetch through the board's /api proxy routes).
export const dynamic = "force-dynamic";

export default async function SecurityPage() {
  // ALL three seeds are render-ready and never throw — on a reachable sidecar each is
  // online:true with the real data; on any trouble online:false + empty data + a reason
  // (each view then shows its offline banner). Fetched in parallel — they hit independent
  // sidecar endpoints with no ordering need.
  const [config, quarantine, trust] = await Promise.all([
    fetchGuardConfig(),
    fetchQuarantineList(),
    fetchTrustList(),
  ]);

  const now = new Date().toISOString(); // ONE request-time clock, serialized for the client

  return (
    <>
      <TopBar crumbs={["Cos", "Security"]} />
      <div className="flex-1 overflow-y-auto bg-ink-50">
        <div className="max-w-[860px] mx-auto px-5 py-6 space-y-6">
          {/* (1) GUARD — the master ON/OFF control. */}
          <SecuritySection
            icon={<IconShield className="w-4 h-4 text-ink-500" />}
            title="Guard"
            blurb={
              <>
                The prompt-injection guard is a <span className="font-medium text-ink-700">security control</span> you
                turn on or off. When <span className="font-medium text-emerald-700">on</span>, every inbound email is
                scanned for prompt-injection before triage reads it; when{" "}
                <span className="font-medium text-amber-700">off</span> (the default), email is admitted{" "}
                <strong className="font-medium text-ink-700">without</strong> scanning — your choice. Turning it on
                requires the active model&rsquo;s dependencies; copy the setup command into Claude Code if they&rsquo;re
                missing.
              </>
            }
          >
            <GuardControl initial={config} />
          </SecuritySection>

          {/* (2) QUARANTINED MESSAGES — the review queue. */}
          <SecuritySection
            icon={<IconWarning className="w-4 h-4 text-ink-500" />}
            title="Quarantined messages"
            blurb={
              <>
                Every flagged scan is saved here for review.{" "}
                <span className="font-medium text-emerald-700">Releasing</span> a message marks it a{" "}
                <strong className="font-medium text-ink-700">false positive</strong> (the content was actually
                safe); <span className="font-medium text-ink-700">dismissing</span> acknowledges and sets it
                aside. Nothing is auto-deleted — review is explicit.
              </>
            }
          >
            <QuarantineView initial={quarantine} now={now} />
          </SecuritySection>

          {/* (3) SENDER WHITELIST — moved here from the retired Settings page. */}
          <SecuritySection
            icon={<IconShield className="w-4 h-4 text-ink-500" />}
            title="Sender trust whitelist"
            blurb={
              <>
                The whitelist is a <strong className="font-medium text-ink-700">second axis</strong> to
                the guard&rsquo;s content scan — it tunes how a known sender is treated, it is{" "}
                <strong className="font-medium text-ink-700">never a bypass</strong>: the guard still scans
                every message regardless of tier. Senders earn{" "}
                <span className="font-medium text-ink-700">trusted</span> on first reply (you replied to
                them), or you can add, block, or remove them here.
              </>
            }
          >
            <WhitelistView initial={trust} now={now} />
          </SecuritySection>
        </div>
      </div>
    </>
  );
}

// One titled security card: an icon + title + short explanatory blurb in a header,
// then the section's content. Co-located here because it's only used to structure
// this shell (the same idiom the old Settings page used for SettingsSection).
function SecuritySection({
  icon,
  title,
  blurb,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  blurb: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-md border border-ink-100 bg-white shadow-card overflow-hidden">
      <div className="px-5 py-4 border-b border-ink-100">
        <div className="flex items-center gap-2">
          {icon}
          <h2 className="text-[13px] font-semibold text-ink-900">{title}</h2>
        </div>
        <p className="mt-1.5 text-[12px] leading-relaxed text-ink-500 max-w-[640px]">{blurb}</p>
      </div>
      <div className="px-5 py-4">{children}</div>
    </section>
  );
}

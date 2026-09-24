import { useRef, useState } from "react";
import {
  fetchUnreadCount,
  fetchEnabledAddonGroups,
  fetchPendingCount,
  type AddonNavGroup,
} from "./board-client";
import { useLiveBoard } from "./use-live-board";

// Shared live-reconciliation for the nav surfaces (Sidebar, MobileNav): seed from
// SSR, then compose useLiveBoard's subscribe/guard/unsubscribe effect so the
// badges + add-on liveness can't drift between the two layouts. `lastVersion`
// only advances once fetchUnreadCount's OWN response confirms the version —
// unlike an eager advance-before-fetch ordering, a failed refetch leaves it
// behind and self-heals on the next SSE change event instead of silently
// committing to a version whose fetch never actually landed.
export function useNavLive(seed: {
  unreadCount?: number;
  addonGroups?: AddonNavGroup[];
  pendingCount?: number;
}): { unread: number; addons: AddonNavGroup[]; pending: number } {
  const [unread, setUnread] = useState(seed.unreadCount ?? 0);
  const [addons, setAddons] = useState<AddonNavGroup[]>(seed.addonGroups ?? []);
  const [pending, setPending] = useState(seed.pendingCount ?? 0);
  const lastVersion = useRef(0);

  useLiveBoard(lastVersion, () => {
    fetchUnreadCount()
      .then((r) => {
        lastVersion.current = r.version;
        setUnread(r.unread);
      })
      .catch(() => {});
    // fetchEnabledAddonGroups never throws — it resolves to [] on failure, and
    // this .then(setAddons) CLEARS the nav with that []. (Despite what this
    // comment used to say, a hiccup does NOT keep the last-known sections.)
    fetchEnabledAddonGroups()
      .then(setAddons)
      .catch(() => {});
    // fetchPendingCount never throws (null on failure) — a hiccup keeps the
    // last-known badge. Like the add-on arm, it never advances lastVersion
    // (fetchUnreadCount owns that).
    fetchPendingCount()
      .then((n) => {
        if (n !== null) setPending(n);
      })
      .catch(() => {});
  });

  return { unread, addons, pending };
}

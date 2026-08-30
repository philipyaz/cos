import { useRef, useState } from "react";
import { fetchUnreadCount, fetchEnabledAddonGroups, type AddonNavGroup } from "./board-client";
import { useLiveBoard } from "./use-live-board";

// Shared live-reconciliation for the nav surfaces (Sidebar, MobileNav): seed from
// SSR, then compose useLiveBoard's subscribe/guard/unsubscribe effect so badge +
// add-on liveness can't drift between the two layouts. `lastVersion` only
// advances once fetchUnreadCount's OWN response confirms the version — unlike an
// eager advance-before-fetch ordering, a failed refetch leaves it behind and
// self-heals on the next SSE change event instead of silently committing to a
// version whose fetch never actually landed.
export function useNavLive(seed: {
  unreadCount?: number;
  addonGroups?: AddonNavGroup[];
}): { unread: number; addons: AddonNavGroup[] } {
  const [unread, setUnread] = useState(seed.unreadCount ?? 0);
  const [addons, setAddons] = useState<AddonNavGroup[]>(seed.addonGroups ?? []);
  const lastVersion = useRef(0);

  useLiveBoard(lastVersion, () => {
    fetchUnreadCount()
      .then((r) => {
        lastVersion.current = r.version;
        setUnread(r.unread);
      })
      .catch(() => {});
    // fetchEnabledAddonGroups never throws (it resolves to [] on failure), so a
    // hiccup simply leaves the last-known sections in place until the next change.
    fetchEnabledAddonGroups()
      .then(setAddons)
      .catch(() => {});
  });

  return { unread, addons };
}

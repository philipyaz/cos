// The single owner of every "one browser-history entry per open full-screen view" concern on the
// board (cos-ops#107) — React-free (zero imports, no top-level `window` access) so `node --test`
// loads it directly with no ts-resolve hook, and so it imports cleanly during SSR (client
// components render server-side too; every `window`/`history` touch happens inside an adapter
// method BODY, never at module load).
//
// Same mechanism as board/lib/board-client.ts:1076-1230's shared SSE stream, renamed for history
// instead of an EventSource — cite this file rather than re-deriving it the next time a THIRD
// module-level browser singleton is needed. One module-level browser binding, opened lazily on
// the first subscriber (here: the first ever open()); a deferred teardown that re-checks on flush
// because Strict Mode double-invokes every effect as mount -> unmount -> mount, so "a pending
// close is cancelled if anyone resubscribes first"; an idempotent release (React can invoke a
// cleanup more than once). `pendingPop` + adoption + `detached`-is-a-no-op is that same
// vocabulary — deferred-close / cancel-on-resubscribe / idempotent-teardown — applied to browser
// history instead of an EventSource.
//
// Decision candidate: a module-level singleton in board/lib that binds a browser API defers its
// teardown and re-adopts on a same-tick re-subscribe rather than tearing down synchronously —
// board-client's shared stream and this file are the two instances; a third should reuse this
// vocabulary rather than re-derive it.
//
// Why the browser adapter reads `window.history`/`window.location` INSIDE each method, at call
// time, and never captures a reference at module load: Next's AppRouter installs a patched
// `pushState`/`replaceState` inside a `useEffect` and restores the originals on unmount
// (app-router.js:233-279) — a module-load-time reference would call the UNPATCHED native method,
// and `onPopState` reloads the WHOLE PAGE on a pop that lands on an entry without Next's own
// `__NA` marker (app-router.js:284-298). The patched `pushState` MERGES `__NA` + Next's route tree
// INTO whatever state object we pass (`copyNextJsInternalHistoryState`), so our own
// `__cosOverlay` key survives on the entry and a pop onto it traverses instead of reloading.
//
// Why the push carries no URL argument: passing one makes the patch dispatch a router RESTORE
// action on every open (app-router.js:259-261) — this is a same-URL overlay, never a navigation.
// Why the native call is `window.history.pushState(state, "")` — two arguments, not one:
// `History.pushState` is WebIDL `(any data, DOMString unused, optional USVString? url)`; `unused`
// is REQUIRED, so a one-argument call throws `TypeError` the moment Next's patch isn't installed
// (briefly true in dev Strict Mode, between AppRouter's effect cleanup and its re-setup).
//
// `board-view.tsx:208`/`:271` call `window.history.replaceState(null, "", url)` to sync the kanban
// query string / strip a consumed deep link — both rewrite ONLY the query string and preserve
// `window.location.pathname` (verified at cos `373a461`). That call is legitimate and stays
// outside this module; its side effect is erasing `__cosOverlay` from a drawer's entry mid-open,
// which is why `popstate` below treats a marker-less (or `null`) state as landed depth 0 — close
// every live frame — rather than crash or ignore the pop. With one frame open (the common case)
// that is exactly right, and it is the only reading that never leaves Back inert.
//
// Chosen failure direction: when this module cannot be sure, it does LESS — it never issues a
// history call it wasn't asked for. Consequences accepted, all bounded by "one extra back-swipe,
// never a lost draft, never a bounced navigation": (a) a back-swipe onto an entry whose marker was
// erased (above) closes every live frame; (b) a UI-close racing an open in the sub-frame window
// between an issued `back()` and its `popstate` can briefly duplicate a depth — recovers on the
// next swipe; (c) an entry stranded by a route navigation (see `release()` below) or by a
// mid-stack close costs one no-op swipe.
//
// `createOverlayHistory`/`OverlayHistoryAdapter`/`OverlayHandle` are the injected test seam —
// their only in-tree reader is deliberately `tests/unit/overlay-history.test.ts`. Real consumers
// import only `openOverlay`.

export type OverlayHistoryAdapter = {
  /** Same-URL push — never pass a URL argument (see header: it forces a router RESTORE). */
  pushState(state: unknown): void;
  back(): void;
  getPathname(): string;
  /** Subscribe to popstate; the callback receives the NEW current entry's state. Called at most
   *  once per adapter — lazily, on the first ever open(). */
  onPop(fn: (state: unknown) => void): void;
  /** Deferral seam. Browser: `setTimeout(fn, 0)` — board-client.ts:1217's own choice, over a
   *  same-task `queueMicrotask`, because it survives a CROSS-TASK remount, not only Strict Mode's
   *  same-task one. Tests: a manual queue. */
  defer(fn: () => void): void;
};

export type OverlayHandle = { release(): void };

type FrameStatus = "live" | "pendingPop" | "detached";

type Frame = {
  // Fixed at push — 1-based position in the stack, counting detached-in-place frames (they still
  // occupy their history slot, so a later push must not reuse their number).
  readonly depth: number;
  // Recorded at open — the currency check compares this against the LIVE pathname at
  // release/adopt time, never `history.state` (board-view.tsx's replaceState erases that).
  readonly pathname: string;
  onClose: () => void;
  status: FrameStatus;
};

function isOverlayState(state: unknown): state is { __cosOverlay: number } {
  return (
    typeof state === "object" &&
    state !== null &&
    typeof (state as { __cosOverlay?: unknown }).__cosOverlay === "number"
  );
}

export function createOverlayHistory(adapter: OverlayHistoryAdapter): {
  open(onClose: () => void): OverlayHandle;
} {
  const frames: Frame[] = [];
  let subscribed = false;

  // The only path that closes a view FOR the caller (a real back/forward). Reconciles the stack
  // against the entry that just became current: every frame above it is gone, top-down — marked
  // `detached` BEFORE it leaves the array, which is what makes a pending release() below a no-op
  // instead of a double `back()`. A `live` frame closes exactly once; a `pendingPop` one (already
  // on its way out via release()) or an already-`detached` one gets nothing. Frames at or below
  // the landed depth are untouched — a stacked drawer's lower layer stays open, and a forward pop
  // onto an entry whose frame is already gone finds nothing left to close. Never calls
  // back()/pushState — a pop is something that already happened, not something to cause.
  function handlePop(state: unknown): void {
    const landedDepth = isOverlayState(state) ? state.__cosOverlay : 0;
    while (frames.length > 0 && frames[frames.length - 1].depth > landedDepth) {
      const frame = frames[frames.length - 1];
      const wasLive = frame.status === "live";
      frame.status = "detached";
      frames.pop();
      if (wasLive) frame.onClose();
    }
  }

  function releaseFrame(frame: Frame): void {
    if (frame.status === "detached") return; // a popstate already closed this — never double-back
    if (frames[frames.length - 1] === frame) {
      frame.status = "pendingPop";
      adapter.defer(() => {
        // A same-tick re-open adopted this slot (Strict Mode, or "close A, open B" in one tick),
        // or a real popstate already reconciled it away — either way, this release is moot now.
        if (frame.status !== "pendingPop") return;
        const idx = frames.indexOf(frame);
        if (idx !== -1) frames.splice(idx, 1);
        if (adapter.getPathname() === frame.pathname) {
          adapter.back();
        }
        // else: a route navigation moved the pathname before this cleanup ran (the drawer's
        // effect cleanup fires AFTER Next's own useInsertionEffect already pushed the new page's
        // entry) — the entry is left behind, stranded mid-history, inert by design (see header).
      });
    } else {
      // A middle view in a stacked pair (label-manager/unanswered-messages over a base drawer)
      // unmounted out of order — go inert IN PLACE. Popping here would remove the TOP view's own
      // entry instead of this one.
      frame.status = "detached";
    }
  }

  function open(onClose: () => void): OverlayHandle {
    if (!subscribed) {
      subscribed = true;
      adapter.onPop(handlePop);
    }

    const top = frames[frames.length - 1];
    let frame: Frame;
    if (top && top.status === "pendingPop" && top.pathname === adapter.getPathname()) {
      // Reclaim the same slot rather than push a second entry — the entry is fungible, owned by
      // whichever view currently holds it (Strict Mode's setup -> cleanup -> setup lands here).
      top.onClose = onClose;
      top.status = "live";
      frame = top;
    } else {
      const depth = frames.length + 1;
      frame = { depth, pathname: adapter.getPathname(), onClose, status: "live" };
      frames.push(frame);
      adapter.pushState({ __cosOverlay: depth });
    }

    let released = false;
    return {
      release() {
        if (released) return; // React can invoke a cleanup more than once
        released = true;
        releaseFrame(frame);
      },
    };
  }

  return { open };
}

const browserAdapter: OverlayHistoryAdapter = {
  pushState(state) {
    window.history.pushState(state, "");
  },
  back() {
    window.history.back();
  },
  getPathname() {
    return window.location.pathname;
  },
  onPop(fn) {
    window.addEventListener("popstate", (event) => fn(event.state));
  },
  defer(fn) {
    setTimeout(fn, 0);
  },
};

const appOverlayHistory = createOverlayHistory(browserAdapter);

/** The app singleton, bound to the browser adapter. Consumers import only this. */
export function openOverlay(onClose: () => void): OverlayHandle {
  return appOverlayHistory.open(onClose);
}

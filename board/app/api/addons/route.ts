import { NextResponse } from "next/server";
import { readDB } from "@/lib/store";
import { listAddons, isAddonEnabled } from "@/lib/addons";

export const dynamic = "force-dynamic";

// Best-effort liveness probe of an add-on's MCP bridge. Hits http://localhost:<port>/mcp
// with a short timeout and answers "is anything listening?" — ANY HTTP response (even an
// error status) OR a non-ECONNREFUSED failure ⇒ reachable; ECONNREFUSED / timeout ⇒ down.
// NEVER throws: a probe failure resolves to false so the catalog still renders.
async function probeBridge(port: number): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 300);
  try {
    await fetch(`http://localhost:${port}/mcp`, { signal: ctrl.signal });
    // Any HTTP response (any status) means something is listening on the bridge port.
    return true;
  } catch (e) {
    // A connection that was refused (nothing listening) or that timed out ⇒ down.
    // Any OTHER fetch failure (e.g. an HTTP-level protocol hiccup against a live
    // server) still implies something is there ⇒ reachable.
    const cause = (e as { cause?: { code?: string } })?.cause;
    const code = cause?.code;
    const name = (e as { name?: string })?.name;
    if (code === "ECONNREFUSED" || name === "AbortError" || name === "TimeoutError") {
      return false;
    }
    return true;
  } finally {
    clearTimeout(timer);
  }
}

// GET /api/addons — the add-on catalog. Returns one row per manifest with its enabled
// flag (from Settings.addons) and a best-effort bridge reachability hint. UNGATED.
export async function GET() {
  const db = await readDB();

  const addons = await Promise.all(
    listAddons().map(async (a) => ({
      id: a.id,
      title: a.title,
      description: a.description,
      icon: a.icon,
      navItems: a.navItems,
      enabled: isAddonEnabled(db, a.id),
      bridge: {
        port: a.mcp.defaultPort,
        reachable: await probeBridge(a.mcp.defaultPort),
      },
    }))
  );

  return NextResponse.json({ addons, version: db.version });
}

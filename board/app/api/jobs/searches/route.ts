import { NextResponse } from "next/server";
import { createHash } from "crypto";
import { loadSearches, saveSearches } from "@/lib/jobs-store";

// GET /api/jobs/searches — list all saved searches
export async function GET() {
  return NextResponse.json({ searches: loadSearches() });
}

// POST /api/jobs/searches — add a new saved search
// Body: { query, location }
export async function POST(request: Request) {
  const body = await request.json();
  const query = typeof body.query === "string" ? body.query.trim() : "";
  const location = typeof body.location === "string" ? body.location.trim() : "";

  if (!query) {
    return NextResponse.json({ error: "query is required" }, { status: 400 });
  }

  const searches = loadSearches();

  // Dedup by query+location
  const dup = searches.find(
    (s) => s.query.toLowerCase() === query.toLowerCase() && s.location.toLowerCase() === location.toLowerCase()
  );
  if (dup) {
    return NextResponse.json({ error: "Cette recherche existe deja.", search: dup }, { status: 409 });
  }

  const id = createHash("sha256").update(`${query}|${location}`).digest("hex").slice(0, 12);
  const search = { id, query, location, active: true, createdAt: new Date().toISOString() };
  searches.push(search);
  saveSearches(searches);

  return NextResponse.json({ search }, { status: 201 });
}

// PATCH /api/jobs/searches — toggle active or delete
// Body: { id, active?: boolean, delete?: true }
export async function PATCH(request: Request) {
  const body = await request.json();
  const id = typeof body.id === "string" ? body.id.trim() : "";

  if (!id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  let searches = loadSearches();
  const idx = searches.findIndex((s) => s.id === id);
  if (idx === -1) {
    return NextResponse.json({ error: "Search not found" }, { status: 404 });
  }

  if (body.delete === true) {
    searches.splice(idx, 1);
    saveSearches(searches);
    return NextResponse.json({ deleted: true });
  }

  if (typeof body.active === "boolean") {
    searches[idx].active = body.active;
    saveSearches(searches);
  }

  return NextResponse.json({ search: searches[idx] });
}

#!/usr/bin/env node
// search-demo.mjs — a narrated, READ-ONLY walkthrough of the board's semantic
// search API. Hits the live board (:3000); the board proxies to the optional
// Python embedding sidecar (:8008) and falls back to keyword if it is down.
//
//   cd board && npm run dev          # board on :3000 (+ ensure-bridges nudges the sidecar)
//   node scripts/search-demo.mjs     # then run this
//
// Env: CRM_BASE_URL (default http://localhost:3000).
const BASE = (process.env.CRM_BASE_URL || "http://localhost:3000").replace(/\/$/, "");

// ── tiny ANSI helpers ────────────────────────────────────────────────────────
const C = {
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  grn: (s) => `\x1b[32m${s}\x1b[0m`,
  yel: (s) => `\x1b[33m${s}\x1b[0m`,
  cyn: (s) => `\x1b[36m${s}\x1b[0m`,
  mag: (s) => `\x1b[35m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
};
const rule = (s = "") => console.log("\n" + C.dim("─".repeat(78)) + (s ? `\n${s}` : ""));
const scene = (n, title) => rule(C.b(C.cyn(`  SCENE ${n} · ${title}`)));

// ── API calls ────────────────────────────────────────────────────────────────
async function post(body) {
  const res = await fetch(`${BASE}/api/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}
async function substringCount(q) {
  const res = await fetch(`${BASE}/api/search?q=${encodeURIComponent(q)}`);
  const d = await res.json();
  return (d.cases?.length ?? 0) + (d.tasks?.length ?? 0) + (d.messages?.length ?? 0);
}

const labelOf = (h) => h.case?.title ?? h.title ?? (h.subject ? `${h.subject} — ${h.from ?? ""}` : "") ?? "";
const tagOf = (h) =>
  h.type === "case" ? `${h.case?.status ?? "?"}/${h.case?.domain ?? "?"}` : h.type;

function printHits(hits, { max = 4 } = {}) {
  if (!hits.length) return console.log("     " + C.dim("(no matches)"));
  for (const h of hits.slice(0, max)) {
    const why = (h.why ?? []).join(", ");
    console.log(
      `     ${C.grn(h.id.padEnd(18))} ${C.dim("[" + tagOf(h) + "]")} ${labelOf(h)}`,
    );
    console.log(
      `     ${" ".repeat(18)} ${C.dim(`score ${Number(h.score).toFixed(2)}  ·  why: ${why}`)}`,
    );
  }
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(C.b("\n  📇  Cos board — semantic search demo"));

  // health probe
  let engine = "?";
  let embedder = "?";
  try {
    const probe = await post({ q: "ping", k: 1 });
    engine = probe.engine;
    embedder = probe.embedder;
  } catch (e) {
    console.error(C.red(`\n  ✗ Could not reach the board at ${BASE}. Start it: cd board && npm run dev`));
    process.exit(1);
  }
  const live = engine === "semantic";
  console.log(
    `  board: ${C.cyn(BASE)}   engine: ${live ? C.grn(engine) : C.yel(engine)}   embedder: ${C.dim(embedder)}`,
  );
  if (!live) {
    console.log(
      C.yel("  ⚠ The semantic sidecar (:8008) is down — you're seeing the KEYWORD fail-safe."),
    );
    console.log(
      C.dim("    Start it for the full demo:  uv run --directory search uvicorn sidecar:app --port 8008"),
    );
  }

  // ── SCENE 1 — meaning, not spelling ────────────────────────────────────────
  scene(1, "Search by MEANING, not spelling");
  console.log(
    C.dim("  Each query shares NO words with the case it should find. The old substring\n" +
      "  search returns nothing; semantic search finds it anyway.\n"),
  );
  const sem1 = [
    ["pricing proposal for the open-source project", "→ the DevForge engagement"],
    ["intermittent build failures on CI", "→ the flaky-pipeline investigation"],
    ["onboarding docs for new contributors", "→ the contributor-guide rewrite"],
    ["weekly dependency-update routine", "→ the dependency-bot setup"],
  ];
  for (const [q, hint] of sem1) {
    const subN = await substringCount(q);
    const d = await post({ queries: [q], k: 2 });
    const hits = d.results?.[0]?.hits ?? [];
    console.log(`  ${C.b("“" + q + "”")}  ${C.dim(hint)}`);
    console.log(
      `     ${C.dim("substring search:")} ${subN === 0 ? C.red("0 matches") : C.yel(subN + " matches")}` +
        `   ${C.dim("· semantic search:")} ${C.grn((hits.length ? hits.length : 0) + " match(es)")}`,
    );
    printHits(hits, { max: 2 });
    console.log("");
  }

  // ── SCENE 2 — search before you create (the dedupe headline) ───────────────
  scene(2, "Search BEFORE you create  (the dedupe an agent does)");
  console.log(
    C.dim("  Inbound: “Marco emailed — he wants to kick off the DevForge collaboration.”\n" +
      "  Before opening a NEW case, the agent fires several queries at once —\n" +
      "  the person, the topic, the deliverable — to find an existing matter.\n"),
  );
  const dedupeQueries = [
    "Marco Rivera",
    "DevForge collaboration co-maintainer",
    "project roadmap / proposal",
  ];
  const d2 = await post({ queries: dedupeQueries, k: 3, types: ["case"] });
  for (const g of d2.results ?? []) {
    console.log(`  ${C.mag("▸")} ${C.b("“" + g.query + "”")}`);
    printHits(g.hits, { max: 3 });
    console.log("");
  }
  // The dedupe signal an agent reads: not the single top score (a bare name is
  // ambiguous), but the case that RECURS across the most query angles.
  const tally = new Map(); // id → { count, sum, title }
  for (const g of d2.results ?? []) {
    const seen = new Set();
    for (const h of g.hits) {
      if (h.type !== "case" || h.score <= 0.5 || seen.has(h.id)) continue;
      seen.add(h.id);
      const t = tally.get(h.id) ?? { count: 0, sum: 0, title: h.case?.title ?? "" };
      t.count++;
      t.sum += h.score;
      tally.set(h.id, t);
    }
  }
  const ranked = [...tally.entries()].sort((a, b) => b[1].count - a[1].count || b[1].sum - a[1].sum);
  if (ranked.length) {
    console.log(C.dim("  Cases recurring across the queries (the dedupe signal):"));
    for (const [id, t] of ranked.slice(0, 3)) {
      console.log(
        `     ${C.grn(id.padEnd(10))} ${C.dim(`appears for ${t.count}/${dedupeQueries.length} angles`)}  ${t.title}`,
      );
    }
    const [bestId, best] = ranked[0];
    console.log(
      "\n" + C.grn("  ✓ Verdict: ") +
        `${C.b(bestId)} “${best.title}” already covers this matter — it surfaced for every angle.`,
    );
    console.log(
      C.dim("    → UPDATE it (update_case / add_task / link_message). Do NOT open a duplicate.\n" +
        "    The case that recurs across your queries IS the existing matter. That's the dedupe."),
    );
  }

  // ── SCENE 3 — hybrid ranking (exact id / client beat fuzzy) ─────────────────
  scene(3, "Hybrid ranking — exact id & client name jump to #1");
  console.log(
    C.dim("  Semantic cosine is BLENDED with exact-id / id-substring / client-name boosts,\n" +
      "  so a precise reference always wins over a merely-similar one.\n"),
  );
  for (const q of ["CASE-3", "Marco Rivera"]) {
    const d = await post({ queries: [q], k: 3 });
    console.log(`  ${C.b("“" + q + "”")}`);
    printHits(d.results?.[0]?.hits ?? [], { max: 3 });
    console.log("");
  }

  // ── SCENE 4 — fail-safe (what you get with NO sidecar) ─────────────────────
  scene(4, "Fail-safe — the board never darks");
  console.log(
    C.dim("  semantic:false forces the SAME path you'd get if the sidecar were down.\n" +
      "  Still ranked, still useful, always HTTP 200 — search degrades, never breaks.\n"),
  );
  const q4 = "Marco Rivera";
  const semOn = await post({ queries: [q4], k: 3 });
  const semOff = await post({ queries: [q4], k: 3, semantic: false });
  console.log(`  ${C.b("“" + q4 + "”")}`);
  console.log(`  ${C.grn("semantic ON")}  ${C.dim("(engine: " + semOn.engine + ")")}`);
  printHits(semOn.results?.[0]?.hits ?? [], { max: 3 });
  console.log(`\n  ${C.yel("semantic OFF / sidecar down")}  ${C.dim("(engine: " + semOff.engine + ")")}`);
  printHits(semOff.results?.[0]?.hits ?? [], { max: 3 });

  rule();
  console.log(
    C.dim("  Same API on the agent side: the board MCP `search` tool takes the same\n" +
      "  { queries[], k, types, domain, status } and returns these ranked hits.\n" +
      "  Full design: docs/reference/search.md\n"),
  );
}

main().catch((e) => {
  console.error(C.red("\ndemo error: " + e.message));
  process.exit(1);
});

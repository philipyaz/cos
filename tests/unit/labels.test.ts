// Unit tests for the LABEL taxonomy: the selectors' label filter/grouping + URL
// round-trip, the store's applyCaseUpdate label coercion, and the catalog helpers
// in board/lib/labels.ts (mint/install/validate/edit/remove). Pure, in-memory —
// nothing reads board/data. Run:
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
//     --import ./tests/unit/ts-resolve.mjs --test tests/unit/labels.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseBoardQuery,
  encodeBoardQuery,
  applyBoardQuery,
  groupCases,
} from "../../board/lib/selectors.ts";
import { applyCaseUpdate, BadRequestError, NotFoundError } from "../../board/lib/store.ts";
import {
  activeLabels,
  labelById,
  addCustomLabel,
  installBundle,
  uninstallBundle,
  ownedCount,
  assertKnownLabels,
  updateLabelDef,
  removeLabelDef,
  mintLabelId,
  slugify,
} from "../../board/lib/labels.ts";
import { LABEL_BUNDLES, findBundle } from "../../board/lib/label-bundles.ts";
import type { CaseRecord, DBShape } from "../../board/lib/types.ts";

function mkCase(over: Partial<CaseRecord> = {}): CaseRecord {
  return {
    id: over.id ?? "CASE-1",
    title: over.title ?? "Untitled",
    summary: over.summary ?? "",
    status: over.status ?? "todo",
    domain: over.domain ?? "work",
    tasks: over.tasks ?? [],
    messageIds: over.messageIds ?? [],
    createdAt: over.createdAt ?? "2026-05-01T00:00:00.000Z",
    updatedAt: over.updatedAt ?? "2026-05-01T00:00:00.000Z",
    ...over,
  };
}
function mkDB(over: Partial<DBShape> = {}): DBShape {
  return { schemaVersion: 3, version: 1, cases: [], messages: [], labels: [], ...over };
}

// ── selectors: labels filter / group / URL ─────────────────────────────────────
test("selectors — label query round-trip", async (t) => {
  await t.test("parse labels (comma list, de-duped)", () => {
    assert.deepEqual(parseBoardQuery(new URLSearchParams("labels=urgent-ask,vip,urgent-ask")).labels, [
      "urgent-ask",
      "vip",
    ]);
  });
  await t.test("encode emits labels", () => {
    assert.equal(encodeBoardQuery({ labels: ["a", "b"] }), "labels=a%2Cb");
  });
  await t.test("encode(parse(x)) is stable", () => {
    const sp = new URLSearchParams("labels=a,b&status=urgent");
    assert.equal(encodeBoardQuery(parseBoardQuery(sp)), "status=urgent&labels=a%2Cb");
  });
});

test("selectors — applyBoardQuery filters by label (OR facet)", async (t) => {
  const cases = [
    mkCase({ id: "CASE-1", labels: ["a", "b"] }),
    mkCase({ id: "CASE-2", labels: ["b"] }),
    mkCase({ id: "CASE-3", labels: ["c"] }),
    mkCase({ id: "CASE-4" }), // no labels
  ];
  await t.test("single label → cases carrying it", () => {
    const out = applyBoardQuery(cases, { labels: ["b"] }).map((c) => c.id).sort();
    assert.deepEqual(out, ["CASE-1", "CASE-2"]);
  });
  await t.test("multiple labels → ANY match (union)", () => {
    const out = applyBoardQuery(cases, { labels: ["a", "c"] }).map((c) => c.id).sort();
    assert.deepEqual(out, ["CASE-1", "CASE-3"]);
  });
  await t.test("no label filter → all (visible) cases", () => {
    assert.equal(applyBoardQuery(cases, {}).length, 4);
  });
});

test("selectors — groupCases by label", async (t) => {
  const cases = [
    mkCase({ id: "CASE-1", labels: ["a", "b"] }),
    mkCase({ id: "CASE-2", labels: ["b"] }),
    mkCase({ id: "CASE-3" }),
  ];
  const groups = groupCases(cases, "label");
  const byKey = Object.fromEntries(groups.map((g) => [g.key, g.cases.map((c) => c.id)]));
  await t.test("a case with two labels appears under both", () => {
    assert.deepEqual(byKey["a"], ["CASE-1"]);
    assert.deepEqual(byKey["b"].sort(), ["CASE-1", "CASE-2"]);
  });
  await t.test("label-less cases bucket under 'none' (No label)", () => {
    assert.deepEqual(byKey["none"], ["CASE-3"]);
    assert.equal(groups.find((g) => g.key === "none")?.label, "No label");
  });
});

// ── store: applyCaseUpdate labels ──────────────────────────────────────────────
test("store — applyCaseUpdate label coercion", async (t) => {
  await t.test("dedupes, trims, drops empties", () => {
    const c = mkCase();
    applyCaseUpdate(c, { labels: ["a", " a ", "b", "", "  "] });
    assert.deepEqual(c.labels, ["a", "b"]);
  });
  await t.test("empty array clears to undefined", () => {
    const c = mkCase({ labels: ["a"] });
    applyCaseUpdate(c, { labels: [] });
    assert.equal(c.labels, undefined);
  });
  await t.test("absent key leaves labels untouched", () => {
    const c = mkCase({ labels: ["a"] });
    applyCaseUpdate(c, { title: "x" });
    assert.deepEqual(c.labels, ["a"]);
  });
  await t.test("non-array clears to undefined", () => {
    const c = mkCase({ labels: ["a"] });
    applyCaseUpdate(c, { labels: "nope" as unknown as string[] });
    assert.equal(c.labels, undefined);
  });
});

// ── labels.ts: catalog helpers ────────────────────────────────────────────────
test("labels — slugify / mintLabelId", async (t) => {
  await t.test("slugify kebabs", () => {
    assert.equal(slugify("Access Request!"), "access-request");
    assert.equal(slugify("  Foo / Bar  "), "foo-bar");
  });
  await t.test("mintLabelId avoids collisions", () => {
    const taken = new Set(["access-request", "access-request-2"]);
    assert.equal(mintLabelId("Access Request", taken), "access-request-3");
    assert.equal(mintLabelId("Brand New", taken), "brand-new");
  });
});

test("labels — addCustomLabel", async (t) => {
  await t.test("mints id from title, stores fields", () => {
    const db = mkDB();
    const l = addCustomLabel(db, { title: "VIP Client", description: "key account", color: "violet" });
    assert.equal(l.id, "vip-client");
    assert.equal(l.title, "VIP Client");
    assert.equal(l.color, "violet");
    assert.equal(activeLabels(db).length, 1);
  });
  await t.test("dedupes minted ids across calls", () => {
    const db = mkDB();
    const a = addCustomLabel(db, { title: "Risk" });
    const b = addCustomLabel(db, { title: "Risk" });
    assert.equal(a.id, "risk");
    assert.equal(b.id, "risk-2");
  });
  await t.test("rejects an empty title", () => {
    assert.throws(() => addCustomLabel(mkDB(), { title: "  " }), BadRequestError);
  });
  await t.test("rejects a colliding explicit id", () => {
    const db = mkDB({ labels: [{ id: "vip", title: "VIP", description: "" }] });
    assert.throws(() => addCustomLabel(db, { id: "vip", title: "Other" }), BadRequestError);
  });
  await t.test("drops an out-of-palette color", () => {
    const db = mkDB();
    const l = addCustomLabel(db, { title: "X", color: "chartreuse" });
    assert.equal(l.color, undefined);
  });
});

test("labels — installBundle (idempotent, stamps provenance)", async (t) => {
  const bundle = findBundle("universal") ?? LABEL_BUNDLES[0];
  await t.test("installs all labels once", () => {
    const db = mkDB();
    const r = installBundle(db, bundle.id);
    assert.equal(r.installed.length, bundle.labels.length);
    assert.equal(activeLabels(db).length, bundle.labels.length);
    assert.equal(activeLabels(db)[0].bundle, bundle.id);
  });
  await t.test("re-install adds nothing new", () => {
    const db = mkDB();
    installBundle(db, bundle.id);
    const again = installBundle(db, bundle.id);
    assert.equal(again.installed.length, 0);
  });
  await t.test("unknown bundle throws NotFoundError", () => {
    assert.throws(() => installBundle(mkDB(), "__nope__"), NotFoundError);
  });
  await t.test("returns conflicts when a same-id label differs; keeps the existing one", () => {
    const firstId = bundle.labels[0].id;
    const db = mkDB({ labels: [{ id: firstId, title: "Mine", description: "different meaning" }] });
    const r = installBundle(db, bundle.id);
    assert.ok(!r.installed.includes(firstId), "the colliding id is not re-installed");
    assert.ok(r.conflicts.some((c) => c.id === firstId), "the differing definition is surfaced as a conflict");
    assert.equal(labelById(db, firstId)?.title, "Mine", "the existing definition is kept (not overwritten)");
  });
  await t.test("no conflict when the same-id label is identical", () => {
    const l = bundle.labels[0];
    const db = mkDB({ labels: [{ id: l.id, title: l.title, description: l.description }] });
    const r = installBundle(db, bundle.id);
    assert.equal(r.conflicts.length, 0);
  });
});

test("labels — uninstallBundle / ownedCount", async (t) => {
  const bundle = findBundle("it-support") ?? LABEL_BUNDLES.find((b) => b.category === "role")!;
  await t.test("removes the bundle's owned labels; ownedCount tracks it", () => {
    const db = mkDB();
    installBundle(db, bundle.id);
    assert.equal(ownedCount(db, bundle.id), bundle.labels.length);
    const r = uninstallBundle(db, bundle.id);
    assert.equal(r.removed.length, bundle.labels.length);
    assert.equal(activeLabels(db).length, 0);
    assert.equal(ownedCount(db, bundle.id), 0);
  });
  await t.test("keeps custom labels and labels owned by another bundle", () => {
    const db = mkDB();
    addCustomLabel(db, { title: "Mine" }); // custom, no provenance
    installBundle(db, "manager");
    installBundle(db, "finance-accounting"); // 'approval-needed' stays manager-owned
    const before = activeLabels(db).length;
    const r = uninstallBundle(db, "finance-accounting");
    assert.ok(labelById(db, "approval-needed"), "shared id owned by manager is kept");
    assert.ok(!r.removed.includes("approval-needed"));
    assert.ok(labelById(db, "mine"), "custom label survives");
    assert.ok(r.removed.length > 0 && activeLabels(db).length < before, "finance-owned labels removed");
  });
  await t.test("scrub strips removed ids from cases (empty → undefined)", () => {
    const db = mkDB();
    installBundle(db, bundle.id);
    const someId = bundle.labels[0].id;
    addCustomLabel(db, { id: "keep", title: "Keep" });
    db.cases = [mkCase({ id: "CASE-1", labels: [someId] }), mkCase({ id: "CASE-2", labels: [someId, "keep"] })];
    const r = uninstallBundle(db, bundle.id, { scrub: true });
    assert.ok(r.removed.includes(someId));
    assert.equal(r.scrubbed, 2);
    assert.equal(db.cases[0].labels, undefined);
    assert.deepEqual(db.cases[1].labels, ["keep"]);
  });
  await t.test("without scrub leaves (now dangling) case refs", () => {
    const db = mkDB();
    installBundle(db, bundle.id);
    const someId = bundle.labels[0].id;
    db.cases = [mkCase({ id: "CASE-1", labels: [someId] })];
    uninstallBundle(db, bundle.id, { scrub: false });
    assert.deepEqual(db.cases[0].labels, [someId]);
  });
  await t.test("unknown bundle throws NotFoundError", () => {
    assert.throws(() => uninstallBundle(mkDB(), "__nope__"), NotFoundError);
  });
});

test("labels — assertKnownLabels", async (t) => {
  const db = mkDB({ labels: [{ id: "a", title: "A", description: "" }, { id: "b", title: "B", description: "" }] });
  await t.test("passes for known ids / empty / undefined", () => {
    assert.doesNotThrow(() => assertKnownLabels(db, ["a", "b"]));
    assert.doesNotThrow(() => assertKnownLabels(db, []));
    assert.doesNotThrow(() => assertKnownLabels(db, undefined));
  });
  await t.test("throws naming the unknown id", () => {
    try {
      assertKnownLabels(db, ["a", "zzz"]);
      assert.fail("expected throw");
    } catch (e) {
      assert.ok(e instanceof BadRequestError);
      assert.match((e as Error).message, /zzz/);
    }
  });
  await t.test("non-array throws", () => {
    assert.throws(() => assertKnownLabels(db, "a" as unknown as string[]), BadRequestError);
  });
});

test("labels — updateLabelDef / removeLabelDef", async (t) => {
  await t.test("update edits fields, rejects bad color, 404 on miss", () => {
    const db = mkDB({ labels: [{ id: "a", title: "A", description: "old" }] });
    updateLabelDef(db, "a", { title: "A2", description: "new", color: "teal" });
    assert.deepEqual(activeLabels(db)[0], { id: "a", title: "A2", description: "new", color: "teal" });
    assert.throws(() => updateLabelDef(db, "a", { color: "neon" }), BadRequestError);
    assert.throws(() => updateLabelDef(db, "missing", { title: "x" }), NotFoundError);
  });
  await t.test("remove with scrub strips the id from cases", () => {
    const db = mkDB({
      labels: [{ id: "a", title: "A", description: "" }],
      cases: [mkCase({ id: "CASE-1", labels: ["a", "b"] }), mkCase({ id: "CASE-2", labels: ["a"] })],
    });
    const ok = removeLabelDef(db, "a", { scrub: true });
    assert.equal(ok, true);
    assert.equal(activeLabels(db).length, 0);
    assert.deepEqual(db.cases[0].labels, ["b"]); // 'a' scrubbed, 'b' kept
    assert.equal(db.cases[1].labels, undefined); // emptied → undefined
  });
  await t.test("remove without scrub leaves case refs (dangling)", () => {
    const db = mkDB({
      labels: [{ id: "a", title: "A", description: "" }],
      cases: [mkCase({ id: "CASE-1", labels: ["a"] })],
    });
    removeLabelDef(db, "a");
    assert.deepEqual(db.cases[0].labels, ["a"]); // untouched
  });
  await t.test("remove returns false on a miss", () => {
    assert.equal(removeLabelDef(mkDB(), "nope"), false);
  });
});

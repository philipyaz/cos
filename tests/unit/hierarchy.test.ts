// Unit tests for the Initiative > Workstream > Case hierarchy: the pure selector
// layer (isLeaf/isContainer, childrenOfCases, descendantLeaves, rollupFor,
// lineageOfCases, rootInitiativeOf, buildForest, hierarchyViolation) and the
// store wrappers that depend on it (assertHierarchy, applyCaseUpdate handling of
// kind/parentId, cleanCases detach). Pure / in-memory —
// nothing reads board/data. Run:
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
//     --import ./tests/unit/ts-resolve.mjs --test tests/unit/hierarchy.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isLeaf,
  isContainer,
  childrenOfCases,
  descendantLeaves,
  rolledUpMessageIds,
  rollupFor,
  lineageOfCases,
  rootInitiativeOf,
  buildForest,
  reorderPositions,
  hierarchyViolation,
} from "../../board/lib/selectors.ts";
import {
  applyCaseUpdate,
  assertHierarchy,
  cleanCases,
  BadRequestError,
} from "../../board/lib/store.ts";
import type { CaseRecord, DBShape, Task, CaseKind } from "../../board/lib/types.ts";

let seq = 0;
function task(status: Task["status"] = "open"): Task {
  seq += 1;
  return {
    id: `T${seq}`,
    title: `task ${seq}`,
    status,
    createdAt: "2026-05-01T00:00:00.000Z",
    completedAt: status === "done" ? "2026-05-02T00:00:00.000Z" : undefined,
  };
}

function mk(over: Partial<CaseRecord> & { id: string }): CaseRecord {
  return {
    title: over.id,
    summary: "",
    status: "todo",
    domain: "work",
    tasks: [],
    messageIds: [],
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
    ...over,
  };
}

// A representative tree:
//   I (initiative)
//    ├ W1 (workstream)            pos 0
//    │   ├ C1 (case, done, 2 tasks/1 done)
//    │   └ C2 (case, todo, 1 task/0 done)
//    └ W2 (workstream)            pos 1
//        ├ C3 (case, done, 0 tasks)
//        └ C4 (case, todo, archived — excluded from rollups)
//   O  (orphan standalone leaf, no parent)
function tree(): CaseRecord[] {
  return [
    mk({ id: "I", kind: "initiative" }),
    mk({ id: "W1", kind: "workstream", parentId: "I", position: 0 }),
    mk({ id: "W2", kind: "workstream", parentId: "I", position: 1 }),
    mk({ id: "C1", parentId: "W1", position: 0, status: "done", tasks: [task("done"), task("open")] }),
    mk({ id: "C2", parentId: "W1", position: 1, status: "todo", tasks: [task("open")] }),
    mk({ id: "C3", parentId: "W2", status: "done", tasks: [] }),
    mk({ id: "C4", parentId: "W2", status: "todo", archivedAt: "2026-05-03T00:00:00.000Z", tasks: [task("open")] }),
    mk({ id: "O" }),
  ];
}

function db(cases: CaseRecord[]): DBShape {
  return { schemaVersion: 3, version: 1, cases, messages: [] };
}

// ── isLeaf / isContainer ───────────────────────────────────────────────────────
test("isLeaf / isContainer — absent kind is a leaf case", () => {
  assert.equal(isLeaf({}), true);
  assert.equal(isLeaf({ kind: "case" }), true);
  assert.equal(isLeaf({ kind: "workstream" }), false);
  assert.equal(isContainer({ kind: "initiative" }), true);
  assert.equal(isContainer({ kind: "workstream" }), true);
  assert.equal(isContainer({}), false);
});

// ── childrenOfCases / descendantLeaves ─────────────────────────────────────────
test("childrenOfCases — direct children only", () => {
  const cs = tree();
  assert.deepEqual(childrenOfCases(cs, "I").map((c) => c.id), ["W1", "W2"]);
  assert.deepEqual(childrenOfCases(cs, "W1").map((c) => c.id), ["C1", "C2"]);
  assert.deepEqual(childrenOfCases(cs, "C1").map((c) => c.id), []);
});

test("descendantLeaves — all leaves below a node, archived excluded by default", () => {
  const cs = tree();
  assert.deepEqual(descendantLeaves(cs, "I").map((c) => c.id).sort(), ["C1", "C2", "C3"]);
  assert.deepEqual(descendantLeaves(cs, "W2").map((c) => c.id), ["C3"]); // C4 archived
  assert.deepEqual(
    descendantLeaves(cs, "W2", { includeArchived: true }).map((c) => c.id).sort(),
    ["C3", "C4"],
  );
});

// ── rollupFor ──────────────────────────────────────────────────────────────────
test("rollupFor — aggregates non-archived descendant leaves (cases + tasks)", () => {
  const cs = tree();
  const r = rollupFor(cs, "I");
  assert.equal(r.totalCases, 3); // C1, C2, C3 (C4 archived)
  assert.equal(r.doneCases, 2); // C1, C3
  assert.equal(r.totalTasks, 3); // 2 + 1 + 0
  assert.equal(r.doneTasks, 1); // C1 has one done task
  assert.equal(Math.round(r.ratio * 100), 67); // 2/3
  assert.equal(r.childCount, 2); // W1, W2

  const w2 = rollupFor(cs, "W2");
  assert.equal(w2.totalCases, 1); // C3 (C4 archived)
  assert.equal(w2.doneCases, 1);
  assert.equal(w2.ratio, 1);
  assert.equal(w2.childCount, 2); // direct children incl. archived C4
});

test("rollupFor — a leaf has no descendant leaves", () => {
  const r = rollupFor(tree(), "C1");
  assert.equal(r.totalCases, 0);
  assert.equal(r.ratio, 0);
});

// ── lineageOfCases / rootInitiativeOf ──────────────────────────────────────────
test("lineageOfCases — root-first ancestor chain inclusive", () => {
  assert.deepEqual(lineageOfCases(tree(), "C1").map((c) => c.id), ["I", "W1", "C1"]);
  assert.deepEqual(lineageOfCases(tree(), "I").map((c) => c.id), ["I"]);
});

test("rootInitiativeOf — nearest initiative ancestor, undefined for an orphan", () => {
  assert.equal(rootInitiativeOf(tree(), "C1")?.id, "I");
  assert.equal(rootInitiativeOf(tree(), "W2")?.id, "I");
  assert.equal(rootInitiativeOf(tree(), "O"), undefined);
});

// ── buildForest ────────────────────────────────────────────────────────────────
test("buildForest — nests by parentId, sorted by position, with rollups", () => {
  const forest = buildForest(tree());
  const ids = forest.map((n) => n.case.id);
  assert.ok(ids.includes("I"));
  assert.ok(ids.includes("O")); // orphan leaf surfaces as its own root
  const root = forest.find((n) => n.case.id === "I")!;
  assert.deepEqual(root.children.map((c) => c.case.id), ["W1", "W2"]); // by position
  const w1 = root.children[0];
  assert.deepEqual(w1.children.map((c) => c.case.id), ["C1", "C2"]);
  assert.equal(root.rollup.totalCases, 3);
});

test("buildForest — archived nodes pruned unless includeArchived", () => {
  const w2 = buildForest(tree()).find((n) => n.case.id === "I")!.children.find((c) => c.case.id === "W2")!;
  assert.deepEqual(w2.children.map((c) => c.case.id), ["C3"]); // C4 pruned
  const w2all = buildForest(tree(), { includeArchived: true })
    .find((n) => n.case.id === "I")!
    .children.find((c) => c.case.id === "W2")!;
  assert.deepEqual(w2all.children.map((c) => c.case.id).sort(), ["C3", "C4"]);
});

// ── hierarchyViolation — the single source of truth ────────────────────────────
test("hierarchyViolation — accepts legal placements", () => {
  const cs = tree();
  assert.equal(hierarchyViolation(cs, { id: "NEW", kind: "case", parentId: "W1" }), null);
  assert.equal(hierarchyViolation(cs, { id: "NEW", kind: "case", parentId: "I" }), null); // leaf direct under initiative
  assert.equal(hierarchyViolation(cs, { id: "NEW", kind: "workstream", parentId: "I" }), null);
  assert.equal(hierarchyViolation(cs, { id: "NEW", kind: "initiative" }), null);
  assert.equal(hierarchyViolation(cs, { id: "NEW", kind: "case" }), null); // standalone orphan
});

test("hierarchyViolation — rejects illegal placements", () => {
  const cs = tree();
  const bad = (change: { id: string; kind: CaseKind; parentId?: string }) =>
    assert.notEqual(hierarchyViolation(cs, change), null);
  bad({ id: "NEW", kind: "initiative", parentId: "I" }); // initiative cannot have a parent
  bad({ id: "NEW", kind: "workstream" }); // workstream needs an initiative parent
  bad({ id: "NEW", kind: "workstream", parentId: "C1" }); // parent is a leaf case
  bad({ id: "NEW", kind: "workstream", parentId: "W1" }); // workstream under a workstream
  bad({ id: "NEW", kind: "case", parentId: "C1" }); // case under a case
  bad({ id: "W1", kind: "workstream", parentId: "W1" }); // self-parent
  bad({ id: "NEW", kind: "case", parentId: "NOPE" }); // dangling parent
});

test("hierarchyViolation — turning a parent into a leaf is rejected", () => {
  // I has children, so making it (or W1) a leaf "case" must fail.
  assert.notEqual(hierarchyViolation(tree(), { id: "W1", kind: "case", parentId: "I" }), null);
});

test("hierarchyViolation — detects a cycle among containers", () => {
  // Malformed pair: I points at W and W points at I.
  const cs = [
    mk({ id: "I", kind: "initiative", parentId: "W" }),
    mk({ id: "W", kind: "workstream", parentId: "I" }),
  ];
  const reason = hierarchyViolation(cs, { id: "W", kind: "workstream", parentId: "I" });
  assert.ok(reason && /cycle/i.test(reason));
});

test("hierarchyViolation — enforces the 3-tier depth limit", () => {
  // A deliberately over-deep container chain (A→B→ROOT) — a 4th tier is rejected.
  const cs = [
    mk({ id: "ROOT", kind: "initiative" }),
    mk({ id: "B", kind: "initiative", parentId: "ROOT" }),
    mk({ id: "A", kind: "initiative", parentId: "B" }),
  ];
  const reason = hierarchyViolation(cs, { id: "X", kind: "case", parentId: "A" });
  assert.ok(reason && /three tiers|3-tier/i.test(reason));
});

// ── store: assertHierarchy ─────────────────────────────────────────────────────
test("assertHierarchy — throws BadRequestError on a violation, silent when ok", () => {
  const d = db(tree());
  assert.throws(() => assertHierarchy(d, { id: "NEW", kind: "initiative", parentId: "I" }), BadRequestError);
  assert.doesNotThrow(() => assertHierarchy(d, { id: "NEW", kind: "case", parentId: "W1" }));
});

// ── store: applyCaseUpdate handles kind + parentId ─────────────────────────────
test("applyCaseUpdate — sets kind/parentId; a leaf kind normalizes to absent", () => {
  const c = mk({ id: "X" });
  applyCaseUpdate(c, { kind: "workstream", parentId: "I" });
  assert.equal(c.kind, "workstream");
  assert.equal(c.parentId, "I");
  applyCaseUpdate(c, { kind: "case" });
  assert.equal(c.kind, undefined); // absent === case
  applyCaseUpdate(c, { parentId: null });
  assert.equal(c.parentId, undefined); // detached
});

// ── store: cleanCases detaches children ────────────────────────────────────────
// (cleanCases is now the sole permanent-removal primitive, reused by the retention
// sweep — it detaches children of a removed container so nothing dangles.)
test("cleanCases — detaches children so nothing dangles", () => {
  const d = db([
    mk({ id: "I", kind: "initiative" }),
    mk({ id: "W1", kind: "workstream", parentId: "I" }),
    mk({ id: "C1", parentId: "W1" }),
  ]);
  assert.equal(cleanCases(d, ["W1"]).cases, 1);
  assert.equal(d.cases.find((c) => c.id === "W1"), undefined); // gone
  assert.equal(d.cases.find((c) => c.id === "C1")!.parentId, undefined); // detached
});

// ── rolledUpMessageIds ──────────────────────────────────────────────────────────
// A tree where mail is linked at every tier, so we can prove self-first ordering,
// de-dup, the archived-subtree skip, and a sub-container carrying its own mail:
//   I (initiative)      messages: m-I
//    ├ W1 (workstream)  messages: m-W1
//    │   ├ C1 (case)    messages: m-C1, m-shared
//    │   └ C2 (case)    messages: m-C2
//    └ W2 (workstream)  messages: (none)
//        ├ C3 (case)    messages: m-C3, m-shared   (m-shared dup'd across C1/C3)
//        └ C4 (case, archived) messages: m-C4
function mailTree(): CaseRecord[] {
  return [
    mk({ id: "I", kind: "initiative", messageIds: ["m-I"] }),
    mk({ id: "W1", kind: "workstream", parentId: "I", position: 0, messageIds: ["m-W1"] }),
    mk({ id: "W2", kind: "workstream", parentId: "I", position: 1, messageIds: [] }),
    mk({ id: "C1", parentId: "W1", position: 0, messageIds: ["m-C1", "m-shared"] }),
    mk({ id: "C2", parentId: "W1", position: 1, messageIds: ["m-C2"] }),
    mk({ id: "C3", parentId: "W2", position: 0, messageIds: ["m-C3", "m-shared"] }),
    mk({ id: "C4", parentId: "W2", position: 1, archivedAt: "2026-05-03T00:00:00.000Z", messageIds: ["m-C4"] }),
  ];
}

test("rolledUpMessageIds — container unions descendant mail, self-first + de-duped, archived skipped", () => {
  const cs = mailTree();
  // I: own m-I first, then W1 subtree (m-W1, m-C1, m-shared, m-C2), then W2 subtree
  // (W2 has none, m-C3, then m-shared is a dup so dropped). C4 archived → m-C4 out.
  assert.deepEqual(rolledUpMessageIds(cs, "I"), [
    "m-I",
    "m-W1",
    "m-C1",
    "m-shared",
    "m-C2",
    "m-C3",
  ]);
});

test("rolledUpMessageIds — a leaf returns only its own ids", () => {
  assert.deepEqual(rolledUpMessageIds(mailTree(), "C1"), ["m-C1", "m-shared"]);
});

test("rolledUpMessageIds — a sub-container's OWN mail is included before its children's", () => {
  // W1 emits its own m-W1 first, then its leaves' ids.
  assert.deepEqual(rolledUpMessageIds(mailTree(), "W1"), ["m-W1", "m-C1", "m-shared", "m-C2"]);
});

test("rolledUpMessageIds — archived descendant subtree excluded by default, included with the flag", () => {
  const cs = mailTree();
  assert.ok(!rolledUpMessageIds(cs, "W2").includes("m-C4")); // C4 archived
  assert.deepEqual(rolledUpMessageIds(cs, "W2"), ["m-C3", "m-shared"]);
  assert.deepEqual(
    rolledUpMessageIds(cs, "W2", { includeArchived: true }),
    ["m-C3", "m-shared", "m-C4"],
  );
});

test("rolledUpMessageIds — the node itself is included even when it is archived", () => {
  // Self is always emitted regardless of its own archived state (you asked for it).
  const cs = [mk({ id: "X", archivedAt: "2026-05-03T00:00:00.000Z", messageIds: ["m-X"] })];
  assert.deepEqual(rolledUpMessageIds(cs, "X"), ["m-X"]);
});

test("rolledUpMessageIds — cycle-safe on malformed parentId loops", () => {
  // A↔B point at each other; the visited set must stop the walk.
  const cs = [
    mk({ id: "A", kind: "initiative", parentId: "B", messageIds: ["m-A"] }),
    mk({ id: "B", kind: "workstream", parentId: "A", messageIds: ["m-B"] }),
  ];
  const ids = rolledUpMessageIds(cs, "A");
  assert.deepEqual(ids.sort(), ["m-A", "m-B"]); // each seen once, no infinite loop
});

test("rollupFor — messageCount equals the rolledUpMessageIds length (container + leaf)", () => {
  const cs = mailTree();
  assert.equal(rollupFor(cs, "I").messageCount, rolledUpMessageIds(cs, "I").length); // 6
  assert.equal(rollupFor(cs, "I").messageCount, 6);
  assert.equal(rollupFor(cs, "C1").messageCount, rolledUpMessageIds(cs, "C1").length); // 2
  assert.equal(rollupFor(cs, "C1").messageCount, 2);
});

// ── buildForest({ hideDoneLeaves }) ─────────────────────────────────────────────
test("buildForest — hideDoneLeaves prunes done leaves from children AND roots, keeps containers + rollups", () => {
  // Add a standalone DONE leaf root to prove top-level pruning too.
  const cs = [...tree(), mk({ id: "DONE_ROOT", status: "done" })];

  const def = buildForest(cs);
  const hidden = buildForest(cs, { hideDoneLeaves: true });

  // Top-level: the done standalone root is gone, the orphan todo "O" and "I" stay.
  assert.ok(def.map((n) => n.case.id).includes("DONE_ROOT"));
  assert.ok(!hidden.map((n) => n.case.id).includes("DONE_ROOT"));
  assert.ok(hidden.map((n) => n.case.id).includes("O")); // non-done leaf root kept
  assert.ok(hidden.map((n) => n.case.id).includes("I")); // initiative container kept

  // Nested: under W1, the done C1 is pruned but the todo C2 remains.
  const w1 = hidden.find((n) => n.case.id === "I")!.children.find((c) => c.case.id === "W1")!;
  assert.deepEqual(w1.children.map((c) => c.case.id), ["C2"]); // C1 done → pruned

  // W2's only non-archived leaf C3 is done → its child list empties, but the
  // workstream CONTAINER itself survives (roadmap shape preserved).
  const w2 = hidden.find((n) => n.case.id === "I")!.children.find((c) => c.case.id === "W2")!;
  assert.deepEqual(w2.children.map((c) => c.case.id), []);

  // PRESENTATION-ONLY: rollups are unchanged vs the default forest — the pruned
  // done leaves still COUNT (rollupFor reads the full cases array).
  const wsDefault = def.find((n) => n.case.id === "I")!;
  const wsHidden = hidden.find((n) => n.case.id === "I")!;
  assert.equal(wsHidden.rollup.totalCases, wsDefault.rollup.totalCases); // 3
  assert.equal(wsHidden.rollup.doneCases, wsDefault.rollup.doneCases); // 2
});

// ── reorderPositions ────────────────────────────────────────────────────────────
// Siblings with clean numeric positions for the fast-path tests.
function seeded(): CaseRecord[] {
  return [
    mk({ id: "A", position: 1000 }),
    mk({ id: "B", position: 2000 }),
    mk({ id: "C", position: 3000 }),
  ];
}

test("reorderPositions — fast path: middle interpolation, single write", () => {
  // Move C before B → order A, C, B. C lands between A(1000) and B(2000).
  assert.deepEqual(reorderPositions(seeded(), "C", "B"), [{ id: "C", position: 1500 }]);
});

test("reorderPositions — fast path: append (beforeId null) drops past the last", () => {
  // Move A to the end → past C(3000).
  assert.deepEqual(reorderPositions(seeded(), "A", null), [{ id: "A", position: 4000 }]);
});

test("reorderPositions — fast path: front insert drops under the new top", () => {
  // Move C before A → ahead of A(1000).
  assert.deepEqual(reorderPositions(seeded(), "C", "A"), [{ id: "C", position: 0 }]);
});

test("reorderPositions — seeding path: rebase the whole list when a sibling lacks a position", () => {
  // B has no position → siblings can't interpolate; rebase all to index*STEP in
  // the desired order (C moved before A → C, A, B). Entries already at target skip.
  const cs = [
    mk({ id: "A", position: 0 }),
    mk({ id: "B" }), // no position
    mk({ id: "C", position: 2000 }),
  ];
  // Desired order C, A, B → targets C:0, A:1000, B:2000.
  // A already sits at 0 but its target is 1000 (moved), C target 0 != 2000, B 2000.
  const out = reorderPositions(cs, "C", "A");
  assert.deepEqual(out, [
    { id: "C", position: 0 },
    { id: "A", position: 1000 },
    { id: "B", position: 2000 },
  ]);
});

test("reorderPositions — no-op when the order is unchanged returns []", () => {
  // Move B before C in A,B,C → still A,B,C. Nothing to write.
  assert.deepEqual(reorderPositions(seeded(), "B", "C"), []);
});

test("reorderPositions — movedId not among siblings returns []", () => {
  assert.deepEqual(reorderPositions(seeded(), "ZZZ", "B"), []);
});

test("reorderPositions — a non-finite (NaN) sibling position never poisons the bisect", () => {
  // NaN satisfies `typeof === "number"` but must NOT take the fast path: bisecting
  // a NaN neighbour yields NaN (which round-trips to a position CLEAR). With B's
  // position NaN the list rebases to clean index*STEP integers via the seeding
  // path instead. We assert the bug-fix invariants without pinning the exact order
  // (a NaN element makes the internal sort engine-dependent): never a lone fast-
  // path write, and EVERY emitted position is finite.
  const cs = [
    mk({ id: "A", position: 1000 }),
    mk({ id: "B", position: Number.NaN }),
    mk({ id: "C", position: 3000 }),
  ];
  const out = reorderPositions(cs, "C", "A");
  assert.notEqual(out.length, 1, "must not take the single-write fast path with a NaN sibling");
  assert.ok(out.every((w) => Number.isFinite(w.position)), "no emitted position is non-finite");
  // The seeding rebase assigns index*STEP, so the values come from {0,1000,2000}.
  assert.ok(out.every((w) => [0, 1000, 2000].includes(w.position)));
});

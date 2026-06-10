"""Hermetic, OFFLINE engine tests for the search sidecar.

Run: `COS_SEARCH_EMBEDDER=hash uv run --extra dev pytest -q`

Forcing COS_SEARCH_EMBEDDER=hash keeps the suite fully offline — no model
download, pure-numpy hash embedder. The index backend is PARAMETRIZED:
  * "brute" — _BruteForceIndex, ALWAYS runs (pure numpy).
  * "turbo" — _TurboBackend, importorskip("turbovec") so it is silently skipped
    on an arch without the prebuilt wheel.

We test the pure engine (SearchIndex façade + helpers); the FastAPI app is not
exercised here (its endpoints are thin shells over the same façade and are
verified by central integration). We seed a tiny in-memory db that mirrors the
real cases.json shape — including the Marco case the acceptance criteria name.
"""

from __future__ import annotations

import os

import pytest

# Force the hermetic embedder BEFORE importing the module so make_embedder() picks
# the hash fallback (no network, no model).
os.environ.setdefault("COS_SEARCH_EMBEDDER", "hash")

import sidecar
from sidecar import (
    HashedNgramEmbedder,
    SearchIndex,
    build_docs,
    content_digest,
    hybrid_score,
    make_embedder,
)
from sidecar import _project_reminder  # v6 reminder projection


# ── fixtures ──────────────────────────────────────────────────────────────────
def _db() -> dict:
    """A small db that mirrors the real cases.json shape (cases+tasks+messages),
    including the Marco case named by the acceptance criteria and an archived case
    to exercise the skip path."""
    return {
        "schemaVersion": 3,
        "version": 7,
        "cases": [
            {
                "id": "CASE-1",
                "title": "Co-maintainer conversation with Marco Rivera",
                "summary": "Exploring the DevForge project venture together.",
                "status": "in_progress",
                "domain": "work",
                "tags": ["devforge", "ai"],
                "labels": ["engagement"],
                "tasks": [
                    {"id": "T1", "title": "Draft the partnership memo", "detail": "Outline equity split", "status": "open"},
                ],
            },
            {
                "id": "CASE-3",
                "title": "Developer Advocacy Mastery — positioning & first moves",
                "summary": "Define the community-facing posture and book intro calls.",
                "status": "todo",
                "domain": "work",
                "tags": ["advocacy"],
                "tasks": [
                    {"id": "T2", "title": "Publish the first sophisticated post", "status": "open"},
                ],
            },
            {
                "id": "CASE-9",
                "title": "CI pipeline migration planning",
                "summary": "Move the build matrix to the new runner.",
                "status": "waiting_for_input",
                "domain": "work",
                "tasks": [],
            },
            {
                "id": "CASE-99",
                "title": "Archived old case",
                "summary": "Should be skipped by default.",
                "status": "done",
                "domain": "life",
                "archivedAt": "2025-01-01T00:00:00Z",
                "tasks": [{"id": "TX", "title": "stale task", "status": "done"}],
            },
        ],
        "messages": [
            {
                "id": "M-1",
                "source": "gmail",
                "from": "marco.rivera@gmail.com",
                "subject": "Re: catching up post-trip",
                "preview": "Great to reconnect about the DevForge idea.",
                "body": "Let us sketch the project venture next week.",
                "caseId": "CASE-1",
            },
            {
                "id": "M-2",
                "source": "system",
                "from": "ops@board",
                "subject": "Weekly digest",
                "preview": "Nothing urgent.",
                "body": "Routine summary.",
                "caseId": None,
            },
        ],
        "reminders": [
            # OPEN, linked to CASE-1, carries a catalog label + a short task (v6).
            {
                "id": "REM-1",
                "title": "Send Marco the partnership memo draft",
                "detail": "Follow up before the call.",
                "status": "open",
                "caseId": "CASE-1",
                "domain": "work",
                "dueAt": "2026-06-10",
                "labels": ["engagement"],
                "tasks": [{"id": "REM-1-T1", "title": "Attach the equity split table", "done": False}],
                "createdAt": "2026-06-01T00:00:00Z",
                "updatedAt": "2026-06-01T00:00:00Z",
            },
            # DONE, standalone — must still be indexed + searchable (no archive).
            {
                "id": "REM-2",
                "title": "Renew the passport before expiry",
                "detail": "Booked the appointment.",
                "status": "done",
                "createdAt": "2026-05-01T00:00:00Z",
                "updatedAt": "2026-05-20T00:00:00Z",
                "completedAt": "2026-05-20T00:00:00Z",
            },
        ],
    }


def _new_index(backend: str) -> SearchIndex:
    """Build a SearchIndex pinned to a specific backend with the hash embedder."""
    if backend == "turbo":
        pytest.importorskip("turbovec")
    idx = SearchIndex(embedder=HashedNgramEmbedder())
    if backend == "brute":
        # Force the numpy fallback even where turbovec is installed: monkeypatch the
        # backend factory to always return a brute-force index.
        idx._new_backend = lambda: sidecar._BruteForceIndex(  # type: ignore[attr-defined]
            idx.emb.dim, idx.str2id, idx.id2str, idx.next_id
        )
    db = _db()
    idx.build(build_docs(db), content_digest(db))
    return idx


BACKENDS = ["brute", "turbo"]


# ── embedder ──────────────────────────────────────────────────────────────────
def test_make_embedder_hash_forced(monkeypatch):
    monkeypatch.setenv("COS_SEARCH_EMBEDDER", "hash")
    emb = make_embedder()
    assert emb.name == "hashed-ngram-fallback"
    assert emb.dim == 256


def test_hash_embedder_is_deterministic_and_unit_norm():
    emb = HashedNgramEmbedder()
    v1 = emb.encode(["Marco Rivera"])
    v2 = emb.encode(["Marco Rivera"])
    assert v1.shape == (1, 256)
    assert v1.dtype.name == "float32"
    # identical input → identical vector (cross-process stability)
    assert (v1 == v2).all()
    # L2-normalized → unit norm
    assert abs(float((v1[0] ** 2).sum()) - 1.0) < 1e-5


def test_encode_empty_list_returns_zero_rows():
    emb = HashedNgramEmbedder()
    out = emb.encode([])
    assert out.shape == (0, 256)


# ── doc model / digest ────────────────────────────────────────────────────────
def test_build_docs_ids_and_skip_archived():
    docs = build_docs(_db())
    ids = {d["id"] for d in docs}
    # cases (non-archived), tasks ("<caseId>::<tid>"), messages
    assert "CASE-1" in ids
    assert "CASE-1::T1" in ids
    assert "M-1" in ids
    # archived case + its task are skipped by default
    assert "CASE-99" not in ids
    assert "CASE-99::TX" not in ids
    # an unlinked message carries caseId None
    m2 = next(d for d in docs if d["id"] == "M-2")
    assert m2["caseId"] is None


def test_build_docs_include_archived():
    docs = build_docs(_db(), include_archived=True)
    ids = {d["id"] for d in docs}
    assert "CASE-99" in ids


def test_build_docs_reminders_indexed():
    """Reminders become docs (v6): type="reminder", id=r.id, a "reminder" projection,
    and the blob folds in title·detail·labels·task-titles·domain. DONE ones too —
    reminders have NO archive, so they are present regardless of include_archived."""
    docs = build_docs(_db())
    by_id = {d["id"]: d for d in docs}
    assert "REM-1" in by_id and "REM-2" in by_id
    rem = by_id["REM-1"]
    assert rem["type"] == "reminder"
    assert rem["caseId"] == "CASE-1"
    assert rem["domain"] == "work" and rem["status"] == "open"
    # projection present + projected fields
    proj = rem["reminder"]
    assert proj == _project_reminder(_db()["reminders"][0])
    assert proj["labels"] == ["engagement"]
    # blob folds in detail, label ids, and task titles
    assert "memo" in rem["text"].lower()
    assert "engagement" in rem["text"].lower()
    assert "equity split table" in rem["text"].lower()
    # standalone DONE reminder: no caseId, still indexed even without include_archived
    done = by_id["REM-2"]
    assert done["caseId"] is None and done["status"] == "done"
    docs_no_arch = {d["id"] for d in build_docs(_db(), include_archived=False)}
    assert "REM-2" in docs_no_arch


def test_project_reminder_shape():
    proj = _project_reminder(_db()["reminders"][1])  # the standalone DONE one
    assert set(proj) == {"id", "title", "status", "dueAt", "domain", "caseId", "labels", "detail"}
    assert proj["id"] == "REM-2"
    assert proj["labels"] == []  # no labels → []
    assert proj["caseId"] is None


def test_content_digest_stable_and_content_sensitive():
    db = _db()
    d1 = content_digest(db)
    d2 = content_digest(_db())
    assert d1 == d2  # same content → same digest
    db["cases"][0]["title"] = db["cases"][0]["title"] + " (edited)"
    assert content_digest(db) != d1  # content change → digest change
    # digest does NOT depend on db.version (adversary C1)
    db2 = _db()
    db2["version"] = 999999
    assert content_digest(db2) == d1


# ── hybrid scoring ────────────────────────────────────────────────────────────
def test_hybrid_exact_id_beats_substring():
    case_doc = {"type": "case", "id": "CASE-1", "text": "x", "case": {"title": ""}}
    exact, why_exact = hybrid_score("CASE-1", case_doc, cosine=0.0)
    assert "exact-id" in why_exact
    sub_doc = {"type": "case", "id": "CASE-11", "text": "x", "case": {"title": ""}}
    sub, why_sub = hybrid_score("CASE-1", sub_doc, cosine=0.0)
    assert "id-substring" in why_sub
    assert exact > sub  # 5.0 boost beats 3.0 boost


def test_hybrid_title_match_boost():
    doc = {"type": "case", "id": "CASE-1", "text": "Marco Rivera devforge", "case": {"title": "Co-maintainer with Marco Rivera"}}
    score, why = hybrid_score("marco", doc, cosine=0.0)
    assert "title-match" in why
    assert score >= 2.0


# ── SearchIndex façade (parametrized over backends) ───────────────────────────
@pytest.mark.parametrize("backend", BACKENDS)
def test_index_builds_and_sizes(backend):
    idx = _new_index(backend)
    # 3 non-archived cases + 2 tasks + 2 messages + 2 reminders = 9 docs
    assert idx.size() == 9


@pytest.mark.parametrize("backend", BACKENDS)
def test_exact_id_ranks_first(backend):
    idx = _new_index(backend)
    hits = idx.search("CASE-3", k=5)
    assert hits, "expected at least one hit"
    top = hits[0]
    assert top["id"] == "CASE-3"
    assert "exact-id" in top["why"]


@pytest.mark.parametrize("backend", BACKENDS)
def test_marco_in_top_k(backend):
    idx = _new_index(backend)
    hits = idx.search("marco", k=5)
    ids = [h["id"] for h in hits]
    assert "CASE-1" in ids, f"Marco case missing from top-5: {ids}"


@pytest.mark.parametrize("backend", BACKENDS)
def test_hit_envelope_shape(backend):
    idx = _new_index(backend)
    hits = idx.search("CASE-1", k=3)
    h = hits[0]
    # canonical hit fields
    for field in ("type", "id", "caseId", "score", "cosine", "why", "snippet"):
        assert field in h, f"missing hit field {field}"
    assert isinstance(h["why"], list)
    assert len(h["snippet"]) <= 160
    # type-specific projection
    assert h["type"] == "case" and "case" in h
    assert h["case"]["id"] == "CASE-1"
    # message hit carries subject/from
    mhits = idx.search("digest", k=5, types=["message"])
    if mhits:
        assert "subject" in mhits[0] and "from" in mhits[0]


@pytest.mark.parametrize("backend", BACKENDS)
def test_type_filter(backend):
    idx = _new_index(backend)
    hits = idx.search("partnership memo", k=10, types=["task"])
    assert hits
    assert all(h["type"] == "task" for h in hits)


@pytest.mark.parametrize("backend", BACKENDS)
def test_domain_filter_excludes_other_domain(backend):
    idx = _new_index(backend)
    # all seeded non-archived cases are domain "work"; "life" should yield no cases/tasks
    hits = idx.search("case", k=10, domain="life", types=["case", "task"])
    assert hits == []


@pytest.mark.parametrize("backend", BACKENDS)
def test_status_filter(backend):
    idx = _new_index(backend)
    hits = idx.search("case", k=10, types=["case"], status="todo")
    assert all(h["case"]["status"] == "todo" for h in hits)
    assert any(h["id"] == "CASE-3" for h in hits)


@pytest.mark.parametrize("backend", BACKENDS)
def test_reminder_is_searchable_and_carries_nature(backend):
    """An OPEN reminder is searchable; the hit flags its nature (type="reminder") and
    carries the reminder projection (+ a title)."""
    idx = _new_index(backend)
    hits = idx.search("partnership memo", k=10)
    rem_hits = [h for h in hits if h["id"] == "REM-1"]
    assert rem_hits, f"REM-1 missing from hits: {[h['id'] for h in hits]}"
    h = rem_hits[0]
    assert h["type"] == "reminder"  # the hit's nature
    assert "reminder" in h and h["reminder"]["id"] == "REM-1"
    assert h["title"] == "Send Marco the partnership memo draft"


@pytest.mark.parametrize("backend", BACKENDS)
def test_reminder_type_filter_returns_only_reminders(backend):
    idx = _new_index(backend)
    hits = idx.search("Marco", k=10, types=["reminder"])
    assert hits, "expected at least one reminder hit"
    assert all(h["type"] == "reminder" for h in hits)


@pytest.mark.parametrize("backend", BACKENDS)
def test_done_reminder_is_indexed_and_searchable(backend):
    """The DONE standalone reminder is indexed (no archive) and surfaces in search."""
    idx = _new_index(backend)
    hits = idx.search("passport renew", k=10, types=["reminder"])
    ids = [h["id"] for h in hits]
    assert "REM-2" in ids, f"DONE reminder missing: {ids}"
    h = next(h for h in hits if h["id"] == "REM-2")
    assert h["reminder"]["status"] == "done"


@pytest.mark.parametrize("backend", BACKENDS)
def test_case_lane_status_filter_does_not_drop_reminders(backend):
    """A case-lane status filter (e.g. status="todo") filters cases/tasks but EXEMPTS
    reminders — their open/done/dismissed is a different space."""
    idx = _new_index(backend)
    hits = idx.search("Marco", k=10, status="todo")
    # the open reminder REM-1 must NOT be dropped by a case-lane status filter
    assert any(h["id"] == "REM-1" for h in hits), [h["id"] for h in hits]
    # and any reminder hit retains its own status untouched by the case-lane filter
    rem = next(h for h in hits if h["id"] == "REM-1")
    assert rem["reminder"]["status"] == "open"


@pytest.mark.parametrize("backend", BACKENDS)
def test_reminder_domain_filter_honoured_only_when_set(backend):
    """Domain is a TRUTHINESS rule: REM-1 carries domain "work" (honoured under
    domain="work", dropped under domain="life"); REM-2 has NO domain so it stays
    exempt and is never dropped by a domain filter."""
    idx = _new_index(backend)
    # REM-1 carries domain="work": present under "work", absent under "life".
    work = [h["id"] for h in idx.search("Marco memo", k=10, types=["reminder"], domain="work")]
    assert "REM-1" in work
    life = [h["id"] for h in idx.search("Marco memo", k=10, types=["reminder"], domain="life")]
    assert "REM-1" not in life
    # REM-2 has no domain → exempt → surfaces under ANY domain filter.
    life2 = [h["id"] for h in idx.search("passport renew", k=10, types=["reminder"], domain="life")]
    assert "REM-2" in life2


@pytest.mark.parametrize("backend", BACKENDS)
def test_search_batch_clamps_to_32_queries(backend):
    idx = _new_index(backend)
    out = idx.search_batch(["CASE-1"] * 40, k=2)
    assert len(out) == 32
    assert out[0]["query"] == "CASE-1"


@pytest.mark.parametrize("backend", BACKENDS)
def test_reindex_idempotent_same_content(backend):
    idx = _new_index(backend)
    db = _db()
    size1, top1 = idx.size(), idx.search("CASE-3", k=1)[0]["id"]
    idx.build(build_docs(db), content_digest(db))
    idx.build(build_docs(db), content_digest(db))
    size2, top2 = idx.size(), idx.search("CASE-3", k=1)[0]["id"]
    assert size1 == size2  # same content → same size
    assert top1 == top2 == "CASE-3"  # same top hit


@pytest.mark.parametrize("backend", BACKENDS)
def test_ensure_rebuilds_only_on_content_change(backend):
    if backend == "turbo":
        pytest.importorskip("turbovec")
    idx = SearchIndex(embedder=HashedNgramEmbedder())
    if backend == "brute":
        idx._new_backend = lambda: sidecar._BruteForceIndex(  # type: ignore[attr-defined]
            idx.emb.dim, idx.str2id, idx.id2str, idx.next_id
        )
    db = _db()
    idx.ensure(db)
    dig1 = idx.indexed_digest
    idx.ensure(db)  # unchanged → no digest change
    assert idx.indexed_digest == dig1
    db["cases"][0]["title"] += " (edited)"
    idx.ensure(db)  # changed content → digest moves
    assert idx.indexed_digest != dig1


@pytest.mark.parametrize("backend", BACKENDS)
def test_empty_index_returns_no_hits(backend):
    if backend == "turbo":
        pytest.importorskip("turbovec")
    idx = SearchIndex(embedder=HashedNgramEmbedder())
    if backend == "brute":
        idx._new_backend = lambda: sidecar._BruteForceIndex(  # type: ignore[attr-defined]
            idx.emb.dim, idx.str2id, idx.id2str, idx.next_id
        )
    idx.build([], content_digest({"cases": [], "messages": []}))
    assert idx.size() == 0
    assert idx.search("anything", k=5) == []

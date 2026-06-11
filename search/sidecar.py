"""Cos semantic search SIDECAR (FastAPI, :8008).

This process is the *optional* semantic half of the board's search. It reads the
board's `cases.json` READ-ONLY (the board is the sole writer of record — atomic
rename, store.ts:183), builds an in-memory vector index, and answers POST /search
with the frozen wire envelope (everything EXCEPT `merged` — the board rebuilds
`merged` server-side from its own in-hand db, never from our projected fields).

Fail-safe is owned by the *board*, not here: the board route wraps the fetch+parse
in one try/except and falls through to its own keyword search on ANY sidecar
failure. So this file is free to be straightforward; if it is down the board still
works. We never write to disk and we never persist an index (it rebuilds in memory
on boot — adversary M3).

Layout of this module, top → bottom:
  1. Embedder    — model2vec primary, deterministic hash fallback, make_embedder().
  2. Backends    — _TurboBackend (turbovec.IdMapIndex) + _BruteForceIndex (numpy).
  3. Doc model   — build_docs(db), per-doc blake2b hash, content_digest(db).
  4. Scoring     — hybrid_score (exact-id / id-substring / title-match / jaccard).
  5. SearchIndex — façade the tests import; ensure(db) keyed on the CONTENT DIGEST.
  6. FastAPI app — /healthz /stats /reindex /search; embedder warmed at startup.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import threading
import time
from pathlib import Path
from typing import Any, Iterable, Protocol, runtime_checkable

import numpy as np

log = logging.getLogger("cos.search")
if not log.handlers:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")

# ── Frozen constants (mirror the wire contract) ───────────────────────────────
DEFAULT_DIM = 256
PRIMARY_MODEL_ID = "minishlab/potion-base-8M"
DEFAULT_K = 10
MAX_K = 50
MAX_QUERIES = 32

# CaseStatus enum — source of truth lives in board/lib/types.ts; mirrored here so
# /search can validate (and silently drop) an out-of-range status filter.
VALID_STATUS = {"urgent", "todo", "in_progress", "waiting_for_input", "done"}
VALID_DOMAIN = {"work", "life"}
VALID_TYPES = {"case", "task", "message", "reminder"}


# ══════════════════════════════════════════════════════════════════════════════
# 1. EMBEDDER  (model2vec brief §B contract: .dim:int · .name:str · .encode(list)→
#    float32 (n,dim) L2-NORMALIZED). Both impls are 256-d & unit-norm, so turbovec's
#    DOT metric == cosine, and the two are dimensionally interchangeable.
# ══════════════════════════════════════════════════════════════════════════════
def _l2_normalize(mat: Any) -> np.ndarray:
    """Row-wise L2-normalize → unit vectors (zero rows pass through unchanged)."""
    mat = np.asarray(mat, dtype=np.float32)
    if mat.ndim == 1:
        mat = mat.reshape(1, -1)
    n = np.linalg.norm(mat, axis=1, keepdims=True)
    n[n == 0.0] = 1.0  # avoid /0 for an all-zero (e.g. empty-string) vector
    return (mat / n).astype(np.float32)


@runtime_checkable
class Embedder(Protocol):
    dim: int
    name: str

    def encode(self, texts: list[str]) -> np.ndarray: ...


class Model2VecEmbedder:
    """Primary embedder: a static (no-torch) distilled model, dim 256.

    First load downloads ~30MB to the HF cache (one-time, ~4s); warm offline load
    is ~0.2s. Output is already ~unit-norm but we re-normalize defensively so the
    DOT-product backend behaves as cosine.
    """

    name = "model2vec:" + PRIMARY_MODEL_ID

    def __init__(self, model_id: str = PRIMARY_MODEL_ID) -> None:
        from model2vec import StaticModel  # lazy import — only when this is selected

        self._m = StaticModel.from_pretrained(model_id)
        self.dim = int(self._m.dim)  # 256

    def encode(self, texts: list[str]) -> np.ndarray:
        if not texts:
            return np.zeros((0, self.dim), np.float32)
        return _l2_normalize(self._m.encode(texts))


class HashedNgramEmbedder:
    """Deterministic, dependency-free fallback (no network, no model, no torch).

    Hashes char 3–5 grams into `dim` buckets with term-frequency weighting, then
    L2-normalizes. Uses blake2b (NOT python hash(), which is salted/unstable per
    process) so the SAME string maps to the SAME vector across processes — required
    for a stable digest-keyed cache. Forced by COS_SEARCH_EMBEDDER=hash (the
    hermetic test path).
    """

    name = "hashed-ngram-fallback"

    def __init__(self, dim: int = DEFAULT_DIM, ngram_range: tuple[int, int] = (3, 5)) -> None:
        self.dim = int(dim)
        self.lo, self.hi = ngram_range

    def _vec(self, text: str) -> np.ndarray:
        v = np.zeros(self.dim, np.float32)
        s = f" {text.lower().strip()} "  # pad so word boundaries get their own grams
        for n in range(self.lo, self.hi + 1):
            for i in range(len(s) - n + 1):
                h = hashlib.blake2b(s[i : i + n].encode(), digest_size=8).digest()
                v[int.from_bytes(h, "big") % self.dim] += 1.0
        return v

    def encode(self, texts: list[str]) -> np.ndarray:
        if not texts:
            return np.zeros((0, self.dim), np.float32)
        return _l2_normalize(np.vstack([self._vec(t) for t in texts]))


def make_embedder() -> Embedder:
    """Select the embedder from COS_SEARCH_EMBEDDER ∈ {auto(default),model2vec,hash}.

    hash       → forced fallback (used by the hermetic test — no network).
    model2vec  → forced primary (raises if the wheel/model is unavailable).
    auto/unset → try primary, fall back to hash on ANY exception.
    """
    choice = os.environ.get("COS_SEARCH_EMBEDDER", "auto").lower()
    if choice == "hash":
        return HashedNgramEmbedder()
    if choice == "model2vec":
        return Model2VecEmbedder()
    try:
        return Model2VecEmbedder()
    except Exception as e:  # noqa: BLE001 — any failure (no wheel, no net, bad cache) → fallback
        log.warning("model2vec unavailable (%s); using hash fallback", e)
        return HashedNgramEmbedder()


# ══════════════════════════════════════════════════════════════════════════════
# 2. INDEX BACKENDS  (string ids ↔ uint64; the map is preserved across rebuilds so
#    external ids stay stable — turbovec brief §d). turbovec is the DOT-product ANN;
#    _BruteForceIndex is the exact numpy fallback when `import turbovec` fails.
# ══════════════════════════════════════════════════════════════════════════════
class _TurboBackend:
    """turbovec.IdMapIndex wrapper — exact empirical API.

    DIM is a positive multiple of 8 (256 ✓ — NO padding). bit_width=4. Vectors are
    np.float32, C-contiguous, 2D; ids are np.uint64, 1D. add_with_ids rejects a dup
    uint64, so an UPDATE is remove-then-add. Queries are kept 2D. prepare() is
    called ONCE after the bulk add, before the first search. Writes are NOT
    thread-safe — the SearchIndex façade guards us with a single lock.
    """

    def __init__(self, dim: int, str2id: dict[str, int], id2str: dict[int, str], next_id: int) -> None:
        import turbovec  # lazy — only when this backend is selected

        self.dim = dim
        self.idx = turbovec.IdMapIndex(dim=dim, bit_width=4)
        self.str2id, self.id2str, self.next_id = str2id, id2str, next_id

    def add(self, doc_ids: list[str], vecs: np.ndarray) -> None:
        uids: list[int] = []
        for s in doc_ids:
            uid = self.str2id.get(s)
            if uid is None:
                uid = self.next_id
                self.next_id += 1
                self.str2id[s] = uid
                self.id2str[uid] = s
            else:
                # Update ⇒ remove then re-add (add_with_ids rejects a dup uint64).
                try:
                    self.idx.remove(np.uint64(uid))
                except Exception:  # noqa: BLE001 — not present is fine
                    pass
            uids.append(uid)
        self.idx.add_with_ids(
            np.ascontiguousarray(vecs, dtype=np.float32),
            np.array(uids, dtype=np.uint64),
        )

    def prepare(self) -> None:
        self.idx.prepare()

    def search(self, qvec: np.ndarray, k: int) -> list[tuple[str, float]]:
        q = np.ascontiguousarray(qvec[:1], dtype=np.float32)  # 2D (1,dim)
        scores, ids = self.idx.search(q, k=k)
        return [
            (self.id2str[int(u)], float(sc))
            for sc, u in zip(scores[0].tolist(), ids[0].tolist())
            if int(u) in self.id2str
        ]

    def size(self) -> int:
        return len(self.idx)

    def delete(self, uid: int) -> bool:
        try:
            self.idx.remove(np.uint64(uid))
            return True
        except Exception:  # noqa: BLE001
            return False


class _BruteForceIndex:
    """Exact numpy fallback if `import turbovec` fails (arch without wheels).

    Same str→score contract as _TurboBackend; cosine == dot because vectors are
    unit-norm. delete() is a no-op — the façade rebuilds the brute backend from
    _docmeta instead (tiny corpus, simplest correct).
    """

    def __init__(self, dim: int, str2id: dict[str, int], id2str: dict[int, str], next_id: int) -> None:
        self.dim = dim
        self.str2id, self.id2str, self.next_id = str2id, id2str, next_id
        self._ids: list[str] = []
        self._mat = np.zeros((0, dim), np.float32)

    def add(self, doc_ids: list[str], vecs: np.ndarray) -> None:
        # Keep the str↔uint64 map populated for parity with the turbo backend,
        # even though brute-force searches by string id directly.
        for s in doc_ids:
            if s not in self.str2id:
                self.str2id[s] = self.next_id
                self.id2str[self.next_id] = s
                self.next_id += 1
        self._ids += list(doc_ids)
        v = vecs.astype(np.float32)
        self._mat = np.vstack([self._mat, v]) if len(self._mat) else v

    def prepare(self) -> None:
        pass

    def search(self, qvec: np.ndarray, k: int) -> list[tuple[str, float]]:
        if not self._ids:
            return []
        sims = self._mat @ qvec[0]
        order = np.argsort(-sims)[:k]
        return [(self._ids[i], float(sims[i])) for i in order]

    def size(self) -> int:
        return len(self._ids)

    def delete(self, uid: int) -> bool:
        return False  # brute-force rebuilds from _docmeta instead


# ══════════════════════════════════════════════════════════════════════════════
# 3. DOCUMENT MODEL  (one vector per searchable doc; string id = external id,
#    type-prefixed). The per-doc blake2b `hash` powers the content digest AND a
#    future per-doc upsert.
# ══════════════════════════════════════════════════════════════════════════════
def _join(*parts: Any) -> str:
    """Join the searchable fragments of a doc into its embeddable blob."""
    out: list[str] = []
    for p in parts:
        if p is None:
            continue
        if isinstance(p, (list, tuple)):
            out.extend(str(x) for x in p if x)
        elif str(p).strip():
            out.append(str(p))
    return " · ".join(out)


def _doc_hash(blob: str) -> str:
    return hashlib.blake2b(blob.encode("utf-8"), digest_size=12).hexdigest()


def _project_case(c: dict) -> dict:
    """The CaseRecord fields surfaced on a hit's `case` (the board re-reads the FULL
    record for `merged`; this projection is only the diagnostic snippet of a hit)."""
    return {
        "id": c.get("id"),
        "title": c.get("title"),
        "status": c.get("status"),
        "domain": c.get("domain"),
        "tags": c.get("tags") or [],
        "labels": c.get("labels") or [],
        "summary": c.get("summary") or "",
        "archivedAt": c.get("archivedAt"),  # lets a hit signal it's a closed/handled matter (dedupe inference)
    }


def _project_reminder(r: dict) -> dict:
    """The Reminder fields surfaced on a hit's `reminder` (v6). Reminders are light —
    the diagnostic snippet is just the nudge + its catalog labels + a little context."""
    return {
        "id": r.get("id"),
        "title": r.get("title"),
        "status": r.get("status"),
        "dueAt": r.get("dueAt"),
        "domain": r.get("domain"),
        "caseId": r.get("caseId"),
        "labels": r.get("labels") or [],
        "detail": r.get("detail") or "",
    }


def build_docs(db: dict, *, include_archived: bool = False) -> list[dict]:
    """Flatten the db into searchable docs: one per case, task, message, and reminder.

    Each doc = {type,id,caseId,text,hash,domain,status, case|title|subject,from|reminder}.
      case     → id=c.id              blob = title·summary·tags·labels·task-titles
      task     → id="<caseId>::<tid>" blob = task.title·task.detail·parent-case-title
      message  → id=m.id              blob = subject·from·to·cc·preview·body[:2000]
      reminder → id=r.id              blob = title·detail·labels·task-titles·domain
    Archived cases (and their tasks) are skipped unless include_archived. Reminders
    have NO archive — they are ALWAYS indexed (DONE ones too), regardless of
    include_archived (the board's search must surface DONE reminders).
    """
    docs: list[dict] = []
    cases = db.get("cases") or []
    for c in cases:
        if c.get("archivedAt") and not include_archived:
            continue
        cid = c.get("id")
        tasks = c.get("tasks") or []
        task_titles = [t.get("title") for t in tasks]
        blob = _join(
            c.get("title"),
            c.get("summary"),
            c.get("tags"),
            c.get("labels"),
            task_titles,
        )
        docs.append(
            {
                "type": "case",
                "id": cid,
                "caseId": cid,
                "text": blob,
                "hash": _doc_hash(blob),
                "domain": c.get("domain"),
                "status": c.get("status"),
                "case": _project_case(c),
            }
        )
        # Tasks — id is "<caseId>::<task.id>" per the frozen contract.
        for t in tasks:
            tid = t.get("id")
            if not tid:
                continue
            tblob = _join(t.get("title"), t.get("detail"), c.get("title"))
            docs.append(
                {
                    "type": "task",
                    "id": f"{cid}::{tid}",
                    "caseId": cid,
                    "text": tblob,
                    "hash": _doc_hash(tblob),
                    "domain": c.get("domain"),
                    "status": c.get("status"),
                    "title": t.get("title"),
                }
            )
    # Messages — caseId may be absent (null) for an unlinked message.
    for m in db.get("messages") or []:
        mblob = _join(m.get("subject"), m.get("from"), m.get("to"), m.get("cc"), m.get("preview"), (m.get("body") or "")[:2000])
        docs.append(
            {
                "type": "message",
                "id": m.get("id"),
                "caseId": m.get("caseId") or None,
                "text": mblob,
                "hash": _doc_hash(mblob),
                "domain": None,  # messages carry no domain of their own
                "status": None,
                "subject": m.get("subject"),
                "from": m.get("from"),
            }
        )
    # Reminders — ALWAYS indexed (no archive; DONE ones included regardless of
    # include_archived). caseId may be absent (a standalone reminder).
    for r in db.get("reminders") or []:
        task_titles = [t.get("title") for t in (r.get("tasks") or [])]
        rblob = _join(r.get("title"), r.get("detail"), r.get("labels"), task_titles, r.get("domain"))
        docs.append(
            {
                "type": "reminder",
                "id": r.get("id"),
                "caseId": r.get("caseId") or None,
                "text": rblob,
                "hash": _doc_hash(rblob),
                "domain": r.get("domain"),
                "status": r.get("status"),
                "reminder": _project_reminder(r),
            }
        )
    return docs


def content_digest(db: dict, *, include_archived: bool = False) -> str:
    """Stable content digest = blake2b of the sorted per-doc "id:hash" lines.

    This — NOT db.version — is the cache key (adversary C1). db.version can DECREASE
    or REPEAT with different content (migrate() resets to 0; readDB() falls back to
    an older .bak; a hand-edit never bumps it), so a version-keyed cache would serve
    stale vectors forever. The per-doc hash already exists, so the digest is free.
    """
    docs = build_docs(db, include_archived=include_archived)
    joined = "\n".join(sorted(f"{d['id']}:{d['hash']}" for d in docs))
    return hashlib.blake2b(joined.encode("utf-8"), digest_size=16).hexdigest()


# ══════════════════════════════════════════════════════════════════════════════
# 4. HYBRID SCORING  (the keystone — exact id & client name BEAT a fuzzy embedding).
# ══════════════════════════════════════════════════════════════════════════════
_TOKEN_SPLIT = str.maketrans({c: " " for c in "·,.;:!?()[]{}\"'/\\|-_<>@\n\t"})


def _tokens(s: str) -> set[str]:
    return {t for t in s.lower().translate(_TOKEN_SPLIT).split() if t}


def _doc_name(doc: dict) -> str:
    """The doc's 'name' field — title for a case/task, the reminder title, subject for a
    message — the field that a 2.0 exact/subset boost keys on."""
    if doc["type"] == "case":
        return (doc.get("case") or {}).get("title") or ""
    if doc["type"] == "task":
        return doc.get("title") or ""
    if doc["type"] == "reminder":
        return (doc.get("reminder") or {}).get("title") or ""
    return doc.get("subject") or ""


def hybrid_score(query: str, doc: dict, cosine: float) -> tuple[float, list[str]]:
    """Blend semantic cosine with cheap lexical signals; return (score, why[]).

      + 5.0  q == doc.id                (exact-id → always top)
      + 3.0  q ⊂ doc.id   (else)        ("CASE-1" ⊂ "CASE-11"; id-substring)
      + 2.0  q ⊂ title OR q-tokens ⊆ name-tokens          (title-match)
      + 1.0 * jaccard(q-tokens, doc-tokens)               (keyword recall)
      + 0.5  any q-token is a substring of the blob        (substring)
    """
    ql = query.lower().strip()
    did = (doc.get("id") or "").lower()
    score = cosine
    why: list[str] = []
    if cosine != 0.0:
        why.append("semantic")

    # id signals — exact wins outright, else substring.
    if ql and ql == did:
        score += 5.0
        why.append("exact-id")
    elif ql and ql in did:
        score += 3.0
        why.append("id-substring")

    # title (name) signal.
    name = _doc_name(doc).lower()
    qtok = _tokens(query)
    ntok = _tokens(name)
    if name and ((ql and ql in name) or (qtok and qtok <= ntok)):
        score += 2.0
        why.append("title-match")

    # keyword recall — jaccard over the full blob's tokens.
    dtok = _tokens(doc.get("text") or "")
    if qtok and dtok:
        jac = len(qtok & dtok) / len(qtok | dtok)
        if jac > 0.0:
            score += 1.0 * jac
            if "title-match" not in why:
                why.append("keyword")

    # weak substring backstop — any query token appears in the blob.
    blob = (doc.get("text") or "").lower()
    if qtok and any(t in blob for t in qtok):
        score += 0.5
        if "keyword" not in why and "title-match" not in why:
            why.append("keyword")

    return score, why


def _snippet(text: str, limit: int = 160) -> str:
    s = " ".join((text or "").split())
    return s if len(s) <= limit else s[: limit - 1].rstrip() + "…"


# ══════════════════════════════════════════════════════════════════════════════
# 5. SearchIndex FAÇADE  (the test's import target). A single threading.Lock guards
#    every mutation — turbovec writes are NOT concurrency-safe (brief §f.13). ensure()
#    rebuilds keyed on the CONTENT DIGEST (version-independent — adversary C1).
# ══════════════════════════════════════════════════════════════════════════════
class SearchIndex:
    def __init__(self, embedder: Embedder | None = None) -> None:
        self.emb: Embedder = embedder or make_embedder()
        self._lock = threading.Lock()
        self._backend: _TurboBackend | _BruteForceIndex | None = None
        self.indexed_digest: str | None = None
        # str↔uint64 map — preserved across rebuilds so external ids stay stable.
        self.str2id: dict[str, int] = {}
        self.id2str: dict[int, str] = {}
        self.next_id = 1
        self._docmeta: dict[str, dict] = {}
        self._indexed_embedder: str | None = None  # for embedder-change invalidation
        self._indexed_archived = False  # cache slot: does the live index include archived docs?

    # ── backend selection ─────────────────────────────────────────────────────
    def _new_backend(self) -> _TurboBackend | _BruteForceIndex:
        try:
            be: _TurboBackend | _BruteForceIndex = _TurboBackend(
                self.emb.dim, self.str2id, self.id2str, self.next_id
            )
            log.info("index backend = turbovec (dim=%d, bit_width=4)", self.emb.dim)
            return be
        except Exception as e:  # noqa: BLE001 — no wheel for this arch → numpy fallback
            log.info("turbovec unavailable (%s); index backend = brute-force numpy", e)
            return _BruteForceIndex(self.emb.dim, self.str2id, self.id2str, self.next_id)

    # ── full (re)build ────────────────────────────────────────────────────────
    def build(self, docs: list[dict], digest: str | None = None) -> None:
        """Clear backend + re-add ALL docs. Idempotent: same digest ⇒ same docs ⇒
        identical index. The str↔uint64 map is preserved (passed into the backend)
        so external uint64 ids stay stable across rebuilds."""
        with self._lock:
            backend = self._new_backend()
            self._docmeta = {d["id"]: d for d in docs}
            if docs:
                ids = [d["id"] for d in docs]
                texts = [d["text"] for d in docs]
                backend.add(ids, self.emb.encode(texts))
                backend.prepare()
            self.next_id = backend.next_id
            self._backend = backend
            self.indexed_digest = digest
            self._indexed_embedder = self.emb.name

    # ── digest-keyed ensure ───────────────────────────────────────────────────
    def ensure(self, db: dict, *, include_archived: bool = False) -> None:
        """Rebuild iff the backend is cold, the CONTENT DIGEST changed, the embedder
        changed (model2vec⇄hash are both 256-d but semantically incompatible → full
        rebuild), or the include_archived scope changed. version-INDEPENDENT
        (adversary C1). Folding include_archived into the cache key means a
        no-archived index is never served for an includeArchived=true request (which
        otherwise diverged from the board's keyword fallback, which DOES honor it)."""
        digest = content_digest(db, include_archived=include_archived)
        if (
            self._backend is None
            or digest != self.indexed_digest
            or self.emb.name != self._indexed_embedder
            or include_archived != self._indexed_archived
        ):
            self.build(build_docs(db, include_archived=include_archived), digest)
            self._indexed_archived = include_archived

    # ── single-doc delete (tiny corpus, simplest correct) ─────────────────────
    def delete(self, doc_id: str) -> bool:
        with self._lock:
            meta = self._docmeta.pop(doc_id, None)
            if meta is None:
                return False
            uid = self.str2id.pop(doc_id, None)
            if uid is not None:
                self.id2str.pop(uid, None)
            if isinstance(self._backend, _TurboBackend):
                if uid is not None:
                    self._backend.delete(uid)
            elif self._backend is not None:
                # brute-force: rebuild from the surviving _docmeta.
                survivors = list(self._docmeta.values())
                be = self._new_backend()
                if survivors:
                    be.add([d["id"] for d in survivors], self.emb.encode([d["text"] for d in survivors]))
                    be.prepare()
                self.next_id = be.next_id
                self._backend = be
            return True

    def size(self) -> int:
        return self._backend.size() if self._backend else 0

    # ── single-query search → hit dicts ───────────────────────────────────────
    def search(
        self,
        q: str,
        k: int = DEFAULT_K,
        *,
        types: Iterable[str] | None = None,
        domain: str | None = None,
        status: str | None = None,
    ) -> list[dict]:
        if self.size() == 0:
            return []
        type_filter = set(types) if types else None
        # Over-fetch top-N candidates to absorb quantization error (brief §c.8),
        # then re-rank with hybrid_score before slicing to k.
        topn = max(50, k)
        with self._lock:
            cands = self._backend.search(self.emb.encode([q]), topn)
        scored: list[tuple[float, list[str], dict]] = []
        for doc_id, cosine in cands:
            doc = self._docmeta.get(doc_id)
            if doc is None:  # index/meta drift — defensive
                continue
            if type_filter is not None and doc["type"] not in type_filter:
                continue
            # domain: TRUTHINESS rule — honor only when the doc carries a domain.
            # cases always have one (unchanged); messages have None (stay exempt);
            # reminders are honoured only when they carry a domain.
            if domain is not None and doc.get("domain") and doc.get("domain") != domain:
                continue
            # status: case-lane filter — reminders are EXEMPT (their
            # open/done/dismissed is a different space; case/task still filtered;
            # messages stay excluded since status None != value).
            if status is not None and doc["type"] != "reminder" and doc.get("status") != status:
                continue
            score, why = hybrid_score(q, doc, cosine)
            scored.append((score, why, doc))
        scored.sort(key=lambda x: x[0], reverse=True)
        return [self._format_hit(doc, score, cosine_of(doc, cands), why) for score, why, doc in scored[:k]]

    def search_batch(self, queries: list[str], k: int = DEFAULT_K, **f: Any) -> list[dict]:
        return [{"query": q, "hits": self.search(q, k, **f)} for q in queries[:MAX_QUERIES]]

    # ── hit projection (frozen contract) ──────────────────────────────────────
    def _format_hit(self, doc: dict, score: float, cosine: float, why: list[str]) -> dict:
        hit = {
            "type": doc["type"],
            "id": doc["id"],
            "caseId": doc.get("caseId"),
            "score": round(float(score), 4),
            "cosine": round(float(cosine), 4),
            "why": why,
            "snippet": _snippet(doc.get("text") or ""),
        }
        if doc["type"] == "case":
            hit["case"] = doc.get("case")
        elif doc["type"] == "task":
            hit["title"] = doc.get("title")
        elif doc["type"] == "message":
            hit["subject"] = doc.get("subject")
            hit["from"] = doc.get("from")
        elif doc["type"] == "reminder":
            hit["reminder"] = doc.get("reminder")
            hit["title"] = (doc.get("reminder") or {}).get("title")
        return hit


def cosine_of(doc: dict, cands: list[tuple[str, float]]) -> float:
    """Recover the raw cosine the backend returned for this doc (diagnostic field)."""
    for did, cos in cands:
        if did == doc["id"]:
            return cos
    return 0.0


# ══════════════════════════════════════════════════════════════════════════════
# 6. FastAPI APP  (/healthz /stats /reindex /search). The embedder is WARMED at
#    startup so /healthz only greens once the model is loaded (adversary M4).
# ══════════════════════════════════════════════════════════════════════════════
def _resolve_data_file() -> Path:
    """COS_BOARD_DATA (abs) wins; else the repo's board/data/cases.json. The sidecar
    opens this READ-ONLY and never writes it — the board is the sole writer."""
    env = os.environ.get("COS_BOARD_DATA")
    if env:
        return Path(env).expanduser().resolve()
    return (Path(__file__).parent / ".." / "board" / "data" / "cases.json").resolve()


DATA_FILE = _resolve_data_file()
INDEX = SearchIndex()


def _read_cases_json() -> dict:
    """Read the board db READ-ONLY. The board writes via atomic rename, so we never
    observe a partial file; a transient read error surfaces as an empty db."""
    try:
        with open(DATA_FILE, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except FileNotFoundError:
        log.warning("data file not found: %s", DATA_FILE)
        return {"cases": [], "messages": []}
    except (json.JSONDecodeError, OSError) as e:
        log.warning("data file unreadable (%s); treating as empty: %s", e, DATA_FILE)
        return {"cases": [], "messages": []}


# FastAPI is an optional dep for the hermetic test path (which imports only the
# engine), so guard the import. If it is absent the module still loads for pytest.
try:
    from contextlib import asynccontextmanager

    from fastapi import FastAPI, HTTPException
    from pydantic import BaseModel

    class BatchReq(BaseModel):
        queries: list[str] = []
        q: str | None = None
        k: int = DEFAULT_K
        types: list[str] | None = None
        domain: str | None = None
        status: str | None = None
        includeArchived: bool = False
        dbDigest: str | None = None  # advisory hint from the board; we recompute

    @asynccontextmanager
    async def _lifespan(_app: "FastAPI"):
        # WARM the embedder before the server accepts traffic (adversary M4): touch
        # .emb.name → forces the (possibly downloading) model load so /healthz only
        # greens once loaded. Also log the resolved read-only data file at startup.
        _ = INDEX.emb.name
        log.info("startup: dataFile=%s embedder=%s dim=%d", DATA_FILE, INDEX.emb.name, INDEX.emb.dim)
        yield

    app = FastAPI(title="cos-search sidecar", version="0.1.0", lifespan=_lifespan)

    @app.get("/healthz")
    def healthz() -> dict:
        return {"ok": True, "embedder": INDEX.emb.name, "dim": INDEX.emb.dim}

    @app.get("/stats")
    def stats() -> dict:
        return {
            "embedder": INDEX.emb.name,
            "dim": INDEX.emb.dim,
            "size": INDEX.size(),
            "indexedDigest": INDEX.indexed_digest,
            "dataFile": str(DATA_FILE),  # exposes the resolved path (adversary G2)
        }

    @app.post("/reindex")
    def reindex() -> dict:
        """Force a full rebuild regardless of digest (cold start / embedder swap / ops)."""
        db = _read_cases_json()
        INDEX.build(build_docs(db), content_digest(db))
        INDEX._indexed_archived = False  # /reindex rebuilds the default (no-archived) scope
        return {"ok": True, "size": INDEX.size(), "digest": INDEX.indexed_digest}

    @app.post("/search")
    def search(req: BatchReq) -> dict:
        t0 = time.perf_counter()
        db = _read_cases_json()
        INDEX.ensure(db, include_archived=req.includeArchived)

        # Normalize the request to the frozen contract.
        raw = list(req.queries or [])
        if req.q:
            raw.append(req.q)
        queries = [s.strip() for s in raw if s and s.strip()][:MAX_QUERIES]
        if not queries:
            raise HTTPException(status_code=400, detail="no queries")

        k = max(1, min(MAX_K, int(req.k)))
        # Validate filters; ignore-invalid (NOT 400) per the contract.
        types = [t for t in (req.types or []) if t in VALID_TYPES] or None
        domain = req.domain if req.domain in VALID_DOMAIN else None
        status = req.status if req.status in VALID_STATUS else None

        results = INDEX.search_batch(queries, k, types=types, domain=domain, status=status)
        return {
            "engine": "semantic",
            "embedder": INDEX.emb.name,
            "indexedDigest": INDEX.indexed_digest,
            "tookMs": round((time.perf_counter() - t0) * 1000.0, 2),
            "results": results,
        }

except ImportError:  # pragma: no cover — fastapi absent (engine-only test env)
    app = None  # type: ignore[assignment]
    log.info("fastapi not installed; engine importable but HTTP app disabled")

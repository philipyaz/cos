# `search/` — semantic search sidecar

A **local-first, optional** semantic-search service for the kanban board. It reads
`board/data/cases.json` **read-only**, builds an in-memory vector index, and answers
`POST /search` with the frozen wire envelope (everything **except** `merged` — the
board rebuilds `merged` from its own in-hand db). The board's `POST /api/search` calls
this with an **800 ms timeout** and **falls back to its own keyword search on any
failure**, so the board works with **no sidecar and no `uv`** installed.

```
board POST /api/search ──HTTP─► sidecar.py (:8008) ──read-only─► board/data/cases.json
        │ 800ms timeout                 Embedder(model2vec|hash)
        └─ on ANY failure ─► keyword fallback (board-owned)
```

## What it is

- **Embedder** (`COS_SEARCH_EMBEDDER` ∈ `auto`·`model2vec`·`hash`):
  - `model2vec` — `minishlab/potion-base-8M`, 256-d, no torch (default `auto` tries this first).
  - `hash` — deterministic blake2b char-n-gram fallback; pure numpy, **no network, no model**.
  - Both are 256-d and L2-normalized → turbovec's DOT metric behaves as cosine.
- **Index** — `turbovec.IdMapIndex(dim=256, bit_width=4)` (prebuilt wheel, no Rust). On
  an arch without the wheel it falls back to an exact numpy brute-force index with the
  same string→score contract.
- **Hybrid scoring** — semantic cosine blended with lexical signals so an exact id or a
  client name **beats** a fuzzy embedding: `exact-id +5 · id-substring +3 · client/title
  +2 · jaccard ×1 · substring +0.5`.
- **Staleness** — the index is keyed on a **content digest** (`blake2b` of the sorted
  per-doc `id:hash`), **not** `db.version` (which can decrease/repeat across hand-edits,
  `.bak` fallback, or migrate-resets). `ensure(db)` rebuilds iff the digest or the
  embedder changed. No persisted index — it rebuilds in memory on boot.

## Endpoints

| method | path        | returns |
| ------ | ----------- | ------- |
| GET    | `/healthz`  | `{ok, embedder, dim}` (only green once the embedder is warmed) |
| GET    | `/stats`    | `{embedder, dim, size, indexedDigest, dataFile}` (resolved abs path) |
| POST   | `/reindex`  | force a full rebuild → `{ok, size, digest}` |
| POST   | `/search`   | the frozen envelope (no `merged`) → `{engine, embedder, indexedDigest, tookMs, results}` |

`POST /search` body (subset of the frozen contract): `{queries[], q?, k=10 (clamped
[1,50]), types?, domain?, status?, includeArchived?, dbDigest?}`. Queries are trimmed,
empties dropped, clamped to the first 32. Invalid `types`/`domain`/`status` are silently
ignored (not a 400); empty queries → 400.

## Environment

| var | default | meaning |
| --- | ------- | ------- |
| `COS_BOARD_DATA` | `../board/data/cases.json` | abs path to the board db (read-only) |
| `COS_SEARCH_EMBEDDER` | `auto` | `auto` · `model2vec` · `hash` |
| `HF_HUB_OFFLINE=1` | — | force offline model load after the first download |

## Run

```bash
uv run --directory search uvicorn sidecar:app --port 8008
# smoke
curl -s localhost:8008/healthz
curl -s localhost:8008/stats
curl -s -X POST localhost:8008/search -H 'content-type: application/json' \
  -d '{"queries":["CASE-3","rivera"],"k":5}'
```

## Test (hermetic, offline)

```bash
cd search && COS_SEARCH_EMBEDDER=hash uv run --extra dev pytest -q
```

Forcing the hash embedder keeps the suite **fully offline** (no model download). The
backend is parametrized: the **brute-force** param always runs (pure numpy); the
**turbo** param `importorskip`s `turbovec` so it is skipped where the wheel is absent.

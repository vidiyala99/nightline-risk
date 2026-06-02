# Policy-Doc Vector RAG — design

**Date:** 2026-06-02
**Status:** Approved (design); pending implementation plan
**Scope:** Backend only. Embedding-backed semantic retrieval over policy-document
clause chunks, with citation anchoring, measured by the existing retrieval eval
harness.

---

## 1. Goal

Replace keyword/TF-IDF retrieval over policy-document clauses with **embedding-based
semantic retrieval**, end-to-end: embed on ingest → persist vectors → cosine retrieve
→ clause/page-anchored citations → measured by `evals/retrieval_scorers.py`.

The artifact is a **measured before/after**: NDCG@5 and MRR for TF-IDF baseline vs
vector retrieval on the gold citation set. With real embedding keys set, vector
retrieval should beat TF-IDF on that set; that delta is the deliverable.

This is the "new policy-doc RAG" scope (chosen 2026-06-02), distinct from a generic
vector service or a simple swap of the in-memory knowledge base.

## 2. What already exists (we build on, not rebuild)

- **Corpus + ingestion:** `POST /api/venues/{id}/policy-docs` → `ingest_policy_doc`
  (`app/api/v1/policy_docs.py`, broker-gated) parses markdown via
  `app/policy_document.py::build_policy_tree` into `PolicyDocument.tree_json` plus
  flattened **`SourceRecord`** leaves. Each leaf's `source_metadata` carries
  `clause_id`, `section`, `is_exclusion`, `node_id`, `path`, `page_start/end`,
  `source_file`.
- **Retrieval today:** `app/rag.py::SemanticKnowledgeBase` — TF-IDF cosine
  (scikit-learn) with a keyword fallback. Interface: `retrieve(venue_id, query,
  limit) -> list[Citation]`. Consumed by `app/agents/runtime.py` (imported as
  `VenueKnowledgeBase`) and instantiated in `app/main.py`.
- **Embedding abstraction:** `app/providers/base.py::EmbeddingProvider` (ABC with
  `embed(texts) -> EmbeddingOutput`); implementations `OpenAIEmbeddingProvider`,
  `GeminiEmbeddingProvider`, and `DeterministicEmbeddingProvider` (deliberately
  **raises** — explicit "no vectors, set a key" sentinel). Selected by
  `get_default_embedding_provider()`.
- **Measurement:** `app/evals/retrieval_scorers.py` — `score_ndcg_at_k` (k=5,
  pass ≥0.7) and `score_mrr` (pass ≥0.5) over `mandatory_citations` gold lists.
- **Deps already declared (dormant):** `pgvector`, `chromadb` in
  `requirements.txt`. We use neither in v1 (see §9).

## 3. Approach (decision)

**Chosen — A: embeddings on a sibling row + provider-abstracted vector index
(NumPy cosine default; pgvector as a later backend swap).**

Two hard constraints drove this:

1. **Tests run on SQLite** (`create_engine("sqlite://")`). pgvector does not exist
   on SQLite, so a pgvector-native retrieval cannot be exercised in CI.
2. **No embedding API keys** (LLM live mode is gated). `DeterministicEmbeddingProvider`
   raises, so nothing produces vectors offline today.

Approach A resolves both: vectors are stored as ordinary JSON and similarity is
computed in NumPy, so the pipeline runs identically on SQLite (tests) and Postgres
(prod); a deterministic **hashing** embedding produces real vectors with no keys.

**Rejected:**

- **B — pgvector-native** (`vector` column + `<=>`): real prod vector DB and scales,
  but breaks the SQLite test story (would need a Postgres test path or skipped
  tests). pgvector remains a documented future backend swap behind the index
  interface, not a v1 prerequisite.
- **C — Chroma sidecar:** Chroma local is **ephemeral on Railway** (the same
  constraint that forced the S3 storage abstraction) and is a parallel store to
  keep in sync. Least aligned.

## 4. Components

Each unit has one purpose and a defined interface, mirroring existing patterns.

### 4.1 `HashingEmbeddingProvider` (new, `app/providers/`)
Deterministic, offline embedding via feature hashing. Same text → same vector.

- Fixed dimension `DIM = 256`, L2-normalized output.
- Implementation: tokenize (lowercase, split on non-alphanumeric), hash each token
  (and bigrams) into `[0, DIM)` with a stable hash (`hashlib.blake2b` of the token,
  not Python's salted `hash()`), accumulate counts, then L2-normalize. No sklearn
  dependency required (keeps it usable even if sklearn is absent).
- `model` identifier: `"hashing-v1-256"`.
- **`DeterministicEmbeddingProvider` is left unchanged** (still raises; its test
  stays green). Hashing is a separate, additive provider.

### 4.2 `EmbeddingRecord` (new SQLModel table, `app/models.py`)
One row per embedded clause chunk.

```
id: str (pk)                       # f"emb-{uuid4().hex[:12]}"
source_record_id: str (index, FK -> SourceRecord.id, column-level FK)
venue_id: str (index)
model: str                         # provider model id, e.g. "hashing-v1-256"
dim: int
vector: list[float]  (JSON column) # serialized; see §6 read-boundary coercion
content_hash: str (index)          # sha256 of the embedded text; idempotency key
created_at: datetime = default_factory=now_utc
```

- `content_hash` makes re-ingest idempotent: if a record with the same
  `(source_record_id, model, content_hash)` exists, skip re-embedding.
- Column-level FK without a `Relationship()` → **`session.flush()` the `SourceRecord`
  parents before inserting `EmbeddingRecord` children** (Postgres FK-ordering rule).
- New table → needs an entry in `database.py` schema self-healing if existing-table
  SELECTs would otherwise miss it (allowlist, not introspection).

### 4.3 `VectorKnowledgeBase` (new, `app/rag.py`)
Drop-in sibling of `SemanticKnowledgeBase` with the **identical interface**
`retrieve(venue_id, query, limit) -> list[Citation]`.

- On `retrieve`: embed the query with the active provider; load the venue's
  `EmbeddingRecord`s **whose `model` matches the active provider's model** (mismatch
  → treat as no usable vectors, see selector fallback); NumPy cosine; rank; map the
  top-k back to `Citation`s using the parent `SourceRecord.source_metadata`
  (`clause_id`, `section`, `page_start/end`, `path`, `node_id`).
- Model-match guard prevents comparing a hashing-256 query vector against
  OpenAI-1536 corpus vectors (dim mismatch / garbage similarity).

### 4.4 Ingest hook (`app/api/v1/policy_docs.py` / a service helper)
After `ingest_policy_doc` persists `SourceRecord` leaves: embed each leaf's text and
persist `EmbeddingRecord` rows.

- Batched `provider.embed([...])`.
- Idempotent via `content_hash`.
- **Failure isolation:** any embedding error (no key, API failure) is caught and
  logged; the policy-doc ingest still succeeds, just without embeddings. Retrieval
  then falls back to TF-IDF (§4.5). Embedding is never on the critical path of a
  broker upload.

### 4.5 `get_knowledge_base(session, venue_id)` selector (`app/rag.py`)
Returns `VectorKnowledgeBase` when the venue has `EmbeddingRecord`s for the active
model; otherwise the TF-IDF `SemanticKnowledgeBase`. Wires into
`app/agents/runtime.py` in place of the direct `SemanticKnowledgeBase` construction.
Guarantees zero regression when embeddings are absent.

## 5. Data flow

```
INGEST:  markdown → build_policy_tree → SourceRecord leaves (flush)
                 → provider.embed(texts) → EmbeddingRecord rows
                   [skip rows whose (source_record_id, model, content_hash) exists]

QUERY:   query text → provider.embed([query]) → query_vec
                 → cosine(query_vec, venue EmbeddingRecords[model==active])
                 → top-k → Citation(clause_id, section, page_start/end, path, node_id)
                 → agent runtime → retrieval_scorers (NDCG@5, MRR)
```

## 6. Error handling & known landmines

- **No keys / embedding failure:** caught at ingest; doc still ingests; retrieval
  falls back to TF-IDF. No 500s, no broken uploads.
- **Postgres JSON-string regression (prod-only class):** a `vector` stored as a
  JSON list round-trips as a **string** on Neon (parsed list on SQLite). Coerce at
  the read boundary (`_as_list`-style: `json.loads` if `isinstance(value, str)`)
  before the NumPy load. A test simulates the string case so it can't 500 in prod.
- **Model/dim mismatch:** the §4.3 model-match guard ensures query and corpus
  vectors share a provider/dim; mismatched records are ignored (selector falls back
  to TF-IDF if none match).
- **Empty corpus / venue with no docs:** `retrieve` returns `[]` (mirrors current
  `SemanticKnowledgeBase` behavior).

## 7. Config / env

- `EMBEDDING_PROVIDER` (optional): `hashing` (default) | `openai` | `gemini`.
  Absent or unset → `hashing` (offline-safe). `openai`/`gemini` require their
  respective API keys; if the key is missing the resolver logs and falls back to
  `hashing`.
- **Resolution is a new function**, `resolve_embedding_provider()` (in
  `app/providers/__init__.py`), used by the vector pipeline. It is **distinct from
  the existing `get_default_embedding_provider()`**, which defaults to the *raising*
  `DeterministicEmbeddingProvider` when no keys — that behavior is unchanged and not
  reused here. The vector index never resolves to the raising provider; its no-key
  default is `hashing`, so the pipeline always has usable vectors.
- The "active provider's model" referenced in §4.3/§6 is the `model` id of whatever
  `resolve_embedding_provider()` returns for the current process.
- Document in `backend/.env.example`.
- No new infra services. No bucket, no sidecar.

## 8. Success criteria

1. `retrieval_scorers.py` runs over `VectorKnowledgeBase` retrieval and the existing
   gold scenarios, producing NDCG@5 and MRR.
2. A small comparison harness/test prints **TF-IDF baseline vs vector** for the same
   scenarios.
3. With a real embedding key set, vector NDCG@5 ≥ TF-IDF NDCG@5 on the gold set
   (informational assertion; not a hard CI gate initially, matching the scorers'
   own "informational until baseline captured" stance).
4. Full backend suite green; no regression in existing retrieval/agent tests.

## 9. Out of scope (YAGNI)

- **pgvector-native backend** — designed-for behind the index interface; not built
  in v1. Becomes a backend swap when corpus size justifies it.
- **Chroma** — not used.
- **Live PDF / PageIndex ingestion** — separate phase; we embed the existing
  markdown-derived `SourceRecord` leaves.
- **Hybrid TF-IDF + vector fusion / re-ranking** — future note, not v1.
- **Re-embedding migrations on model change** — v1 ignores non-matching-model
  records and falls back; a backfill script is future work.

## 10. Test plan (TDD)

Written test-first, all runnable on SQLite with no API keys:

1. `HashingEmbeddingProvider`: determinism (same text → same vector), correct
   `dim`, L2-normalized (‖v‖ ≈ 1), different texts → different vectors.
2. Ranking math: inject **known vectors** (not the hashing provider) into
   `EmbeddingRecord`s and assert `VectorKnowledgeBase.retrieve` ranks the
   semantically-near clause above the far one (exact, deterministic assertion).
3. Idempotent ingest: re-running ingest does not duplicate `EmbeddingRecord`s
   (content_hash skip).
4. FK ordering: `EmbeddingRecord` insert after `SourceRecord` flush works (no
   integrity error).
5. JSON-string coercion: a `vector` stored as a JSON **string** is parsed before
   the NumPy load (simulates Neon).
6. Selector fallback: venue with no embeddings → `get_knowledge_base` returns the
   TF-IDF `SemanticKnowledgeBase`; venue with embeddings → `VectorKnowledgeBase`.
7. Failure isolation: an embedding provider that raises does not break
   `ingest_policy_doc`; the doc is still persisted.
8. Eval integration: `score_ndcg_at_k` / `score_mrr` run over a vector-retrieval
   result without error.

## 11. File change list

- `app/providers/hashing_provider.py` (new) + export in `app/providers/__init__.py`.
- `app/models.py` — `EmbeddingRecord`.
- `app/database.py` — schema self-healing entry for the new table.
- `app/rag.py` — `VectorKnowledgeBase`, `get_knowledge_base`.
- `app/api/v1/policy_docs.py` (or a small `app/services/` helper) — embed-on-ingest
  hook with failure isolation.
- `app/agents/runtime.py` — use `get_knowledge_base` selector.
- `backend/.env.example` — `EMBEDDING_PROVIDER`.
- `backend/tests/test_vector_rag.py` (new) — the §10 suite.
- Optional: a comparison test/script for §8.2.

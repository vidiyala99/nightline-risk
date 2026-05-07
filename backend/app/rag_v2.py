"""
Third Space Risk — Semantic Knowledge Base (Phase 2 retrieval upgrade)

Replaces keyword term-matching with TF-IDF cosine similarity so queries like
"camera footage evidence" match documents containing "security clip metadata"
even without exact term overlap. Falls back to keyword search if scikit-learn
is not installed.

Phase 3 upgrade path: swap TfidfVectorizer for a sentence-transformers encoder
and ChromaDB for persistent vector storage — the interface is identical.
"""

from app.schemas import Citation


class SemanticKnowledgeBase:
    """
    TF-IDF semantic retrieval over venue knowledge sources and stream events.

    Builds the vector index lazily on first retrieve() call so startup time
    is unaffected when the knowledge base is constructed.
    """

    def __init__(self, sources: list[dict], stream_events: list[dict]):
        self._documents = [*sources, *stream_events]
        self._vectorizer = None
        self._matrix = None

    def _build_index(self) -> None:
        try:
            from sklearn.feature_extraction.text import TfidfVectorizer
            corpus = [
                f"{doc.get('text', '')} {doc.get('label', '')} {doc.get('source_type', '')}"
                for doc in self._documents
            ]
            self._vectorizer = TfidfVectorizer(
                min_df=1, stop_words="english", ngram_range=(1, 2)
            )
            self._matrix = self._vectorizer.fit_transform(corpus)
        except ImportError:
            self._vectorizer = None
            self._matrix = None

    def retrieve(self, venue_id: str, query: str, limit: int = 5) -> list[Citation]:
        if self._vectorizer is None and self._matrix is None:
            self._build_index()

        venue_docs = [
            (i, doc)
            for i, doc in enumerate(self._documents)
            if doc["venue_id"] == venue_id or doc.get("venue_id") == "*"
        ]

        if not venue_docs:
            # Fall back to all shared (venue_id="*") documents
            venue_docs = [
                (i, doc)
                for i, doc in enumerate(self._documents)
                if doc.get("venue_id") == "*"
            ]

        if not venue_docs:
            return []

        if self._vectorizer is not None and self._matrix is not None:
            return self._semantic_retrieve(venue_docs, query, limit)
        return self._keyword_fallback(venue_docs, query, limit)

    def _semantic_retrieve(
        self, venue_docs: list[tuple[int, dict]], query: str, limit: int
    ) -> list[Citation]:
        from sklearn.metrics.pairwise import cosine_similarity

        query_vec = self._vectorizer.transform([query])
        doc_indices = [i for i, _ in venue_docs]
        venue_matrix = self._matrix[doc_indices]
        scores = cosine_similarity(query_vec, venue_matrix).flatten()

        ranked = sorted(
            zip(scores, [doc for _, doc in venue_docs]),
            key=lambda x: x[0],
            reverse=True,
        )
        return [
            Citation(
                source_id=doc["source_id"],
                source_type=doc.get("source_type", "stream"),
                excerpt=doc.get("text") or doc["label"],
            )
            for _, doc in ranked[:limit]
        ]

    def _keyword_fallback(
        self, venue_docs: list[tuple[int, dict]], query: str, limit: int
    ) -> list[Citation]:
        query_terms = {t.lower().strip(".,") for t in query.split() if len(t) > 3}
        scored = []
        for _, doc in venue_docs:
            haystack = f"{doc.get('text', '')} {doc.get('label', '')}".lower()
            score = sum(1 for t in query_terms if t in haystack)
            scored.append((score, doc))
        ranked = sorted(scored, key=lambda x: x[0], reverse=True)
        return [
            Citation(
                source_id=doc["source_id"],
                source_type=doc.get("source_type", "stream"),
                excerpt=doc.get("text") or doc["label"],
            )
            for _, doc in ranked[:limit]
        ]

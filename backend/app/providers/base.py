from abc import ABC, abstractmethod
from dataclasses import dataclass
from enum import Enum


class ProviderMode(str, Enum):
    DETERMINISTIC = "deterministic"
    LLM = "llm"


# ── Memo provider ────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class MemoOutput:
    summary: str
    open_questions: list[str]
    provider: str
    mode: ProviderMode
    model: str | None = None


# ── Risk classifier provider ─────────────────────────────────────────────────

ALLOWED_RISK_TYPES = (
    "altercation_event",
    "premises_liability",
    "liquor_liability",
    "medical_emergency",
    "crowd_management",
    "property_damage",
    "general_incident",
)

ALLOWED_SEVERITIES = ("low", "medium", "high", "critical")


@dataclass(frozen=True)
class RiskClassification:
    """Base classification produced *before* hard-signal escalation.

    The runtime applies injury/police/EMS escalation on top of this — those are
    deterministic gates we don't want a model to decide.
    """
    risk_type: str
    base_severity: str
    base_confidence: float
    rationale: str
    provider: str
    mode: ProviderMode
    model: str | None = None


class RiskClassifierProvider(ABC):
    """Classifies an incident into (risk_type, base_severity, base_confidence)."""

    @property
    @abstractmethod
    def provider_name(self) -> str: ...

    @property
    @abstractmethod
    def mode(self) -> ProviderMode: ...

    @abstractmethod
    def classify(
        self,
        *,
        incident_summary: str,
        incident_location: str,
        citation_excerpts: list[str],
    ) -> RiskClassification: ...


# ── Transcription provider (audio → text) ────────────────────────────────────

@dataclass(frozen=True)
class TranscriptionOutput:
    text: str
    language: str | None
    duration_seconds: float | None
    provider: str
    mode: ProviderMode
    model: str | None = None


class TranscriptionProvider(ABC):
    """Transcribes an audio file to text.

    Used downstream of the evidence-upload flow when an audio MIME type is
    received. The interface is provider-agnostic so we can swap OpenAI for
    AssemblyAI / Deepgram / on-device without touching callers.
    """

    @property
    @abstractmethod
    def provider_name(self) -> str: ...

    @property
    @abstractmethod
    def mode(self) -> ProviderMode: ...

    @abstractmethod
    def transcribe(self, *, file_path: str, content_type: str) -> TranscriptionOutput: ...


# ── Embedding provider (text → vector) ───────────────────────────────────────

@dataclass(frozen=True)
class EmbeddingOutput:
    vectors: list[list[float]]
    dimensions: int
    provider: str
    mode: ProviderMode
    model: str | None = None


class EmbeddingProvider(ABC):
    """Encodes texts as fixed-length float vectors for semantic search.

    Replaces TF-IDF in the retriever once corpus size justifies the swap.
    See ADR / Phase 3 notes in app/rag.py — the SemanticKnowledgeBase interface
    is designed to accept either path.
    """

    @property
    @abstractmethod
    def provider_name(self) -> str: ...

    @property
    @abstractmethod
    def mode(self) -> ProviderMode: ...

    @property
    @abstractmethod
    def dimensions(self) -> int: ...

    @abstractmethod
    def embed(self, texts: list[str]) -> EmbeddingOutput: ...


class MemoProvider(ABC):
    """
    Abstract interface for underwriting memo drafting.

    Implementations must be bounded and auditable:
    - They receive only structured, validated findings — not raw user input.
    - Their output is stored as draft text, not as a compliance decision.
    - The rubric engine and citation validator run before and independently of this layer.
    """

    @property
    @abstractmethod
    def provider_name(self) -> str: ...

    @property
    @abstractmethod
    def mode(self) -> ProviderMode: ...

    @abstractmethod
    def draft_memo(
        self,
        *,
        incident_summary: str,
        incident_location: str,
        risk_type: str,
        severity: str,
        confidence: float,
        citation_excerpts: list[str],
        open_questions: list[str] | None = None,
    ) -> MemoOutput: ...

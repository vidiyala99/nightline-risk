from typing import List, Optional
from pydantic import BaseModel, Field
from sqlmodel import SQLModel, Field as SQLField, create_engine, Session, select
from sqlalchemy import Column, JSON
from pgvector.sqlalchemy import Vector
import numpy as np

# --- VECTOR DATABASE MODELS ---

class KnowledgeSource(SQLModel, table=True):
    """
    Stores insurance policies, case law, and venue-specific rules.
    Used for RAG context in Phase 2.
    """
    id: Optional[int] = SQLField(default=None, primary_key=True)
    venue_id: str = SQLField(index=True)
    content: str
    source_type: str  # e.g., "policy", "case_law", "handbook"
    # We'll use 1536 dimensions (standard for OpenAI embeddings)
    embedding: List[float] = SQLField(sa_column=Column(Vector(1536)))
    metadata: dict = SQLField(default_factory=dict, sa_column=Column(JSON))

class VenueKnowledgeBase:
    """
    Interface for storing and retrieving knowledge from pgvector.
    Note: Embedding generation is mocked until API keys are available.
    """
    def __init__(self, session: Session):
        self.session = session

    def add_document(self, venue_id: str, content: str, source_type: str, metadata: dict = {}):
        # Mock embedding (1536 zeros) since we don't have API keys yet.
        mock_embedding = [0.0] * 1536
        
        doc = KnowledgeSource(
            venue_id=venue_id,
            content=content,
            source_type=source_type,
            embedding=mock_embedding,
            metadata=metadata
        )
        self.session.add(doc)
        self.session.commit()

    def search(self, venue_id: str, query_text: str, limit: int = 5):
        """
        In Phase 2, this will use vector similarity. 
        For now, it's a placeholder for the agentic mesh.
        """
        statement = select(KnowledgeSource).where(KnowledgeSource.venue_id == venue_id).limit(limit)
        return self.session.exec(statement).all()

import re
from typing import List, Dict

def chunk_policy_text(text: str) -> List[Dict]:
    """
    Intelligently splits a Markdown policy into clauses with metadata.
    """
    chunks = []
    # Split by section (##)
    sections = re.split(r'\n## ', text)
    
    for section in sections:
        # Extract section title
        section_match = re.search(r'^([^\n]+)', section)
        if not section_match:
            continue
        section_title = section_match.group(1).strip()
        
        # Split section into clauses (###)
        clauses = re.split(r'\n### ', section)
        
        # The first part of the split is the text BEFORE the first ### (usually the section header)
        # We skip it to avoid duplicates
        for clause in clauses[1:]:
            clause_match = re.search(r'^([^\n]+)', clause)
            if not clause_match:
                continue
            clause_title = clause_match.group(1).strip()
            content = clause.strip()
            
            # Extract metadata
            is_exclusion = "EXCLUSION" in section_title.upper() or "EXCLUSION" in clause_title.upper()
            
            chunks.append({
                "content": f"{section_title} > {content}",
                "metadata": {
                    "section": section_title,
                    "clause_id": clause_title.split(' ')[0],
                    "is_exclusion": is_exclusion,
                    "source_file": "nightlife_liability_2026.md"
                }
            })
    return chunks

def run_ingestion():
    from app.database import get_session
    from app.rag_v2 import VenueKnowledgeBase

    with open("docs/policies/nightlife_liability_2026.md", "r") as f:
        policy_text = f.read()
    
    chunks = chunk_policy_text(policy_text)
    print(f"📄 Found {len(chunks)} policy clauses. Processing...")
    
    with next(get_session()) as session:
        kb = VenueKnowledgeBase(session)
        for chunk in chunks:
            kb.add_document(
                venue_id="elsewhere-brooklyn",
                content=chunk["content"],
                source_type="policy",
                metadata=chunk["metadata"]
            )
            print(f"  -> Ingested: {chunk['metadata']['clause_id']}")
    
    print("✅ Policy ingestion complete.")

if __name__ == "__main__":
    run_ingestion()

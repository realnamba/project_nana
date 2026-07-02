import lancedb
import pyarrow as pa
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, List
from app.config import DATA_DIR

logger = logging.getLogger(__name__)

LANCE_DB_DIR = DATA_DIR / "memory.lance"

class LanceService:
    def __init__(self):
        self._db = None
        self._table = None
        self._model = None

    def _get_model(self):
        if self._model is None:
            from sentence_transformers import SentenceTransformer
            # SentenceTransformer uses all-MiniLM-L6-v2 by default
            logger.info("Loading SentenceTransformer model 'all-MiniLM-L6-v2'...")
            self._model = SentenceTransformer("all-MiniLM-L6-v2")
            logger.info("✓ SentenceTransformer model loaded successfully.")
        return self._model

    def initialize(self):
        """Initialize LanceDB connection and ensure table exists."""
        try:
            LANCE_DB_DIR.mkdir(parents=True, exist_ok=True)
            self._db = lancedb.connect(str(LANCE_DB_DIR))
            
            # Schema: id, text, type ('fact' | 'summary'), vector (384), timestamp, source_session
            schema = pa.schema([
                pa.field("id", pa.string()),
                pa.field("text", pa.string()),
                pa.field("type", pa.string()),
                pa.field("vector", pa.list_(pa.float32(), 384)),
                pa.field("timestamp", pa.string()),
                pa.field("source_session", pa.string())
            ])
            
            if "memories" in self._db.table_names():
                self._table = self._db.open_table("memories")
            else:
                self._table = self._db.create_table("memories", schema=schema)
            logger.info("✓ LanceDB initialized at %s", LANCE_DB_DIR)
        except Exception as e:
            logger.error("Failed to initialize LanceDB: %s", e)

    def generate_embedding(self, text: str) -> List[float]:
        """Generate 384-dimensional vector embedding for text."""
        model = self._get_model()
        emb = model.encode(text)
        return emb.tolist()

    async def add_memory(self, entry_id: str, text: str, mem_type: str, source_session: str = "") -> None:
        """Insert or update a memory in LanceDB."""
        if self._table is None:
            self.initialize()
        if self._table is None:
            logger.warning("LanceDB table not initialized; skipping add_memory.")
            return

        try:
            vector = self.generate_embedding(text)
            now = datetime.now(timezone.utc).isoformat()
            
            # Delete existing if it has the same id
            self._table.delete(f"id = '{entry_id}'")
            
            # Insert the new record
            self._table.add([{
                "id": entry_id,
                "text": text,
                "type": mem_type,
                "vector": vector,
                "timestamp": now,
                "source_session": source_session
            }])
            logger.info("Saved memory to LanceDB: [%s] id=%s", mem_type, entry_id)
        except Exception as e:
            logger.error("Failed to add memory to LanceDB: %s", e)

    async def delete_memory(self, entry_id: str) -> None:
        """Delete a memory from LanceDB by its ID."""
        if self._table is None:
            self.initialize()
        if self._table is None:
            return
        try:
            self._table.delete(f"id = '{entry_id}'")
            logger.info("Deleted memory from LanceDB: id=%s", entry_id)
        except Exception as e:
            logger.error("Failed to delete memory from LanceDB: %s", e)

    async def clear_all(self) -> None:
        """Clear all records in LanceDB."""
        if self._table is None:
            self.initialize()
        if self._table is None:
            return
        try:
            self._table.delete("id != ''")
            logger.info("Cleared all memories from LanceDB.")
        except Exception as e:
            logger.error("Failed to clear LanceDB: %s", e)

    async def search_memories(self, query: str, limit: int = 5) -> List[dict]:
        """Search top-k semantically relevant memories."""
        if self._table is None:
            self.initialize()
        if self._table is None:
            return []
        try:
            vector = self.generate_embedding(query)
            res = self._table.search(vector).limit(limit).to_list()
            return res
        except Exception as e:
            logger.error("Failed semantic search in LanceDB: %s", e)
            return []

lance_service = LanceService()

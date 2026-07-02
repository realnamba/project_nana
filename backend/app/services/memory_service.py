"""
memory_service.py — SQLite-backed conversation storage.
Uses aiosqlite for async database access so we never block the event loop.
"""

# pyrefly: ignore [missing-import]
import aiosqlite
import uuid
import logging
from datetime import datetime, timezone
from typing import Optional
from app.config import DATABASE_PATH

logger = logging.getLogger(__name__)


class MemoryService:
    """Manages conversations and messages in SQLite."""

    def __init__(self):
        self.db_path = str(DATABASE_PATH)
        self._db: Optional[aiosqlite.Connection] = None

    async def initialize(self):
        """Create database and tables if they don't exist."""
        self._db = await aiosqlite.connect(self.db_path)
        self._db.row_factory = aiosqlite.Row

        # WAL mode = better concurrent read performance
        await self._db.execute("PRAGMA journal_mode=WAL")
        await self._db.execute("PRAGMA foreign_keys=ON")

        await self._db.executescript("""
            CREATE TABLE IF NOT EXISTS conversations (
                id          TEXT PRIMARY KEY,
                title       TEXT NOT NULL DEFAULT 'New Chat',
                created_at  TEXT NOT NULL,
                updated_at  TEXT NOT NULL
            );
 
            CREATE TABLE IF NOT EXISTS messages (
                id              TEXT PRIMARY KEY,
                conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
                role            TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
                content         TEXT NOT NULL,
                has_image       INTEGER DEFAULT 0,
                image_analysis  TEXT,
                model_used      TEXT,
                created_at      TEXT NOT NULL
            );
 
            CREATE TABLE IF NOT EXISTS user_facts (
                key         TEXT PRIMARY KEY,
                value       TEXT NOT NULL,
                updated_at  TEXT NOT NULL
            );
 
            CREATE INDEX IF NOT EXISTS idx_messages_conv
                ON messages(conversation_id, created_at);
        """)
        cols = await self._db.execute_fetchall("PRAGMA table_info(messages)")
        if cols and "mode" not in [c[1] for c in cols]:
            await self._db.execute("ALTER TABLE messages ADD COLUMN mode TEXT NOT NULL DEFAULT 'chat'")
        await self._db.commit()
        logger.info("Database initialized at %s", self.db_path)

    async def create_conversation(self, title: str = "New Chat") -> str:
        """Create a new conversation and return its ID."""
        conv_id = str(uuid.uuid4())
        now = datetime.now(timezone.utc).isoformat()
        await self._db.execute(
            "INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
            (conv_id, title, now, now)
        )
        await self._db.commit()
        return conv_id

    async def conversation_exists(self, conversation_id: str) -> bool:
        rows = await self._db.execute_fetchall(
            "SELECT 1 FROM conversations WHERE id = ? LIMIT 1",
            (conversation_id,),
        )
        return bool(rows)

    async def set_conversation_title(self, conversation_id: str, title: str) -> None:
        now = datetime.now(timezone.utc).isoformat()
        await self._db.execute(
            "UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?",
            (title, now, conversation_id),
        )
        await self._db.commit()

    async def add_message(
        self,
        conversation_id: str,
        role: str,
        content: str,
        has_image: bool = False,
        image_analysis: Optional[str] = None,
        model_used: Optional[str] = None,
        mode: str = "chat",
    ) -> str:
        """Add a message to a conversation. Returns message ID."""
        msg_id = str(uuid.uuid4())
        now = datetime.now(timezone.utc).isoformat()

        await self._db.execute(
            """INSERT INTO messages
               (id, conversation_id, role, content, has_image, image_analysis, model_used, created_at, mode)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (msg_id, conversation_id, role, content, int(has_image), image_analysis, model_used, now, mode)
        )
        # Update conversation timestamp and auto-title from first user message
        await self._db.execute(
            "UPDATE conversations SET updated_at = ? WHERE id = ?",
            (now, conversation_id)
        )

        # Auto-title: use first 50 chars of first user message
        if role == "user":
            row = await self._db.execute_fetchall(
                "SELECT COUNT(*) as cnt FROM messages WHERE conversation_id = ? AND role = 'user'",
                (conversation_id,)
            )
            if row and row[0][0] == 1:
                prefix = "Station: " if mode == "station" else ""
                max_len = 50 - len(prefix)
                title = prefix + content[:max_len] + ("..." if len(content) > max_len else "")
                await self._db.execute(
                    "UPDATE conversations SET title = ? WHERE id = ?",
                    (title, conversation_id)
                )

        await self._db.commit()
        return msg_id

    async def get_context_messages(self, conversation_id: str, limit: int = 10) -> list[dict]:
        """
        Get the last N messages for context window.
        Returns list of {role, content} dicts suitable for prompt building.
        """
        rows = await self._db.execute_fetchall(
            """SELECT role, content, image_analysis
               FROM messages
               WHERE conversation_id = ?
               ORDER BY created_at DESC
               LIMIT ?""",
            (conversation_id, limit)
        )
        messages = []
        for row in reversed(rows):  # Reverse to get chronological order
            msg = {"role": row[0], "content": row[1]}
            messages.append(msg)
        return messages

    async def list_conversations(self) -> list[dict]:
        """List all conversations, newest first."""
        rows = await self._db.execute_fetchall(
            """SELECT c.id, c.title, c.created_at, c.updated_at,
                      COUNT(m.id) as message_count
               FROM conversations c
               LEFT JOIN messages m ON m.conversation_id = c.id
               GROUP BY c.id
               ORDER BY c.updated_at DESC"""
        )
        return [
            {
                "id": r[0], "title": r[1], "created_at": r[2],
                "updated_at": r[3], "message_count": r[4]
            }
            for r in rows
        ]

    async def get_conversation_messages(self, conversation_id: str) -> list[dict]:
        """Get all messages in a conversation."""
        rows = await self._db.execute_fetchall(
            """SELECT id, role, content, has_image, image_analysis, model_used, created_at, mode
               FROM messages
               WHERE conversation_id = ?
               ORDER BY created_at ASC""",
            (conversation_id,)
        )
        return [
            {
                "id": r[0], "role": r[1], "content": r[2],
                "has_image": bool(r[3]), "image_analysis": r[4],
                "model_used": r[5], "created_at": r[6], "mode": r[7]
            }
            for r in rows
        ]

    async def get_all_facts(self) -> dict[str, str]:
        if not self._db:
            return {}
        rows = await self._db.execute_fetchall("SELECT key, value FROM user_facts")
        return {r[0]: r[1] for r in rows}

    async def update_fact(self, key: str, value: str):
        if not self._db:
            return
        now = datetime.now(timezone.utc).isoformat()
        await self._db.execute(
            "INSERT OR REPLACE INTO user_facts (key, value, updated_at) VALUES (?, ?, ?)",
            (key, value, now)
        )
        await self._db.commit()

    async def clear_all_facts(self):
        if not self._db:
            return
        await self._db.execute("DELETE FROM user_facts")
        await self._db.commit()

    async def delete_conversation(self, conversation_id: str):
        """Delete a conversation and all its messages."""
        await self._db.execute("DELETE FROM conversations WHERE id = ?", (conversation_id,))
        await self._db.commit()

    async def close(self):
        """Close database connection."""
        if self._db:
            await self._db.close()


# Singleton
memory = MemoryService()

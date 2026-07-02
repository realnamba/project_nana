"""
user_memory_service.py — Lightweight user memory storage and LLM-driven extraction.
"""

import json
import logging
import re
import asyncio
from datetime import datetime
from pathlib import Path
from typing import Any, Dict

from app.config import DATA_DIR
from app.services.llama_runtime import llama_runtime

logger = logging.getLogger(__name__)

MEMORY_DIR = DATA_DIR / "memory"
MEMORY_FILE = MEMORY_DIR / "user_memory.json"

_INITIAL_MEMORY = {
    "preferredName": "",
    "hobbies": "",
    "currentProjects": "",
    "workStudy": "",
    "modelPreferences": "",
    "appPreferences": "",
    "repeatedGoals": ""
}

_MAX_FIELD_CHARS = 180
_MAX_SUMMARY_CHARS = 600
_SENSITIVE_PATTERNS = [
    r"\bpassword\b",
    r"\bpassphrase\b",
    r"\bapi[-_\s]?key\b",
    r"\bsecret\b",
    r"\bprivate key\b",
    r"\bseed phrase\b",
    r"\brecovery phrase\b",
    r"\bcredit card\b",
    r"\bssn\b",
    r"\bsocial security\b",
    r"\bbank account\b",
    r"\brouting number\b",
    r"\bpassport\b",
    r"\b\d{3}-\d{2}-\d{4}\b",
]


def _looks_sensitive(value: str) -> bool:
    lowered = value.lower()
    return any(re.search(pattern, lowered) for pattern in _SENSITIVE_PATTERNS)


def _clean_fact(value: Any) -> str:
    cleaned = re.sub(r"\s+", " ", str(value or "")).strip()
    if not cleaned or _looks_sensitive(cleaned):
        return ""
    if len(cleaned) > _MAX_FIELD_CHARS:
        cleaned = cleaned[: _MAX_FIELD_CHARS - 3].rstrip() + "..."
    return cleaned


class UserMemoryService:
    def __init__(self):
        self._lock = asyncio.Lock()

    def get_memory(self) -> Dict[str, Any]:
        """Synchronous wrapper for get_memory_async."""
        try:
            return asyncio.run(self.get_memory_async())
        except Exception:
            return dict(_INITIAL_MEMORY)

    def update_memory(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """Synchronous wrapper for update_memory_async."""
        try:
            return asyncio.run(self.update_memory_async(data))
        except Exception:
            return dict(_INITIAL_MEMORY)

    def get_memory_summary(self) -> str:
        """Synchronous wrapper for get_memory_summary_async."""
        try:
            return asyncio.run(self.get_memory_summary_async())
        except Exception:
            return ""

    async def get_memory_async(self) -> Dict[str, Any]:
        """Load user memory facts from SQLite."""
        from app.services.memory_service import memory as db_memory
        try:
            facts = await db_memory.get_all_facts()
            merged = dict(_INITIAL_MEMORY)
            for k in _INITIAL_MEMORY:
                if k in facts:
                    merged[k] = facts[k]
            return merged
        except Exception as e:
            logger.error("Failed to load user memory from SQLite: %s", e)
            return dict(_INITIAL_MEMORY)

    async def update_memory_async(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """Update user memory in SQLite and LanceDB."""
        from app.services.memory_service import memory as db_memory
        from app.services.lance_service import lance_service

        current = await self.get_memory_async()
        mapping = {
            "preferredName": "Preferred Name",
            "hobbies": "Hobbies",
            "currentProjects": "Current Projects",
            "workStudy": "Work/Study",
            "modelPreferences": "Model Preferences",
            "appPreferences": "App Preferences",
            "repeatedGoals": "Repeated Goals"
        }
        for k in _INITIAL_MEMORY:
            if k in data:
                cleaned = _clean_fact(data[k])
                current[k] = cleaned
                # Write to SQLite
                await db_memory.update_fact(k, cleaned)
                # Write/Update in LanceDB (if non-empty)
                label = mapping.get(k, k)
                if cleaned:
                    await lance_service.add_memory(
                        entry_id=f"fact_{k}",
                        text=f"{label}: {cleaned}",
                        mem_type="fact"
                    )
                else:
                    await lance_service.delete_memory(f"fact_{k}")

        return current

    async def get_memory_summary_async(self) -> str:
        """Get a concise, single-line text summary of non-empty user facts."""
        mem = await self.get_memory_async()
        parts = []
        mapping = {
            "preferredName": "Preferred Name",
            "hobbies": "Hobbies",
            "currentProjects": "Current Projects",
            "workStudy": "Work/Study",
            "modelPreferences": "Model Preferences",
            "appPreferences": "App Preferences",
            "repeatedGoals": "Repeated Goals"
        }
        for k, label in mapping.items():
            val = _clean_fact(mem.get(k, ""))
            if val:
                parts.append(f"{label}: {val}")
        if not parts:
            return ""
        summary = "Known user memory: " + "; ".join(parts)
        if len(summary) > _MAX_SUMMARY_CHARS:
            summary = summary[:_MAX_SUMMARY_CHARS].rsplit("; ", 1)[0].rstrip()
        return summary

    async def clear_memory_async(self) -> None:
        """Clear all facts from SQLite and LanceDB."""
        from app.services.memory_service import memory as db_memory
        from app.services.lance_service import lance_service
        await db_memory.clear_all_facts()
        await lance_service.clear_all()

    async def generate_and_store_conversation_summary(self, conversation_id: str) -> None:
        """Summarize conversation history and embed it in LanceDB."""
        from app.services.memory_service import memory as db_memory
        from app.services.lance_service import lance_service

        if not llama_runtime.is_loaded:
            logger.debug("Local GGUF model not loaded; skipping summary extraction.")
            return

        # Fetch messages in conversation
        messages = await db_memory.get_conversation_messages(conversation_id)
        if len(messages) < 4:
            return  # Not enough dialogue to summarize

        # Format history for LLM
        history_parts = []
        for msg in messages:
            role = "User" if msg["role"] == "user" else "Assistant"
            history_parts.append(f"{role}: {msg['content']}")
        chat_history = "\n".join(history_parts)

        prompt = f"""You are a precise conversation summarizer. Summarize the following chat conversation into a single, concise paragraph of 2-3 sentences.
Focus on the main tasks, decisions, code updates, or facts discussed.
Do not include conversational filler or generic greetings.

Conversation:
{chat_history}

Summary:"""

        logger.info("Running background LLM conversation summarization...")
        try:
            summary = ""
            async for token in llama_runtime.generate_stream(
                prompt=prompt,
                temperature=0.3,
                max_tokens=150,
            ):
                summary += token

            summary = summary.strip()
            if len(summary) > 20:
                summary_id = f"summary_{conversation_id}_{int(datetime.now().timestamp())}"
                await lance_service.add_memory(
                    entry_id=summary_id,
                    text=summary,
                    mem_type="summary",
                    source_session=conversation_id
                )
                logger.info("Successfully saved conversation summary to LanceDB.")
        except Exception as e:
            logger.error("Failed to generate conversation summary: %s", e)

    async def extract_memory_from_chat(self, conversation_id: str) -> None:
        """Asynchronously extract updated user profile facts using the loaded GGUF model."""
        from app.services.memory_service import memory as db_memory

        if not llama_runtime.is_loaded:
            logger.debug("Local GGUF model not loaded; skipping memory extraction.")
            return

        async with self._lock:
            try:
                # Fetch recent messages (up to 8)
                messages = await db_memory.get_context_messages(conversation_id, limit=8)
                if len(messages) < 2:
                    return

                chat_history_parts = []
                for msg in messages:
                    role = "User" if msg["role"] == "user" else "Assistant"
                    chat_history_parts.append(f"{role}: {msg['content']}")
                chat_history = "\n".join(chat_history_parts)

                current_profile = await self.get_memory_async()
                current_profile_json = json.dumps(current_profile, indent=2)

                prompt = f"""You are a precise local user-memory extraction assistant. Analyze the conversation history between the User and the Assistant.
Extract only stable, useful facts the user clearly states or repeatedly expresses:
- preferred name
- hobbies
- ongoing projects
- work/study
- app preferences
- repeated goals

Additionally, if the user explicitly says "remember this", "memorize that", or "save this for next session", you MUST capture the relevant information into the appropriate category (e.g. repeatedGoals, hobbies, or currentProjects).

Do not save every message, one-off requests, temporary context, or guesses.
Do not include credentials, private identifiers, addresses, contact details, health/financial details, or other sensitive information unless the user explicitly asked Nana to remember that exact fact.
Keep each field short.

Current User Profile:
{current_profile_json}

Conversation History:
{chat_history}

Please output the UPDATED User Profile incorporating any new facts.
You must return ONLY the updated JSON object matching the exact keys as the Current User Profile.
If there are no changes, return the Current User Profile as-is.
Do not add markdown formatting or explanations. Output raw JSON ONLY.
"""

                logger.info("Running background LLM memory extraction for conversation %s...", conversation_id)
                
                full_response = ""
                async for token in llama_runtime.generate_stream(
                    prompt=prompt,
                    system="You are a precise JSON extractor. Output valid JSON only.",
                    temperature=0.1,
                    max_tokens=256,
                ):
                    full_response += token

                # Extract JSON using regex
                m = re.search(r"\{.*?\}", full_response, re.DOTALL)
                if m:
                    extracted_json = m.group(0)
                    try:
                        updates = json.loads(extracted_json)
                        if isinstance(updates, dict):
                            await self.update_memory_async(updates)
                            logger.info("Successfully updated local user memory profile: %s", updates)
                    except Exception as parse_err:
                        logger.warning("Failed to parse extracted memory JSON: %s", parse_err)
                        logger.debug("Raw extraction output was: %r", full_response)
                else:
                    logger.debug("No JSON block found in extraction response.")

            except Exception as e:
                logger.error("Background memory extraction failed: %s", e)


user_memory = UserMemoryService()  # singleton

"""
user_memory_service.py — Lightweight user memory storage and LLM-driven extraction.
"""

import json
import logging
import re
import asyncio
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
        """Load user memory from disk, initializing if necessary."""
        MEMORY_DIR.mkdir(parents=True, exist_ok=True)
        if not MEMORY_FILE.is_file():
            try:
                MEMORY_FILE.write_text(json.dumps(_INITIAL_MEMORY, indent=2), encoding="utf-8")
            except OSError as e:
                logger.error("Failed to create memory file: %s", e)
                return dict(_INITIAL_MEMORY)
        
        try:
            content = MEMORY_FILE.read_text(encoding="utf-8")
            data = json.loads(content)
            if isinstance(data, dict):
                # Ensure all initial keys are present
                merged = dict(_INITIAL_MEMORY)
                merged.update(data)
                return merged
        except Exception as e:
            logger.warning("Could not read user_memory.json (%s); using defaults", e)
        
        return dict(_INITIAL_MEMORY)

    def update_memory(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """Update user memory and save to disk."""
        current = self.get_memory()
        for k in _INITIAL_MEMORY:
            if k in data:
                current[k] = _clean_fact(data[k])
        
        try:
            MEMORY_DIR.mkdir(parents=True, exist_ok=True)
            MEMORY_FILE.write_text(json.dumps(current, indent=2), encoding="utf-8")
        except OSError as e:
            logger.error("Failed to write memory file: %s", e)
        
        return current

    def get_memory_summary(self) -> str:
        """Get a concise, single-line text summary of non-empty user facts."""
        mem = self.get_memory()
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

                current_profile = self.get_memory()
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
                            self.update_memory(updates)
                            logger.info("Successfully updated local user memory profile: %s", updates)
                    except Exception as parse_err:
                        logger.warning("Failed to parse extracted memory JSON: %s", parse_err)
                        logger.debug("Raw extraction output was: %r", full_response)
                else:
                    logger.debug("No JSON block found in extraction response.")

            except Exception as e:
                logger.error("Background memory extraction failed: %s", e)


user_memory = UserMemoryService()  # singleton

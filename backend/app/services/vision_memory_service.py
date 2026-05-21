"""
vision_memory_service.py - Manages per-chat vision memory and learns user corrections.
"""

import json
import logging
import asyncio
import re
from pathlib import Path
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from app.config import DATA_DIR
from app.services.llama_runtime import llama_runtime

logger = logging.getLogger(__name__)

MEMORY_DIR = DATA_DIR / "memory"

class VisionMemoryService:
    def __init__(self):
        self._lock = asyncio.Lock()

    def _get_memory_file(self) -> Path:
        MEMORY_DIR.mkdir(parents=True, exist_ok=True)
        return MEMORY_DIR / "vision_memory.json"

    def _load_memory(self) -> List[Dict[str, Any]]:
        mem_file = self._get_memory_file()
        if not mem_file.is_file():
            return []
        try:
            content = mem_file.read_text(encoding="utf-8")
            data = json.loads(content)
            if isinstance(data, list):
                return data
        except Exception as e:
            logger.warning("Could not read global vision memory: %s", e)
        return []

    def _save_memory(self, data: List[Dict[str, Any]]) -> None:
        try:
            mem_file = self._get_memory_file()
            mem_file.write_text(json.dumps(data, indent=2), encoding="utf-8")
        except OSError as e:
            logger.error("Failed to write global vision memory: %s", e)

    async def add_vision_memory(
        self, chat_id: str, image_id: str, user_message: str, summary: str
    ) -> None:
        async with self._lock:
            data = self._load_memory()
            now = datetime.now(timezone.utc).isoformat()
            new_entry = {
                "image_id": image_id,
                "timestamp": now,
                "user_message": user_message,
                "vision_summary": summary,
                "important_objects": [],
                "scene": "",
                "possible_context": "",
                "user_corrections": [],
                "tags": [],
                "source_chat_id": chat_id
            }
            data.append(new_entry)
            self._save_memory(data)
            logger.info("Added vision memory for image %s in chat %s", image_id, chat_id)

    async def get_recent_vision_context(self, chat_id: str, limit: int = 3) -> str:
        async with self._lock:
            data = self._load_memory()
            if not data:
                return ""
            
            recent = data[-limit:]
            parts = []
            for item in recent:
                source = "this session" if item.get("source_chat_id") == chat_id else "a previous session"
                base = f"Earlier in {source}, user uploaded an image.\nUser's message: {item.get('user_message')}\nVision summary: {item.get('vision_summary')}"
                corrections = item.get("user_corrections", [])
                if corrections:
                    corr_text = "\n".join(f"- {c}" for c in corrections)
                    base += f"\nIMPORTANT USER CORRECTIONS for this image:\n{corr_text}"
                parts.append(base)
            
            return "Recent image memory:\n" + "\n\n".join(parts)

    async def extract_and_update_corrections(self, conversation_id: str) -> None:
        from app.services.memory_service import memory as db_memory

        if not llama_runtime.is_loaded:
            return

        async with self._lock:
            try:
                data = self._load_memory()
                if not data:
                    return # No images globally to correct
                
                messages = await db_memory.get_context_messages(conversation_id, limit=8)
                if len(messages) < 2:
                    return

                chat_history_parts = []
                for msg in messages:
                    role = "User" if msg["role"] == "user" else "Assistant"
                    chat_history_parts.append(f"{role}: {msg['content']}")
                chat_history = "\n".join(chat_history_parts)

                current_vision_json = json.dumps(data[-3:], indent=2) # Only check recent 3 images for context length

                prompt = f"""You are a vision memory correction extractor. Analyze the conversation history.
Did the user explicitly correct any details about the previously uploaded images? Or did the user explicitly ask to "remember this" or "memorize that" regarding an image?
If they did, output the correction to append to that image's `user_corrections` array.

Current Recent Vision Memory:
{current_vision_json}

Conversation History:
{chat_history}

If a correction or new requested detail is found, output a JSON array of objects with `image_id` and `correction`.
Example: [{{"image_id": "img_abc123", "correction": "The character is actually Johnny Silverhand from Cyberpunk."}}]
If no corrections are found, output an empty array: []
Do not add markdown formatting or explanations. Output raw JSON ONLY.
"""
                full_response = ""
                async for token in llama_runtime.generate_stream(
                    prompt=prompt,
                    system="You are a JSON extractor. Output valid JSON array only.",
                    temperature=0.1,
                    max_tokens=256,
                ):
                    full_response += token

                m = re.search(r"\[.*\]", full_response, re.DOTALL)
                if m:
                    extracted_json = m.group(0)
                    try:
                        corrections = json.loads(extracted_json)
                        if isinstance(corrections, list) and len(corrections) > 0:
                            updated = False
                            for corr in corrections:
                                i_id = corr.get("image_id")
                                c_text = corr.get("correction")
                                if i_id and c_text:
                                    for entry in data:
                                        if entry.get("image_id") == i_id:
                                            entry.setdefault("user_corrections", []).append(c_text)
                                            updated = True
                            if updated:
                                self._save_memory(data)
                                logger.info("Updated vision memory corrections for chat %s", conversation_id)
                    except Exception as parse_err:
                        logger.warning("Failed to parse vision correction JSON: %s", parse_err)
            except Exception as e:
                logger.error("Vision memory extraction failed: %s", e)

vision_memory = VisionMemoryService()

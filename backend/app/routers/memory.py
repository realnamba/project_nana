"""
memory.py — Conversation history API router.
CRUD operations for conversations and messages.
"""

import asyncio
import json
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from app.config import DATA_DIR
from app.services.memory_service import memory

router = APIRouter(prefix="/api", tags=["memory"])

STATION_DIR = DATA_DIR / "station"
STATION_SESSIONS_FILE = STATION_DIR / "station_sessions.json"


class StationConversationSaveRequest(BaseModel):
    conversation_id: Optional[str] = None
    prompt: str
    has_image: bool = False
    vision_summary: Optional[str] = None
    responses: list[dict[str, Any]] = Field(default_factory=list)
    final_summary: str
    selected_models: list[dict[str, Any]] = Field(default_factory=list)


def _load_station_sessions() -> dict[str, list[dict[str, Any]]]:
    STATION_DIR.mkdir(parents=True, exist_ok=True)
    if not STATION_SESSIONS_FILE.is_file():
        return {}
    try:
        data = json.loads(STATION_SESSIONS_FILE.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _save_station_sessions(data: dict[str, list[dict[str, Any]]]) -> None:
    STATION_DIR.mkdir(parents=True, exist_ok=True)
    STATION_SESSIONS_FILE.write_text(json.dumps(data, indent=2), encoding="utf-8")


def _station_title(prompt: str) -> str:
    prefix = "Station: "
    max_len = 50 - len(prefix)
    return prefix + prompt[:max_len] + ("..." if len(prompt) > max_len else "")


def _council_message(responses: list[dict[str, Any]]) -> str:
    if not responses:
        return ""
    lines = ["Council discussion:"]
    for r in responses:
        name = r.get("model_name") or "Model"
        round_num = r.get("round")
        opinion = r.get("opinion") or r.get("raw") or ""
        confidence = r.get("confidence")
        prefix = f"[R{round_num} {name}]" if round_num else f"[{name}]"
        suffix = f" ({confidence}/10)" if confidence else ""
        lines.append(f"{prefix} {opinion}{suffix}")
    return "\n".join(lines)


@router.get("/conversations")
async def list_conversations():
    """List all conversations, newest first."""
    conversations = await memory.list_conversations()
    return {"conversations": conversations}


@router.post("/conversations/station")
async def save_station_conversation(req: StationConversationSaveRequest):
    """Save a Station run in the normal conversation store plus structured side-log data."""
    conversation_id = req.conversation_id
    if not conversation_id or not await memory.conversation_exists(conversation_id):
        conversation_id = await memory.create_conversation(_station_title(req.prompt))

    await memory.set_conversation_title(conversation_id, _station_title(req.prompt))

    now = datetime.now(timezone.utc).isoformat()
    session = {
        "id": f"station_{uuid.uuid4().hex[:10]}",
        "timestamp": now,
        "mode": "station",
        "user_prompt": req.prompt,
        "has_image": req.has_image,
        "uploaded_image_reference": "attached-image" if req.has_image else None,
        "vision_summary": req.vision_summary or "",
        "responses": req.responses,
        "nana_final_summary": req.final_summary,
        "selected_models": req.selected_models,
    }
    sessions = _load_station_sessions()
    sessions.setdefault(conversation_id, []).append(session)
    _save_station_sessions(sessions)

    await memory.add_message(
        conversation_id=conversation_id,
        role="user",
        content=req.prompt,
        has_image=req.has_image,
        image_analysis=req.vision_summary,
        model_used="station",
        mode="station",
    )
    council = _council_message(req.responses)
    if council:
        await memory.add_message(
            conversation_id=conversation_id,
            role="assistant",
            content=council,
            model_used="station-council",
            mode="station",
        )
    await memory.add_message(
        conversation_id=conversation_id,
        role="assistant",
        content=req.final_summary,
        model_used="station",
        mode="station",
    )

    if req.vision_summary:
        from app.services.vision_memory_service import vision_memory
        image_id = f"station_{uuid.uuid4().hex[:8]}"
        await vision_memory.add_vision_memory(
            chat_id=conversation_id,
            image_id=image_id,
            user_message=req.prompt,
            summary=req.vision_summary,
        )

    from app.services.user_memory_service import user_memory
    asyncio.create_task(user_memory.extract_memory_from_chat(conversation_id))
    return {"ok": True, "conversation_id": conversation_id, "session": session}


@router.get("/conversations/{conversation_id}/station")
async def get_station_conversation(conversation_id: str):
    sessions = _load_station_sessions()
    return {"conversation_id": conversation_id, "sessions": sessions.get(conversation_id, [])}


@router.get("/conversations/{conversation_id}")
async def get_conversation(conversation_id: str):
    """Get all messages in a specific conversation."""
    messages = await memory.get_conversation_messages(conversation_id)
    if not messages:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return {"conversation_id": conversation_id, "messages": messages}


@router.delete("/conversations/{conversation_id}")
async def delete_conversation(conversation_id: str):
    """Delete a conversation and all its messages."""
    await memory.delete_conversation(conversation_id)
    return {"status": "deleted", "conversation_id": conversation_id}


@router.get("/memory/user")
async def get_user_memory():
    """Retrieve user memory profile (facts + semantic memories)."""
    from app.services.user_memory_service import user_memory
    from app.services.lance_service import lance_service
    import logging
    logger = logging.getLogger("nana")
    
    facts = await user_memory.get_memory_async()
    semantic_list = []
    try:
        if lance_service._table is not None:
            res = lance_service._table.search().limit(100).to_list()
            for r in res:
                r.pop("vector", None)
                semantic_list.append(r)
    except Exception as e:
        logger.error("Failed to read semantic list: %s", e)
        
    return {
        "facts": facts,
        "semantic": semantic_list
    }


@router.post("/memory/user")
async def update_user_memory(data: dict):
    """Update the lightweight user memory profile."""
    from app.services.user_memory_service import user_memory
    facts = await user_memory.update_memory_async(data)
    return {"facts": facts}


@router.post("/memory/clear")
async def clear_all_memories():
    """Clear all memories from SQLite and LanceDB."""
    from app.services.user_memory_service import user_memory
    await user_memory.clear_memory_async()
    return {"ok": True}

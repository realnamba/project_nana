"""
station.py — Station (AI Council) router.
Sequential multi-model voting: each model gives an opinion, then Nana votes.
"""

import logging
import json
import re
import uuid
import asyncio
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.config import DATA_DIR, STANDALONE_N_CTX, STANDALONE_N_GPU_LAYERS, STANDALONE_N_THREADS
from app.services.llama_runtime import llama_runtime
from app.services.memory_service import memory
from app.services.model_manager import model_manager
from app.services.user_memory_service import user_memory
from app.services.vision_memory_service import vision_memory
from app.services.vision_pipeline import analyze_screenshot

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/station", tags=["station"])

COUNCIL_SYSTEM = (
    "You are a blunt, critical council member giving your honest expert opinion. "
    "Be casual and direct. You may strongly disagree, call weak ideas weak, and explain why. "
    "Do not be hateful or insulting toward protected classes. Stay useful. "
    "Keep the whole response short, ideally 120-180 tokens. "
    "Given the user's question, respond in this EXACT format:\n"
    "OPINION: (your analysis in 1-2 concise sentences)\n"
    "ACTION: (your recommended action in 1 sentence)\n"
    "CONFIDENCE: (a number from 1 to 10)\n"
    "Do NOT add any other text outside this format."
)

VOTE_SYSTEM = (
    "You are Nana, the lead AI assistant. Multiple council members have given their opinions. "
    "Review all opinions below and provide:\n"
    "1. A brief SUMMARY of the discussion\n"
    "2. The BEST RECOMMENDATION (pick the strongest answer)\n"
    "3. Your FINAL ANSWER to the user's original question\n"
    "Be concise and decisive."
)

STATION_DIR = DATA_DIR / "station"
STATION_SESSIONS_FILE = STATION_DIR / "station_sessions.json"


class AskRequest(BaseModel):
    prompt: str
    model_path: str = Field(..., description="Relative path to model under models dir")
    vision_context: Optional[str] = None


class AnalyzeImageRequest(BaseModel):
    prompt: str
    image_base64: str


class VisionContextRequest(BaseModel):
    prompt: str


class CouncilResponse(BaseModel):
    model_name: str
    opinion: str = ""
    action: str = ""
    confidence: int = 0
    raw: str = ""


class VoteRequest(BaseModel):
    prompt: str
    responses: List[CouncilResponse]
    vision_context: Optional[str] = None


class StationSessionRequest(BaseModel):
    conversation_id: Optional[str] = None
    prompt: str
    has_image: bool = False
    vision_summary: Optional[str] = None
    responses: List[dict[str, Any]] = Field(default_factory=list)
    final_summary: str
    selected_models: List[dict[str, Any]] = Field(default_factory=list)


def _load_station_sessions() -> dict[str, list[dict[str, Any]]]:
    STATION_DIR.mkdir(parents=True, exist_ok=True)
    if not STATION_SESSIONS_FILE.is_file():
        return {}
    try:
        data = json.loads(STATION_SESSIONS_FILE.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        logger.warning("Could not read Station sessions file.")
        return {}


def _save_station_sessions(data: dict[str, list[dict[str, Any]]]) -> None:
    STATION_DIR.mkdir(parents=True, exist_ok=True)
    STATION_SESSIONS_FILE.write_text(json.dumps(data, indent=2), encoding="utf-8")


def _resolve_model_path(model_path: str) -> Path:
    """Resolve relative model path to absolute path."""
    raw = (model_path or "").strip()
    if not raw:
        raise HTTPException(status_code=400, detail="model_path is required")
    try:
        resolved = model_manager._safe_resolve_under_models(raw)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
    if not resolved.is_file():
        raise HTTPException(status_code=404, detail=f"Model file not found: {raw}")
    rel = model_manager._to_relative_posix(resolved)
    entry = model_manager.get_entry_by_relative_path(rel)
    label = f"{rel} {entry.get('displayName', '') if entry else ''}".lower()
    if entry and entry.get("modelType") not in (None, "chat", "text", "reasoning", "code"):
        raise HTTPException(status_code=400, detail="Station only uses downloaded text, reasoning, or code models.")
    if "minicpm" in label:
        raise HTTPException(status_code=400, detail="MiniCPM-V is hidden vision support and is not a Station voter.")
    return resolved


def _prompt_mentions_images(prompt: str) -> bool:
    text = (prompt or "").lower()
    terms = ("image", "picture", "photo", "screenshot", "screen", "visual", "see", "look at")
    return any(term in text for term in terms)


async def _get_vision_context(prompt: str, explicit_context: Optional[str]) -> str:
    parts = []
    if explicit_context:
        parts.append(f"Current uploaded image context:\n{explicit_context.strip()}")
    if _prompt_mentions_images(prompt):
        recent = await vision_memory.get_recent_vision_context("station", limit=3)
        if recent:
            parts.append(recent)
    return "\n\n".join(parts)


def _apply_vision_context(prompt: str, vision_context: str) -> str:
    if not vision_context:
        return prompt
    return (
        f"Vision context:\n{vision_context}\n\n"
        f"User question: {prompt}"
    )


def _parse_council_response(raw: str) -> dict:
    """Parse structured OPINION/ACTION/CONFIDENCE from raw model output."""
    opinion = ""
    action = ""
    confidence = 5

    # Try structured parsing
    op_match = re.search(r"OPINION:\s*(.+?)(?=ACTION:|CONFIDENCE:|$)", raw, re.DOTALL | re.IGNORECASE)
    if op_match:
        opinion = op_match.group(1).strip()

    act_match = re.search(r"ACTION:\s*(.+?)(?=CONFIDENCE:|$)", raw, re.DOTALL | re.IGNORECASE)
    if act_match:
        action = act_match.group(1).strip()

    conf_match = re.search(r"CONFIDENCE:\s*(\d+)", raw, re.IGNORECASE)
    if conf_match:
        confidence = min(10, max(1, int(conf_match.group(1))))

    # Fallback: if no structured match, use raw as opinion
    if not opinion:
        opinion = raw.strip()[:500]

    return {"opinion": opinion, "action": action, "confidence": confidence}


@router.post("/analyze-image")
async def analyze_station_image(req: AnalyzeImageRequest):
    """
    Use MiniCPM-V as hidden image support and save the result to vision memory.
    MiniCPM-V is not returned as a voting model.
    """
    try:
        image_prompt = (
            "Describe everything visible in the image clearly. Include objects, people, UI text, "
            "scene, layout, colors, possible context, and anything unusual. Be specific but concise. "
            f"The user asks: {req.prompt}"
        )
        summary, elapsed = await analyze_screenshot(req.image_base64, prompt=image_prompt)
        image_id = f"img_{uuid.uuid4().hex[:8]}"
        await vision_memory.add_vision_memory(
            chat_id="station",
            image_id=image_id,
            user_message=req.prompt,
            summary=summary,
        )
        return {"vision_context": summary, "image_id": image_id, "elapsed": elapsed}
    except Exception as e:
        logger.error("Station vision analysis failed: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/vision-context")
async def get_station_vision_context(req: VisionContextRequest):
    """Return saved vision memory context for Station without loading MiniCPM-V."""
    context = await _get_vision_context(req.prompt, None)
    return {"vision_context": context}


@router.post("/ask")
async def ask_council_member(req: AskRequest):
    """
    Load a specific model and ask it for an opinion on the prompt.
    Returns structured opinion, action, and confidence.
    """
    resolved = _resolve_model_path(req.model_path)
    model_name = resolved.stem

    try:
        # Load this model (unloads any previous)
        llama_runtime.load_model(
            model_path=str(resolved),
            n_ctx=min(STANDALONE_N_CTX, 2048),  # Keep context small for station
            n_threads=STANDALONE_N_THREADS,
            n_gpu_layers=STANDALONE_N_GPU_LAYERS,
        )

        vision_context = await _get_vision_context(req.prompt, req.vision_context)
        prompt = _apply_vision_context(req.prompt, vision_context)

        # Generate opinion
        raw = await llama_runtime.generate_full(
            prompt=prompt,
            system=COUNCIL_SYSTEM,
            temperature=0.7,
            max_tokens=180,
        )

        parsed = _parse_council_response(raw)
        return {
            "model_name": model_name,
            "opinion": parsed["opinion"],
            "action": parsed["action"],
            "confidence": parsed["confidence"],
            "raw": raw.strip(),
        }

    except Exception as e:
        logger.error("Station ask failed for %s: %s", model_name, e)
        raise HTTPException(status_code=500, detail=f"Model {model_name} failed: {str(e)}")


@router.post("/vote")
async def vote_on_responses(req: VoteRequest):
    """
    Using the currently loaded model, summarize all council opinions
    and produce a final voted answer.
    """
    if not llama_runtime.is_loaded:
        raise HTTPException(status_code=400, detail="No model is loaded for voting")

    if not req.responses:
        raise HTTPException(status_code=400, detail="No council responses to vote on")

    vision_context = await _get_vision_context(req.prompt, req.vision_context)

    # Build the summary prompt
    lines = []
    if vision_context:
        lines.append(f"Vision context:\n{vision_context}\n")
    lines.append(f'User question: "{req.prompt}"\n\nCouncil opinions:\n')
    for r in req.responses:
        lines.append(
            f"[{r.model_name}] (confidence {r.confidence}/10)\n"
            f"  Opinion: {r.opinion}\n"
            f"  Action: {r.action}\n"
        )
    lines.append("\nNow provide your final verdict.")

    summary_prompt = "\n".join(lines)

    try:
        raw = await llama_runtime.generate_full(
            prompt=summary_prompt,
            system=VOTE_SYSTEM,
            temperature=0.6,
            max_tokens=256,
        )
        return {
            "summary": raw.strip(),
            "voter_model": llama_runtime.loaded_model_name,
        }
    except Exception as e:
        logger.error("Station vote failed: %s", e)
        raise HTTPException(status_code=500, detail=f"Vote failed: {str(e)}")


@router.post("/session")
async def save_station_session(req: StationSessionRequest):
    """Persist a Station council session and mirror prompt/final answer into normal chat history."""
    conversation_id = req.conversation_id
    station_title = "Station: " + req.prompt[:41] + ("..." if len(req.prompt) > 41 else "")
    if not conversation_id or not await memory.conversation_exists(conversation_id):
        conversation_id = await memory.create_conversation(station_title)
    await memory.set_conversation_title(conversation_id, station_title)

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
    council_lines = ["Council discussion:"]
    for r in req.responses:
        round_num = r.get("round")
        name = r.get("model_name") or "Model"
        opinion = r.get("opinion") or r.get("raw") or ""
        confidence = r.get("confidence")
        prefix = f"[R{round_num} {name}]" if round_num else f"[{name}]"
        suffix = f" ({confidence}/10)" if confidence else ""
        council_lines.append(f"{prefix} {opinion}{suffix}")
    if len(council_lines) > 1:
        await memory.add_message(
            conversation_id=conversation_id,
            role="assistant",
            content="\n".join(council_lines),
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
        image_id = f"station_{uuid.uuid4().hex[:8]}"
        await vision_memory.add_vision_memory(
            chat_id=conversation_id,
            image_id=image_id,
            user_message=req.prompt,
            summary=req.vision_summary,
        )

    asyncio.create_task(user_memory.extract_memory_from_chat(conversation_id))
    return {"ok": True, "conversation_id": conversation_id, "session": session}


@router.get("/session/{conversation_id}")
async def get_station_session(conversation_id: str):
    sessions = _load_station_sessions()
    return {"conversation_id": conversation_id, "sessions": sessions.get(conversation_id, [])}

"""
chat.py — Chat API router.
Handles the main chat endpoint with SSE streaming.
"""

import json
import logging
from fastapi import APIRouter, Request
from sse_starlette.sse import EventSourceResponse
from app.models.schemas import ChatRequest
from app.services.orchestrator import process_chat


logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["chat"])


@router.post("/chat")
async def chat(request: ChatRequest):
    """
    Main chat endpoint. Returns Server-Sent Events (SSE) stream.

    The frontend connects via EventSource and receives tokens one at a time,
    giving a smooth "typing" experience.
    """

    async def event_generator():
        try:
            async for chunk in process_chat(
                message=request.message,
                conversation_id=request.conversation_id,
                image_b64=request.image_base64,
                model=request.model,
                models=request.models,
                council_mode=request.council_mode,
                workspace_context=request.workspace_context,
            ):
                yield {
                    "event": "token",
                    "data": json.dumps(chunk),
                }
        except Exception as e:
            logger.error("Stream error: %s", e)
            yield {
                "event": "token",
                "data": json.dumps({"token": f"\n\n⚠️ Stream error: {e}", "done": True}),
            }

    return EventSourceResponse(event_generator())


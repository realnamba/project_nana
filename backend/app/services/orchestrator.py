"""
orchestrator.py — Coordinates chat: memory, optional image note, local GGUF generation.
"""

import logging
import asyncio
import uuid
from pathlib import Path
from typing import AsyncGenerator, Optional

from app.services.llama_runtime import llama_runtime
from app.services.model_manager import model_manager
from app.services.vision_pipeline import analyze_screenshot
from app.services.memory_service import memory
from app.services.settings_service import load_settings
from app.services.persona_service import persona_service
from app.services.user_memory_service import user_memory
from app.services.vision_memory_service import vision_memory
from app.services.lance_service import lance_service
from app.routers import workspace
from app.config import (
    CODER_MAX_TOKENS,
    CODER_TEMPERATURE,
    SYSTEM_PROMPT,
    MAX_CONTEXT_MESSAGES,
    STANDALONE_N_CTX,
    STANDALONE_N_THREADS,
    STANDALONE_N_GPU_LAYERS,
)

logger = logging.getLogger(__name__)


def _resolve_generation_path(model: Optional[str]) -> Path:
    """Resolve relative model path (under models/) to an absolute Path."""
    settings = load_settings()
    rel = (model or "").strip() or settings.get("defaultModelPath") or settings.get("lastLoadedModel")
    if not rel:
        raise RuntimeError(
            "No model selected. Put .gguf files in the models folder, click Rescan, then pick a model."
        )
    normalized = rel.replace("\\", "/").lstrip("/")
    try:
        path = model_manager._safe_resolve_under_models(normalized)
    except Exception:
        path = None
    if path is None:
        model_manager.scan_models()
        try:
            path = model_manager._safe_resolve_under_models(normalized)
        except Exception:
            path = None
    if path is None:
        raise RuntimeError(f"Model path is invalid or outside the models folder: {rel}")
    if not path.is_file():
        model_manager.scan_models()
        if not path.is_file():
            raise RuntimeError(f"Model file not found (moved or deleted): {rel}")
    ok, reason = model_manager.validate_model_file(path)
    if not ok:
        raise RuntimeError(f"Model file not usable: {reason}")
    return path


async def process_chat(
    message: str,
    conversation_id: Optional[str] = None,
    image_b64: Optional[str] = None,
    model: Optional[str] = None,
    models: Optional[list[str]] = None,
    council_mode: bool = False,
    workspace_context: Optional[dict] = None,
    debug_mode: bool = False,
) -> AsyncGenerator[dict, None]:
    if not conversation_id:
        conversation_id = await memory.create_conversation()
        logger.info("Created new conversation: %s", conversation_id)

    try:
        image_analysis = None
        if image_b64:
            logger.info("Image attached - running MiniCPM-V background analyzer.")
            yield {"token": "🔍 *Analyzing image...*\n\n", "done": False, "conversation_id": conversation_id}
            try:
                image_prompt = (
                    "Describe everything visible in the image clearly. Include objects, people, UI text, "
                    "scene, layout, colors, possible context, and anything unusual. Be specific but concise. "
                    f"The user asks: {message}"
                )
                image_analysis, elapsed = await analyze_screenshot(image_b64, prompt=image_prompt)
                logger.info("Vision step done in %.1fs", elapsed)
                
                # Save to vision memory
                image_id = f"img_{uuid.uuid4().hex[:8]}"
                await vision_memory.add_vision_memory(
                    chat_id=conversation_id,
                    image_id=image_id,
                    user_message=message,
                    summary=image_analysis
                )
                
                if debug_mode:
                    yield {
                        "token": f"\n\n[DEBUG: Vision Output]\n{image_analysis}\n[/DEBUG]\n\n",
                        "done": False,
                        "conversation_id": conversation_id,
                    }
            except Exception as e:
                err = str(e)
                logger.error("Vision pipeline failed: %s", err)
                yield {"token": f"⚠️ {err}", "done": False, "conversation_id": conversation_id}
                await memory.add_message(
                    conversation_id=conversation_id,
                    role="assistant",
                    content=err,
                    model_used=None,
                )
                yield {"token": "", "done": True, "conversation_id": conversation_id}
                return

        await memory.add_message(
            conversation_id=conversation_id,
            role="user",
            content=message,
            has_image=bool(image_b64),
            image_analysis=image_analysis,
        )

        settings = load_settings()
        context_size = settings.get("contextSize", 4096)
        max_new_tokens = settings.get("maxNewTokens", 512)
        retrieval_depth = settings.get("memoryRetrievalDepth", 10)
        persona_enabled = True
        memory_enabled = True

        context_messages = await memory.get_context_messages(
            conversation_id, limit=6
        )

        prompt_parts = []
        for msg in context_messages[:-1]:
            prefix = "User" if msg["role"] == "user" else "Assistant"
            prompt_parts.append(f"{prefix}: {msg['content']}")

        if image_analysis:
            current_prompt = (
                f"The user uploaded an image. Vision analysis says: {image_analysis}\n\n"
                f"User asks: {message}\n\n"
                f"Answer naturally and helpfully."
            )
        else:
            current_prompt = message

        if workspace_context:
            file_path = workspace_context.get("path", "unknown")
            file_content = workspace_context.get("content", "")
            if len(file_content) > 10000:
                file_content = file_content[:10000] + "\n...[TRUNCATED FOR LENGTH]..."
            current_prompt = (
                f"[WORKSPACE CONTEXT: The user is currently viewing the following file in their editor:\n"
                f"File path: {file_path}\n"
                f"Content:\n```\n{file_content}\n```]\n\n"
                f"{current_prompt}"
            )

        prompt_parts.append(f"User: {current_prompt}")
        prompt_parts.append("Assistant:")
        full_prompt = "\n\n".join(prompt_parts)

        if not llama_runtime.is_available:
            err = "llama-cpp-python is not installed. Cannot run local inference."
            logger.error(err)
            yield {"token": f"\n\n⚠️ {err}", "done": False, "conversation_id": conversation_id}
            await memory.add_message(
                conversation_id=conversation_id,
                role="assistant",
                content=err,
                model_used=None,
            )
            yield {"token": "", "done": True, "conversation_id": conversation_id}
            return

        model_list = models if (council_mode and models) else [model]
        all_responses = []

        for current_model_req in model_list:
            try:
                gguf_path = _resolve_generation_path(current_model_req)
            except Exception as e:
                logger.error("Model resolution failed for %s: %s", current_model_req, e)
                yield {"token": f"\n\n⚠️ {e}", "done": False, "conversation_id": conversation_id}
                continue

            rel_key = model_manager._to_relative_posix(gguf_path)
            # Prettify display name
            display_name = rel_key.split("/")[-1].replace(".gguf", "")
            display_name = display_name.replace("-", " ").replace("_", " ").title()

            logger.info("Streaming from local GGUF: %s", rel_key)

            # Build system prompt dynamically
            if persona_enabled:
                system_prompt = persona_service.build_system_prompt()
            else:
                system_prompt = SYSTEM_PROMPT

            if memory_enabled:
                system_prompt += "\n\nCRITICAL: You have access to persistent memory from previous sessions. Always use the memory facts below to answer questions about past sessions or the user's details. Do NOT say you cannot remember previous sessions."
                mem_summary = await user_memory.get_memory_summary_async()
                if mem_summary:
                    system_prompt = f"{system_prompt}\n\n{mem_summary}"
                
                # Semantic search in LanceDB
                semantic_results = await lance_service.search_memories(message, limit=retrieval_depth)
                if semantic_results:
                    memory_lines = [f"- {item['text']}" for item in semantic_results]
                    semantic_context = "Relevant recalled contexts:\n" + "\n".join(memory_lines)
                    system_prompt = f"{system_prompt}\n\n{semantic_context}"
                    
            # Inject recent vision context
            recent_vision = await vision_memory.get_recent_vision_context(conversation_id)
            if recent_vision:
                system_prompt = f"{system_prompt}\n\n{recent_vision}"
                
            # Inject Workspace Tool capabilities
            if workspace.ACTIVE_WORKSPACE:
                workspace_tools_prompt = """
You are a coding agent with access to a local workspace. You can use the following XML tags to execute actions. 
If you want to use a tool, output ONLY the XML block and stop. The system will reply with the result.

<searchFiles>your text query</searchFiles>
<readFile>path/to/file</readFile>
<runTerminal>your terminal command</runTerminal>

To propose a code change to the user, use:
<proposeChange path="path/to/file">
[Write the full replacement content here]
</proposeChange>

Never try to guess the content of large files. Use <readFile> to inspect them first.
Wait for the user to approve <proposeChange> before assuming it's applied.
"""
                system_prompt += f"\n\n{workspace_tools_prompt.strip()}"

            # Load model if context size differs or paths differ
            abs_str = str(gguf_path.resolve())
            n_ctx_differs = hasattr(llama_runtime, "_n_ctx") and llama_runtime._n_ctx != context_size
            if not llama_runtime.is_loaded or (llama_runtime._model_path and Path(llama_runtime._model_path).resolve() != gguf_path.resolve()) or n_ctx_differs:
                yield {
                    "token": f"⚡ *Switching to {display_name}...*\n\n" if council_mode else "⚡ *Loading GGUF model...*\n\n",
                    "done": False,
                    "conversation_id": conversation_id,
                    "model": display_name if council_mode else None
                }
                llama_runtime.load_model(
                    model_path=abs_str,
                    n_ctx=context_size,
                    n_threads=STANDALONE_N_THREADS,
                    n_gpu_layers=STANDALONE_N_GPU_LAYERS,
                )

            actual_vision = llama_runtime.is_loaded and getattr(llama_runtime._model, "chat_handler", None) is not None

            model_response_text = ""
            if actual_vision:
                messages_payload = []
                if system_prompt:
                    messages_payload.append({"role": "system", "content": system_prompt})
                
                for msg in context_messages[:-1]:
                    messages_payload.append({"role": msg["role"], "content": msg["content"]})
                    
                text_prompt = message
                if workspace_context:
                    file_path = workspace_context.get("path", "unknown")
                    file_content = workspace_context.get("content", "")
                    if len(file_content) > 10000:
                        file_content = file_content[:10000] + "\n...[TRUNCATED FOR LENGTH]..."
                    text_prompt = (
                        f"[WORKSPACE CONTEXT: The user is currently viewing the following file in their editor:\n"
                        f"File path: {file_path}\n"
                        f"Content:\n```\n{file_content}\n```]\n\n"
                        f"{text_prompt}"
                    )
                    
                if image_b64:
                    prefix = "data:image/jpeg;base64,"
                    if not image_b64.startswith("data:"):
                        img_url = f"{prefix}{image_b64}"
                    else:
                        img_url = image_b64
                        
                    messages_payload.append({
                        "role": "user",
                        "content": [
                            {"type": "image_url", "image_url": {"url": img_url}},
                            {"type": "text", "text": text_prompt}
                        ]
                    })
                else:
                    messages_payload.append({"role": "user", "content": text_prompt})

                async for token in llama_runtime.generate_chat_stream(
                    messages=messages_payload,
                    temperature=CODER_TEMPERATURE,
                    max_tokens=max_new_tokens,
                ):
                    model_response_text += token
                    yield {
                        "token": token,
                        "done": False,
                        "conversation_id": conversation_id,
                        "model": display_name if council_mode else None
                    }
            else:
                async for token in llama_runtime.generate_stream(
                    prompt=full_prompt,
                    system=system_prompt,
                    temperature=CODER_TEMPERATURE,
                    max_tokens=max_new_tokens,
                ):
                    model_response_text += token
                    yield {
                        "token": token,
                        "done": False,
                        "conversation_id": conversation_id,
                        "model": display_name if council_mode else None
                    }

            if council_mode:
                all_responses.append(f"### 👥 {display_name}\n\n{model_response_text.strip()}")
            else:
                all_responses.append(model_response_text)

        response_text = "\n\n---\n\n".join(all_responses)
        await memory.add_message(
            conversation_id=conversation_id,
            role="assistant",
            content=response_text,
            model_used=None if council_mode else rel_key,
        )

        yield {"token": "", "done": True, "conversation_id": conversation_id}
        logger.info("Chat completed. Response length: %d chars", len(response_text))

        # Trigger background memory extraction if enabled
        if memory_enabled:
            asyncio.create_task(user_memory.extract_memory_from_chat(conversation_id))
            asyncio.create_task(user_memory.generate_and_store_conversation_summary(conversation_id))
            asyncio.create_task(vision_memory.extract_and_update_corrections(conversation_id))

    except Exception as e:
        logger.error("Generation failed: %s", e)
        error_msg = f"\n\n⚠️ Generation error: {e}"
        yield {"token": error_msg, "done": False, "conversation_id": conversation_id}
        yield {"token": "", "done": True, "conversation_id": conversation_id}

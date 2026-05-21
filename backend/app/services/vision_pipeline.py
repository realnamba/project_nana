"""
vision_pipeline.py - Local image understanding for Nana.

MiniCPM-V is used as a hidden analyzer when installed. Its output is passed
to the selected text model as visual context; it is not a normal chat model.
"""

import logging
import time
from pathlib import Path

from app.config import STANDALONE_N_CTX, STANDALONE_N_GPU_LAYERS, STANDALONE_N_THREADS
from app.services.llama_runtime import LlamaRuntime
from app.services.model_manager import model_manager

logger = logging.getLogger(__name__)

VISION_MODEL_MISSING_MESSAGE = "Vision model is not installed yet. Download MiniCPM-V in Model Manager first."
VISION_RUNTIME_NOT_CONNECTED_MESSAGE = "MiniCPM-V is installed, but vision runtime failed to analyze this image."

_vision_runtime = LlamaRuntime()


def getVisionModelPackage():
    """Find the installed MiniCPM-V package directly from the active models folder."""
    root = Path(model_manager.get_models_root_abs()).resolve()
    model_manager.ensure_directories()

    main_names = {"minicpm-v.gguf", "model.gguf"}
    projector_names = {"mmproj.gguf", "projector.gguf"}
    main_candidates = sorted(
        [p for p in root.rglob("*.gguf") if p.name.lower() in main_names],
        key=lambda p: (p.name.lower() != "minicpm-v.gguf", "minicpm" not in str(p).lower(), str(p).lower()),
    )
    projector_candidates = sorted(
        [p for p in root.rglob("*.gguf") if p.name.lower() in projector_names],
        key=lambda p: (p.name.lower() != "mmproj.gguf", str(p).lower()),
    )

    def _checked(names: set[str]) -> str:
        return "; ".join(str(root / "**" / name) for name in sorted(names))

    if not main_candidates:
        raise RuntimeError(f"MiniCPM-V missing: main model not found (checked: {_checked(main_names)})")
    if not projector_candidates:
        raise RuntimeError(f"MiniCPM-V missing: mmproj not found (checked: {_checked(projector_names)})")

    for main_path in main_candidates:
        same_dir_projector = next((p for p in projector_candidates if p.parent == main_path.parent), None)
        if same_dir_projector:
            return {
                "main_model_path": str(main_path.resolve()),
                "mmproj_path": str(same_dir_projector.resolve()),
            }

    raise RuntimeError(
        "MiniCPM-V missing: main model and mmproj must be in the same folder "
        f"(main checked: {', '.join(str(p) for p in main_candidates)}; "
        f"mmproj checked: {', '.join(str(p) for p in projector_candidates)})"
    )


def get_ready_vision_package():
    try:
        return getVisionModelPackage()
    except RuntimeError:
        return model_manager.get_ready_vision_model()


def _vision_missing_message() -> str:
    try:
        getVisionModelPackage()
    except RuntimeError as e:
        return str(e)
    return VISION_RUNTIME_NOT_CONNECTED_MESSAGE


async def analyze_screenshot(
    image_b64: str,
    prompt: str = "Describe everything visible in the image clearly. Include objects, people, UI text, scene, layout, colors, possible context, and anything unusual. Be specific but concise.",
) -> tuple[str, float]:
    """Run MiniCPM-V as a background analyzer and return concise visual context."""
    start = time.time()
    try:
        vision_entry = getVisionModelPackage()
    except RuntimeError as e:
        raise RuntimeError(str(e))

    if not _vision_runtime.is_available:
        raise RuntimeError(VISION_RUNTIME_NOT_CONNECTED_MESSAGE)

    main_model_path = vision_entry.get("main_model_path") or vision_entry.get("filePath")
    mmproj_path = vision_entry.get("mmproj_path") or vision_entry.get("mmprojPath")
    if not main_model_path or not Path(main_model_path).is_file():
        raise RuntimeError(f"MiniCPM-V main model missing: {main_model_path or '(not registered)'}")
    if not mmproj_path or not Path(mmproj_path).is_file():
        raise RuntimeError(f"MiniCPM-V mmproj missing: {mmproj_path or '(not registered)'}")

    logger.info("Running MiniCPM-V vision analysis with %s and %s", main_model_path, mmproj_path)
    try:
        _vision_runtime.load_model(
            model_path=main_model_path,
            n_ctx=min(STANDALONE_N_CTX, 4096),
            n_threads=STANDALONE_N_THREADS,
            n_gpu_layers=STANDALONE_N_GPU_LAYERS,
        )
        if not getattr(_vision_runtime._model, "chat_handler", None):
            raise RuntimeError(VISION_RUNTIME_NOT_CONNECTED_MESSAGE)

        img_url = image_b64 if image_b64.startswith("data:") else f"data:image/jpeg;base64,{image_b64}"
        messages = [
            {
                "role": "user",
                "content": [
                    {"type": "image_url", "image_url": {"url": img_url}},
                    {"type": "text", "text": prompt},
                ],
            }
        ]
        chunks = []
        async for token in _vision_runtime.generate_chat_stream(
            messages=messages,
            temperature=0.2,
            max_tokens=220,
        ):
            chunks.append(token)
        text = "".join(chunks).strip()
        if not text:
            raise RuntimeError(VISION_RUNTIME_NOT_CONNECTED_MESSAGE)
        return text, time.time() - start
    finally:
        if _vision_runtime.is_loaded:
            _vision_runtime.unload_model()

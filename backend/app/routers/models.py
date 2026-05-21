"""
models.py — Local GGUF model discovery, load/unload, and folder actions.
"""

import logging
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.config import STANDALONE_N_CTX, STANDALONE_N_GPU_LAYERS, STANDALONE_N_THREADS
from app.services.llama_runtime import llama_runtime
from app.services.model_manager import model_manager
from app.services.settings_service import load_settings, save_settings, set_default_model_path, set_last_loaded_model
from app.utils.platform_folders import open_folder_in_explorer

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/models", tags=["models"])


class ImportRequest(BaseModel):
    file_path: str


class LoadModelRequest(BaseModel):
    """Relative path under models dir (posix) or absolute path under models root."""
    model_path: str = Field(..., description="e.g. qwen/model.gguf")


class SetDefaultRequest(BaseModel):
    model_path: Optional[str] = Field(None, description="Relative path, or null to clear")


class PullModelRequest(BaseModel):
    model_id: str


def _resolve_load_path(model_path: str) -> Path:
    raw = (model_path or "").strip()
    if not raw:
        raise HTTPException(status_code=400, detail="model_path is required")

    try:
        resolved = model_manager._safe_resolve_under_models(raw)
        return resolved
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("")
async def get_all_models():
    """All detected local GGUF models (uses last scan; refresh via /scan)."""
    items = model_manager.get_detected_models()
    settings = load_settings()
    return {
        "models": items,
        "modelsDirectory": model_manager.get_models_root_abs(),
        "settings": settings,
    }


@router.post("/scan")
async def rescan_models():
    """Rescan models folder recursively, recovering any new Ollama blobs first."""
    try:
        model_manager.recover_ollama_blobs()
        found = model_manager.scan_models()
    except Exception as e:
        logger.exception("scan failed")
        raise HTTPException(status_code=500, detail=str(e)) from e
    settings = load_settings()
    return {
        "ok": True,
        "count": len(found),
        "models": model_manager.get_detected_models(),
        "settings": settings,
    }


@router.post("/recover")
async def recover_models():
    """Manually trigger Ollama GGUF blob recovery."""
    try:
        report = model_manager.recover_ollama_blobs()
        model_manager.scan_models()
        return {"ok": True, "report": report}
    except Exception as e:
        logger.exception("recovery failed")
        raise HTTPException(status_code=500, detail=str(e)) from e


@router.get("/sources")
async def get_model_sources():
    """Get list of downloadable models."""
    return model_manager.get_pull_sources()


@router.post("/pull")
async def pull_model(req: PullModelRequest):
    """Trigger background download of a model."""
    try:
        model_manager.pull_model(req.model_id)
        return {"ok": True, "status": "started"}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception("pull failed")
        raise HTTPException(status_code=500, detail=str(e)) from e


@router.get("/pull/status")
async def get_pull_status():
    """Get status/progress of all active downloads."""
    return model_manager.downloads


@router.post("/pull/cancel")
async def cancel_pull_model(req: PullModelRequest):
    """Cancel an active background download of a model."""
    try:
        model_manager.cancel_pull(req.model_id)
        return {"ok": True, "status": "cancelled"}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception("cancel pull failed")
        raise HTTPException(status_code=500, detail=str(e)) from e


@router.post("/load")
async def load_model(req: LoadModelRequest):
    """Load a GGUF into RAM via llama runtime."""
    path = _resolve_load_path(req.model_path)
    rel_for_entry = model_manager._to_relative_posix(path)
    entry = model_manager.get_entry_by_relative_path(rel_for_entry)
    if entry and entry.get("modelType") == "vision":
        raise HTTPException(
            status_code=400,
            detail="MiniCPM-V is used automatically for image analysis and cannot be loaded as a chat model.",
        )
    ok, reason = model_manager.validate_model_file(path)
    if not ok:
        raise HTTPException(status_code=400, detail=reason)

    if not llama_runtime.is_available:
        raise HTTPException(
            status_code=503,
            detail="Standalone runtime unavailable (llama-cpp-python not installed).",
        )

    s = load_settings()
    n_ctx = s.get("contextSize", STANDALONE_N_CTX)

    try:
        llama_runtime.load_model(
            model_path=str(path),
            n_ctx=n_ctx,
            n_threads=STANDALONE_N_THREADS,
            n_gpu_layers=STANDALONE_N_GPU_LAYERS,
        )
    except Exception as e:
        logger.exception("load_model failed")
        raise HTTPException(status_code=500, detail=str(e)) from e

    rel = model_manager._to_relative_posix(path)
    set_last_loaded_model(rel)
    if not s.get("defaultModelPath"):
        set_default_model_path(rel)

    return {"ok": True, "loadedPath": str(path), "relativePath": rel}


@router.post("/unload")
async def unload_model():
    try:
        llama_runtime.unload_model()
    except Exception as e:
        logger.exception("unload failed")
        raise HTTPException(status_code=500, detail=str(e)) from e
    return {"ok": True}


@router.get("/current")
async def get_current_model():
    root = model_manager.get_models_root_abs()
    if not llama_runtime.is_loaded or not llama_runtime._model_path:
        return {
            "loaded": False,
            "modelPath": None,
            "relativePath": None,
            "modelName": None,
            "modelsDirectory": root,
        }
    abs_path = Path(llama_runtime._model_path).resolve()
    abs_str = str(abs_path)
    rel: Optional[str] = None
    try:
        rel = model_manager._to_relative_posix(abs_path)
    except ValueError:
        rel = None
    return {
        "loaded": True,
        "modelPath": abs_str,
        "relativePath": rel,
        "modelName": llama_runtime.loaded_model_name,
        "modelsDirectory": root,
    }


@router.post("/import")
async def import_local_model(req: ImportRequest):
    try:
        new_model = model_manager.import_model(req.file_path)
        return {"status": "success", "model": new_model}
    except Exception as e:
        logger.error("Import failed: %s", e)
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.post("/open-folder")
async def open_models_folder():
    """Open the models directory in the OS file manager."""
    model_manager.ensure_directories()
    try:
        open_folder_in_explorer(model_manager.get_models_root_abs())
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e
    return {"ok": True, "path": model_manager.get_models_root_abs()}


@router.post("/default")
async def set_default_model(req: SetDefaultRequest):
    if not req.model_path:
        set_default_model_path(None)
        return {"ok": True, "defaultModelPath": None}
    rel = req.model_path.replace("\\", "/").lstrip("/")
    if not model_manager.get_entry_by_relative_path(rel):
        model_manager.scan_models()
    entry = model_manager.get_entry_by_relative_path(rel)
    if not entry:
        raise HTTPException(status_code=404, detail="Model not found after scan")
    if entry.get("modelType") == "vision":
        raise HTTPException(status_code=400, detail="MiniCPM-V is used automatically for image analysis.")
    set_default_model_path(rel)
    return {"ok": True, "defaultModelPath": rel}


class SettingsUpdateRequest(BaseModel):
    defaultModelPath: Optional[str] = None
    lastLoadedModel: Optional[str] = None
    autoScanModels: Optional[bool] = None
    contextSize: Optional[int] = None
    maxNewTokens: Optional[int] = None
    chatHistoryLimit: Optional[int] = None
    personaEnabled: Optional[bool] = None
    memoryEnabled: Optional[bool] = None


@router.get("/settings")
async def get_settings():
    """Load settings."""
    return load_settings()


@router.post("/settings")
async def update_settings(req: SettingsUpdateRequest):
    """Update settings."""
    s = load_settings()
    data = req.dict(exclude_unset=True)
    s.update(data)
    save_settings(s)
    return s

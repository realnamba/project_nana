"""
main.py — FastAPI application entry point for Project Nana.

Registers all routers, initializes services on startup,
and serves the frontend static files.
"""

import logging
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlparse

# pyrefly: ignore [missing-import]
from fastapi import FastAPI
# pyrefly: ignore [missing-import]
from fastapi.middleware.cors import CORSMiddleware
# pyrefly: ignore [missing-import]
from fastapi.staticfiles import StaticFiles
# pyrefly: ignore [missing-import]
from fastapi.responses import FileResponse

from app.routers import chat, screenshot, memory, terminal, workspace, models, station
from app.services.llama_runtime import llama_runtime
from app.services.model_manager import model_manager
from app.services.memory_service import memory as memory_svc
from app.services.settings_service import load_settings

# ─── Logging ──────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s │ %(levelname)-7s │ %(name)s │ %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("nana")

ALLOWED_ORIGINS = {
    "http://127.0.0.1:8777",
    "http://localhost:8777",
    "http://127.0.0.1:5173",
    "http://localhost:5173",
}


# ─── Lifespan (startup / shutdown) ────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    """Initialize services on startup, clean up on shutdown."""
    logger.info("=" * 60)
    logger.info("  Project Nana — Local AI Assistant")
    logger.info("=" * 60)

    await memory_svc.initialize()
    logger.info("✓ Database initialized")

    model_manager.ensure_directories()
    try:
        model_manager.recover_ollama_blobs()
        model_manager.scan_models()
    except Exception as e:
        logger.warning("Initial model scan/recovery failed (non-fatal): %s", e)

    n_models = len(model_manager.detected)
    if n_models:
        logger.info("✓ Found %d local GGUF model(s) under %s", n_models, model_manager.get_models_root())
    else:
        logger.info("  No .gguf models found yet — add files to %s", model_manager.get_models_root())

    if llama_runtime.is_available:
        logger.info("✓ Local inference runtime ready (llama-cpp-python)")
    else:
        logger.warning("⚠ llama-cpp-python not installed — text inference unavailable")

    settings = load_settings()
    if settings.get("autoScanModels", True) and n_models:
        chosen = model_manager.apply_auto_default_selection()
        if chosen:
            logger.info("  Default model selection: %s", chosen)

    logger.info("─" * 60)
    logger.info("  Nana is ready at http://127.0.0.1:8777")
    logger.info("─" * 60)

    yield

    logger.info("Shutting down...")
    if llama_runtime.is_loaded:
        llama_runtime.unload_model()
    await memory_svc.close()


# ─── App ──────────────────────────────────────────────────────────────────────
app = FastAPI(
    title="Project Nana",
    description="Local AI Desktop Assistant",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=sorted(ALLOWED_ORIGINS),
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def reject_untrusted_origins(request, call_next):
    """Block cross-site writes to Nana's unauthenticated local API."""
    if request.method not in {"GET", "HEAD", "OPTIONS"} and request.url.path.startswith("/api/"):
        origin = request.headers.get("origin")
        if origin:
            parsed = urlparse(origin)
            normalized = f"{parsed.scheme}://{parsed.netloc}"
            if normalized not in ALLOWED_ORIGINS:
                from fastapi.responses import JSONResponse

                return JSONResponse({"detail": "Untrusted request origin."}, status_code=403)
    return await call_next(request)

app.include_router(chat.router)
app.include_router(screenshot.router)
app.include_router(memory.router)
app.include_router(terminal.router)
app.include_router(workspace.router)
app.include_router(models.router)
app.include_router(station.router)


@app.get("/api/status")
async def get_status():
    """Health check — local runtime and models folder."""
    root = model_manager.get_models_root_abs()
    loaded_path = None
    if llama_runtime.is_loaded and llama_runtime._model_path:
        loaded_path = str(Path(llama_runtime._model_path).resolve())

    settings = load_settings()
    return {
        "backend": "ok",
        "models_directory": root,
        "model_count": len(model_manager.get_detected_models()),
        "standalone_available": llama_runtime.is_available,
        "standalone_loaded": llama_runtime.is_loaded,
        "standalone_model": llama_runtime.loaded_model_name,
        "loaded_model_path": loaded_path,
        "default_model_path": settings.get("defaultModelPath"),
    }


FRONTEND_DIR = Path(__file__).resolve().parent.parent.parent / "frontend"


@app.get("/")
async def serve_index():
    return FileResponse(FRONTEND_DIR / "index.html")


app.mount("/static", StaticFiles(directory=str(FRONTEND_DIR)), name="static")

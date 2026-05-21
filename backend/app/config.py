"""
config.py — Central configuration for Project Nana backend.
All settings are defined here so you never have magic strings scattered around.
"""

import os
from pathlib import Path

# ─── Paths ────────────────────────────────────────────────────────────────────
APP_DIR = Path(__file__).resolve().parent.parent.parent

user_dir_env = os.environ.get("NANA_DATA_DIR")
if user_dir_env:
    USER_DATA_DIR = Path(user_dir_env).resolve()
else:
    USER_DATA_DIR = APP_DIR

DATA_DIR = USER_DATA_DIR / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)

CONFIG_DATA_DIR = USER_DATA_DIR / "config"
CONFIG_DATA_DIR.mkdir(parents=True, exist_ok=True)

DATABASE_PATH = DATA_DIR / "nana.db"

# ─── Local models ─────────────────────────────────────────────────────────────
# GGUF files live in <project>/models/ (see model_manager.MODELS_DIR).

# Legacy env vars (optional): max tokens / temperature for local text generation
CODER_MODEL = os.getenv("CODER_MODEL", "")  # unused — selection is path-based
VISION_MODEL = os.getenv("VISION_MODEL", "")  # reserved for future local vision

VISION_MAX_TOKENS = 1024
VISION_TEMPERATURE = 0.3

CODER_MAX_TOKENS = 4096
CODER_TEMPERATURE = 0.7

# ─── Image Processing ────────────────────────────────────────────────────────
MAX_IMAGE_DIMENSION = 1024   # Resize screenshots to max 1024px on longest side
JPEG_QUALITY = 85            # Compression quality (lower = smaller but blurrier)

# ─── Context / Memory ────────────────────────────────────────────────────────
MAX_CONTEXT_MESSAGES = 10    # Keep last N messages as full context
SYSTEM_PROMPT = """You are Nana, a helpful local AI assistant running on the user's laptop.
You can analyze screenshots and help with coding, debugging, and general questions.
Be concise, accurate, and friendly. When showing code, use proper formatting.
If you analyzed a screenshot, reference what you saw in your response."""

# ─── Server ───────────────────────────────────────────────────────────────────
HOST = "127.0.0.1"          # Local-only, never expose to network
PORT = 8777

# ─── Standalone Runtime (GGUF / llama.cpp) ────────────────────────────────────
STANDALONE_N_CTX = 2048
STANDALONE_N_THREADS = 4
STANDALONE_N_GPU_LAYERS = 0

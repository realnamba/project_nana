"""
run.py — Server launcher for Project Nana.
Run this file to start the backend: python run.py
"""

import os
import uvicorn
from app.config import HOST, PORT

if __name__ == "__main__":
    reload_enabled = os.getenv("NANA_BACKEND_RELOAD", "").lower() in {"1", "true", "yes"}
    uvicorn.run(
        "app.main:app",
        host=HOST,
        port=PORT,
        reload=reload_enabled,
        log_level="info",
    )

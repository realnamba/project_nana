"""
settings_service.py — Persisted user preferences (default model, scan options).
Stored at project root: config/settings.json
"""

import json
import logging
from typing import Any, Dict, Optional

from app.config import CONFIG_DATA_DIR

logger = logging.getLogger(__name__)

SETTINGS_FILE = CONFIG_DATA_DIR / "settings.json"

_DEFAULTS: Dict[str, Any] = {
    "defaultModelPath": None,  # relative to models dir, posix-style
    "lastLoadedModel": None,
    "autoScanModels": True,
    "contextSize": 4096,
    "maxNewTokens": 512,
    "memoryRetrievalDepth": 10,
    "personaEnabled": True,
    "memoryEnabled": True,
}


def ensure_config_dir() -> None:
    CONFIG_DATA_DIR.mkdir(parents=True, exist_ok=True)


def load_settings() -> Dict[str, Any]:
    """Load settings from disk; merge with defaults for missing keys."""
    ensure_config_dir()
    data = dict(_DEFAULTS)
    if not SETTINGS_FILE.exists():
        save_settings(data)
        return data
    try:
        with open(SETTINGS_FILE, "r", encoding="utf-8") as f:
            disk = json.load(f)
        if isinstance(disk, dict):
            data.update({k: v for k, v in disk.items() if k in _DEFAULTS})
    except Exception as e:
        logger.warning("Could not read settings.json (%s); using defaults", e)
    return data


def save_settings(data: Dict[str, Any]) -> None:
    """Write settings atomically."""
    ensure_config_dir()
    merged = dict(_DEFAULTS)
    merged.update({k: data.get(k, _DEFAULTS[k]) for k in _DEFAULTS})
    tmp = SETTINGS_FILE.with_suffix(".json.tmp")
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(merged, f, indent=2)
        tmp.replace(SETTINGS_FILE)
    except Exception as e:
        logger.error("Failed to save settings: %s", e)
        if tmp.exists():
            try:
                tmp.unlink()
            except OSError:
                pass


def set_default_model_path(relative_path: Optional[str]) -> None:
    s = load_settings()
    s["defaultModelPath"] = relative_path
    save_settings(s)


def set_last_loaded_model(relative_path: Optional[str]) -> None:
    s = load_settings()
    s["lastLoadedModel"] = relative_path
    save_settings(s)


def get_models_directory_display() -> str:
    """Relative path string for settings examples (models/...)."""
    return "models"

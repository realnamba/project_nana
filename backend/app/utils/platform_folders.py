"""Open a folder in the OS file manager (Windows / macOS / Linux)."""

import logging
import platform
import subprocess
from pathlib import Path

logger = logging.getLogger(__name__)


def open_folder_in_explorer(folder_path: str) -> None:
    path = Path(folder_path)
    if not path.exists():
        raise FileNotFoundError(f"Folder does not exist: {folder_path}")
    if not path.is_dir():
        raise NotADirectoryError(f"Not a directory: {folder_path}")

    resolved = str(path.resolve())
    system = platform.system()

    try:
        if system == "Windows":
            import os

            os.startfile(resolved)  # type: ignore[attr-defined]
        elif system == "Darwin":
            subprocess.Popen(["open", resolved], start_new_session=True)
        else:
            subprocess.Popen(["xdg-open", resolved], start_new_session=True)
    except Exception as e:
        logger.error("open_folder_in_explorer failed: %s", e)
        raise

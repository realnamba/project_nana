"""
workspace.py — Router for project workspace management.
Handles file system operations safely within a connected directory.
"""

import os
import logging
from pathlib import Path
# pyrefly: ignore [missing-import]
from fastapi import APIRouter, HTTPException, Query
# pyrefly: ignore [missing-import]
from pydantic import BaseModel
from app.config import APP_DIR

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/workspace", tags=["workspace"])

# Global state for the current active workspace. 
# For a multi-user app this would be in a DB/session, but Nana is a single-user local app.
ACTIVE_WORKSPACE: Path | None = None

# Heavy or sensitive folders to ignore by default in the tree
IGNORE_DIRS = {
    "node_modules", ".git", "dist", "build", ".next", "out", "target", "vendor", "__pycache__", ".venv", "venv", "env"
}

MAX_VIEW_FILE_BYTES = 1024 * 1024
MAX_WRITE_FILE_BYTES = 2 * 1024 * 1024
PROTECTED_WORKSPACE_NAMES = {
    "windows", "program files", "program files (x86)", "programdata",
    "users", "system32", "$recycle.bin",
}

class OpenWorkspaceRequest(BaseModel):
    path: str

class FileUpdateRequest(BaseModel):
    path: str
    content: str

class FileCreateRequest(BaseModel):
    path: str
    content: str = ""
    is_dir: bool = False

class FileDeleteRequest(BaseModel):
    path: str

from app.config import DATA_DIR
import json

RECENT_PROJECTS_FILE = DATA_DIR / "workspace" / "recent_projects.json"

def _load_recent_projects() -> list[dict]:
    if not RECENT_PROJECTS_FILE.exists():
        return []
    try:
        with open(RECENT_PROJECTS_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        logger.warning(f"Failed to read recent_projects.json: {e}")
        return []

def _save_recent_projects(projects: list[dict]):
    try:
        RECENT_PROJECTS_FILE.parent.mkdir(parents=True, exist_ok=True)
        with open(RECENT_PROJECTS_FILE, "w", encoding="utf-8") as f:
            json.dump(projects, f, indent=2)
    except Exception as e:
        logger.error(f"Failed to save recent_projects.json: {e}")


def _get_safe_path(target_path: str) -> Path:
    """Ensure the target path is strictly within the active workspace."""
    if not ACTIVE_WORKSPACE:
        raise HTTPException(status_code=400, detail="No active workspace connected.")
    
    try:
        clean_target = target_path.lstrip("/\\")
        # Strip drive letters on Windows if they are present
        if len(clean_target) > 1 and clean_target[1] == ":":
            clean_target = clean_target[2:].lstrip("/\\")

        full_path = (ACTIVE_WORKSPACE / clean_target).resolve()
        active_res = ACTIVE_WORKSPACE.resolve()
        
        if not full_path.is_relative_to(active_res) and full_path != active_res:
            raise HTTPException(status_code=403, detail="Path traversal detected. Access denied.")
            
        # Verify no symlinks exist in the path tree to prevent escapes
        current = ACTIVE_WORKSPACE / clean_target
        while current != ACTIVE_WORKSPACE:
            if current.is_symlink():
                raise HTTPException(status_code=403, detail="Symlinks are not allowed in workspace file operations.")
            current = current.parent
            
        return full_path
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid path: {e}")


def _build_tree(dir_path: Path) -> list[dict]:
    """Recursively build a file tree dictionary."""
    tree = []
    try:
        entries = sorted(os.scandir(dir_path), key=lambda e: (not e.is_dir(), e.name.lower()))
        for entry in entries:
            if entry.name in IGNORE_DIRS:
                continue
                
            item = {
                "name": entry.name,
                "path": str(Path(entry.path).relative_to(ACTIVE_WORKSPACE)).replace("\\", "/"),
                "is_dir": entry.is_dir()
            }
            if entry.is_dir():
                item["children"] = _build_tree(Path(entry.path))
            
            tree.append(item)
    except PermissionError:
        pass # Skip unreadable directories
    return tree


@router.post("/open")
async def open_workspace(request: OpenWorkspaceRequest):
    global ACTIVE_WORKSPACE
    path = Path(request.path).expanduser().resolve()
    
    if not path.exists() or not path.is_dir():
        raise HTTPException(status_code=404, detail="Directory not found or is not a directory.")
    project_root = APP_DIR.resolve()
    if not path.is_relative_to(project_root) and path != project_root:
        raise HTTPException(status_code=403, detail="Access denied. Refusing to open a workspace outside the configured project directory.")
    if path.is_symlink():
        raise HTTPException(status_code=403, detail="Symlink workspaces are not allowed.")
    logger.info("Opening Nana project workspace.")
        
    ACTIVE_WORKSPACE = path
    logger.info(f"Workspace connected: {ACTIVE_WORKSPACE}")
    
    # Save to recents
    path_str = str(path).replace("\\", "/")
    recents = _load_recent_projects()
    recents = [r for r in recents if r.get("path") != path_str]
    recents.insert(0, {"name": path.name, "path": path_str})
    recents = recents[:10]
    _save_recent_projects(recents)
    
    return {"status": "success", "workspace": str(ACTIVE_WORKSPACE), "name": path.name}


@router.post("/select-folder")
async def select_folder_dialog():
    try:
        import tkinter as tk
        from tkinter import filedialog
        import asyncio
        
        def _open_dialog():
            root = tk.Tk()
            root.withdraw()
            root.attributes("-topmost", True)
            folder = filedialog.askdirectory(title="Open Project Folder")
            root.destroy()
            return folder
            
        selected = await asyncio.to_thread(_open_dialog)
        if not selected:
            return {"status": "cancelled", "path": None}
        return {"status": "success", "path": selected.replace("\\", "/")}
    except Exception as e:
        logger.error(f"Failed to open native dialog: {e}")
        return {"status": "error", "message": str(e), "path": None}


@router.get("/recent")
async def get_recent_projects():
    return {"projects": _load_recent_projects()}


@router.post("/close")
async def close_workspace_endpoint():
    global ACTIVE_WORKSPACE
    ACTIVE_WORKSPACE = None
    return {"status": "success"}


@router.get("/status")
async def workspace_status():
    if not ACTIVE_WORKSPACE:
        return {"connected": False}
    return {"connected": True, "workspace": str(ACTIVE_WORKSPACE).replace("\\", "/"), "name": ACTIVE_WORKSPACE.name}


@router.get("/tree")
async def get_tree():
    if not ACTIVE_WORKSPACE:
        raise HTTPException(status_code=400, detail="No active workspace connected.")
    
    tree = _build_tree(ACTIVE_WORKSPACE)
    return {"tree": tree}


@router.get("/file")
async def read_file(path: str = Query(...)):
    safe_path = _get_safe_path(path)
    
    if not safe_path.exists():
        raise HTTPException(status_code=404, detail="File not found.")
    if not safe_path.is_file():
        raise HTTPException(status_code=400, detail="Path is not a file.")
        
    try:
        # Prevent opening massive files
        size = safe_path.stat().st_size
        if size > MAX_VIEW_FILE_BYTES:
            raise HTTPException(status_code=400, detail="File is too large (>1MB) to view safely.")
            
        content = safe_path.read_text(encoding="utf-8")
        return {"content": content}
    except UnicodeDecodeError:
        raise HTTPException(status_code=400, detail="File appears to be binary and cannot be read as text.")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/file/update")
async def update_file(request: FileUpdateRequest):
    safe_path = _get_safe_path(request.path)
    
    if not safe_path.exists() or not safe_path.is_file():
        raise HTTPException(status_code=404, detail="File not found.")
    if len(request.content.encode("utf-8")) > MAX_WRITE_FILE_BYTES:
        raise HTTPException(status_code=400, detail="File content is too large (>2MB) to write safely.")
        
    try:
        safe_path.write_text(request.content, encoding="utf-8")
        return {"status": "success"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/file/create")
async def create_file(request: FileCreateRequest):
    safe_path = _get_safe_path(request.path)
    
    if safe_path.exists():
        raise HTTPException(status_code=400, detail="Path already exists.")
    if not request.is_dir and len(request.content.encode("utf-8")) > MAX_WRITE_FILE_BYTES:
        raise HTTPException(status_code=400, detail="File content is too large (>2MB) to write safely.")
        
    try:
        if request.is_dir:
            safe_path.mkdir(parents=True, exist_ok=True)
        else:
            safe_path.parent.mkdir(parents=True, exist_ok=True)
            safe_path.write_text(request.content, encoding="utf-8")
        return {"status": "success"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/file/delete")
async def delete_file(request: FileDeleteRequest):
    safe_path = _get_safe_path(request.path)
    
    if not safe_path.exists():
        raise HTTPException(status_code=404, detail="Path not found.")
    if safe_path.is_dir():
        raise HTTPException(status_code=403, detail="Directory deletion is disabled for safety.")
        
    try:
        safe_path.unlink()
        return {"status": "success"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

class FileRenameRequest(BaseModel):
    old_path: str
    new_path: str

class FileSearchRequest(BaseModel):
    query: str

@router.post("/file/rename")
async def rename_file(request: FileRenameRequest):
    old_safe = _get_safe_path(request.old_path)
    new_safe = _get_safe_path(request.new_path)
    
    if not old_safe.exists():
        raise HTTPException(status_code=404, detail="Original path not found.")
    if new_safe.exists():
        raise HTTPException(status_code=400, detail="New path already exists.")
        
    try:
        old_safe.rename(new_safe)
        return {"status": "success"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/file/search")
async def search_files(request: FileSearchRequest):
    if not ACTIVE_WORKSPACE:
        raise HTTPException(status_code=400, detail="No active workspace connected.")
        
    query = request.query
    if not query:
        raise HTTPException(status_code=400, detail="Search query cannot be empty.")
        
    results = []
    import subprocess
    
    # Simple recursive search (could be optimized with ripgrep if available, but os.walk works for local pure python)
    # Actually, let's use os.walk and open files to find the query. This is safe and requires no external tools.
    for root, dirs, files in os.walk(ACTIVE_WORKSPACE):
        # Exclude ignored dirs
        dirs[:] = [d for d in dirs if d not in IGNORE_DIRS]
        
        for file in files:
            file_path = Path(root) / file
            try:
                # Try reading as text
                content = file_path.read_text(encoding="utf-8")
                if query in content:
                    lines = content.split('\n')
                    matches = []
                    for i, line in enumerate(lines):
                        if query in line:
                            matches.append({"line": i+1, "content": line.strip()})
                    
                    results.append({
                        "file": str(file_path.relative_to(ACTIVE_WORKSPACE)).replace("\\", "/"),
                        "matches": matches
                    })
            except (UnicodeDecodeError, PermissionError):
                pass # Skip binary or unreadable files

    return {"status": "success", "results": results}

@router.post("/open-editor")
async def open_in_editor():
    """Attempts to open the active workspace in VS Code."""
    if not ACTIVE_WORKSPACE:
        raise HTTPException(status_code=400, detail="No active workspace connected.")
        
    try:
        import subprocess
        # This assumes `code` is in the PATH on Windows/Mac/Linux
        subprocess.Popen(["code", "."], cwd=str(ACTIVE_WORKSPACE), shell=False)
        return {"status": "success"}
    except Exception as e:
        logger.error(f"Failed to open editor: {e}")
        raise HTTPException(status_code=500, detail="Failed to open VS Code. Ensure 'code' is in your PATH.")

"""
model_manager.py — Local GGUF discovery, registry, and safe path resolution.

Scans PROJECT_ROOT/models recursively for *.gguf files.
Validates GGUF magic header (first 4 bytes = 'GGUF') and minimum size.
"""

import json
import logging
import os
import re
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from app.services.settings_service import load_settings, set_default_model_path
from app.services.llama_runtime import llama_runtime
from app.config import APP_DIR, USER_DATA_DIR, CONFIG_DATA_DIR

logger = logging.getLogger(__name__)

# GGUF magic: first 4 bytes must be b'GGUF'
_GGUF_MAGIC = b"GGUF"
# Minimum file size for a real GGUF model (100 MB)
_MIN_GGUF_SIZE = 100 * 1024 * 1024

# User-facing models folder at project root (or NANA_DATA_DIR):
MODELS_DIR = USER_DATA_DIR / "models"
REGISTRY_FILE = CONFIG_DATA_DIR / "model_registry.json"

# Filename hints for quantization (order: more specific first)
_QUANT_TOKENS = (
    "IQ4_XS", "IQ4_NL", "IQ3_M", "IQ3_S", "IQ2_M", "IQ2_XS",
    "Q8_0", "Q6_K", "Q5_K_M", "Q5_K_S", "Q5_0", "Q4_K_M", "Q4_K_S",
    "Q4_0", "Q3_K_M", "Q3_K_S", "Q3_K_L", "Q2_K", "Q2_K_S",
    "F32", "F16", "BF16",
)

_PROJECTOR_NAME_HINTS = ("mmproj", "projector")


def _infer_quantization(name: str) -> str:
    upper = name.upper().replace("-", "_")
    for tok in _QUANT_TOKENS:
        if tok in upper or tok.replace("_", "-") in name.upper():
            return tok.replace("-", "_")
    m = re.search(r"\b(IQ\d_[A-Z0-9]+|Q\d_[A-Z0-9_]+)\b", name, re.I)
    if m:
        return m.group(1).upper()
    return "unknown"


def _infer_model_type(name_lower: str) -> str:
    if any(x in name_lower for x in ("minicpm", "llava", "bakllava", "moondream", "vision")):
        return "vision"
    if any(x in name_lower for x in ("coder", "codeqwen", "deepseek-coder", "starcoder", "codellama")):
        return "code"
    if any(x in name_lower for x in ("deepseek-r1", "r1-distill", "reasoning")):
        return "reasoning"
    return "chat"


def _is_projector_file(path: Path) -> bool:
    name = path.name.lower()
    return name.endswith(".gguf") and any(hint in name for hint in _PROJECTOR_NAME_HINTS)


def _display_name_for_vision_package(folder_name: str) -> str:
    normalized = folder_name.lower()
    if normalized == "minicpm-v" or "minicpm" in normalized:
        return "MiniCPM-V Vision"
    cleaned = folder_name.replace("-", " ").replace("_", " ").strip()
    return f"{cleaned.title()} Vision"


class ModelManager:
    def __init__(self) -> None:
        self.detected: List[Dict[str, Any]] = []
        self.downloads: Dict[str, Dict[str, Any]] = {}
        self.active_responses: Dict[str, Any] = {}
        self.ensure_directories()

    def _to_relative_posix(self, path: Path) -> str:
        rel = path.relative_to(MODELS_DIR)
        return rel.as_posix()

    def _safe_resolve_under_models(self, raw_path: str) -> Path:
        from pathlib import Path
        normalized = raw_path.replace("\\", "/")
        if normalized.lower().startswith("models/"):
            normalized = normalized[7:]
        p = Path(normalized)

        if p.is_absolute():
            resolved = p.resolve()
        else:
            resolved = (MODELS_DIR / p).resolve()

        models_root = MODELS_DIR.resolve()

        if not str(resolved).lower().startswith(str(models_root).lower()):
            raise ValueError("Model path must stay inside models folder")

        return resolved

    def ensure_directories(self) -> None:
        if not MODELS_DIR.exists():
            MODELS_DIR.mkdir(parents=True, exist_ok=True)
            logger.info("Created models directory: %s", MODELS_DIR)

    def get_models_root(self) -> Path:
        return MODELS_DIR

    def get_models_root_abs(self) -> str:
        return str(MODELS_DIR.resolve())

    @staticmethod
    def _has_gguf_magic(filepath: Path) -> bool:
        """Check if a file starts with the GGUF magic bytes."""
        try:
            with open(filepath, "rb") as f:
                header = f.read(4)
            return header == _GGUF_MAGIC
        except OSError:
            return False

    def scan_models(self) -> List[Dict[str, Any]]:
        """
        Recursively find .gguf files under MODELS_DIR.
        Validates:
          - file extension is .gguf
          - file size >= 100 MB
          - first 4 bytes are 'GGUF'
        Ignores manifests, json, sha256 files, and broken files.
        """
        self.ensure_directories()
        found: List[Dict[str, Any]] = []

        if not MODELS_DIR.is_dir():
            self.detected = []
            return self.detected

        try:
            paths = sorted(
                MODELS_DIR.rglob("*.gguf"),
                key=lambda p: str(p).lower(),
            )
        except OSError as e:
            logger.warning("Model scan failed: %s", e)
            self.detected = []
            return self.detected

        consumed_package_files = set()

        by_parent: Dict[Path, List[Path]] = {}
        for path in paths:
            by_parent.setdefault(path.parent, []).append(path)

        for parent, folder_paths in by_parent.items():
            projectors = [
                p for p in folder_paths
                if p.is_file()
                and _is_projector_file(p)
                and self._has_gguf_magic(p)
            ]
            main_candidates = [
                p for p in folder_paths
                if p.is_file()
                and not _is_projector_file(p)
                and self._has_gguf_magic(p)
            ]
            if not projectors or not main_candidates:
                continue

            valid_mains = []
            for candidate in main_candidates:
                try:
                    if candidate.stat().st_size >= _MIN_GGUF_SIZE:
                        valid_mains.append(candidate)
                except OSError:
                    continue
            if not valid_mains:
                continue

            main_path = sorted(
                valid_mains,
                key=lambda p: (
                    0 if "minicpm" in p.name.lower() else 1,
                    str(p).lower(),
                ),
            )[0]
            projector_path = sorted(projectors, key=lambda p: str(p).lower())[0]
            consumed_package_files.add(main_path.resolve())
            consumed_package_files.add(projector_path.resolve())

            try:
                main_stat = main_path.stat()
                projector_stat = projector_path.stat()
                size = int(main_stat.st_size) + int(projector_stat.st_size)
                mtime = max(main_stat.st_mtime, projector_stat.st_mtime)
            except OSError:
                continue

            rel = self._to_relative_posix(main_path)
            projector_rel = self._to_relative_posix(projector_path)
            quant = _infer_quantization(main_path.name)
            abs_str = str(main_path.resolve())
            projector_abs = str(projector_path.resolve())
            loaded = bool(
                llama_runtime.is_loaded
                and llama_runtime._model_path
                and Path(llama_runtime._model_path).resolve() == main_path.resolve()
            )

            found.append(
                {
                    "id": rel,
                    "relativePath": rel,
                    "fileName": main_path.name,
                    "displayName": _display_name_for_vision_package(parent.name),
                    "filePath": abs_str,
                    "size": size,
                    "modelType": "vision",
                    "quantization": quant,
                    "lastModified": datetime.fromtimestamp(mtime, tz=timezone.utc).isoformat(),
                    "available": True,
                    "status": "ready",
                    "visionSetupRequired": False,
                    "loaded": loaded,
                    "runtime": "standalone",
                    "packagePath": parent.relative_to(MODELS_DIR).as_posix() + "/",
                    "mainModelPath": rel,
                    "main_model_path": abs_str,
                    "mmprojPath": projector_rel,
                    "mmproj_path": projector_abs,
                    "files": [
                        {"role": "main", "relativePath": rel, "filePath": abs_str, "size": int(main_stat.st_size)},
                        {"role": "mmproj", "relativePath": projector_rel, "filePath": projector_abs, "size": int(projector_stat.st_size)},
                    ],
                }
            )

        for path in paths:
            if not path.is_file():
                continue
            if path.resolve() in consumed_package_files:
                continue
            name_lower = path.name.lower()
            if not name_lower.endswith(".gguf"):
                continue
            if _is_projector_file(path):
                logger.debug("Skipping projector support file as standalone model: %s", path)
                continue
            try:
                stat = path.stat()
                size = int(stat.st_size)
                mtime = datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat()
            except OSError:
                continue

            # Skip files smaller than minimum threshold
            if size < _MIN_GGUF_SIZE:
                logger.debug("Skipping %s: too small (%d bytes)", path.name, size)
                continue

            # Validate GGUF magic header
            if not self._has_gguf_magic(path):
                logger.warning("Skipping %s: invalid GGUF header", path.name)
                continue

            rel = self._to_relative_posix(path)
            display = rel.replace("/", " / ").replace(".gguf", "")
            quant = _infer_quantization(path.name)
            mtype = _infer_model_type(name_lower)

            vision_setup_required = False
            is_available = path.exists()

            if mtype == "vision":
                # Check for projector file (starts with mmproj and ends with .gguf)
                projector_exists = False
                try:
                    if path.parent.is_dir():
                        projector_exists = any(
                            f.name.lower().startswith("mmproj") and f.name.lower().endswith(".gguf")
                            for f in path.parent.iterdir()
                            if f.is_file()
                        )
                except OSError:
                    pass
                if not projector_exists:
                    vision_setup_required = True
                    is_available = False

            abs_str = str(path.resolve())
            loaded = bool(
                llama_runtime.is_loaded
                and llama_runtime._model_path
                and Path(llama_runtime._model_path).resolve() == path.resolve()
            )

            found.append(
                {
                    "id": rel,
                    "relativePath": rel,
                    "fileName": path.name,
                    "displayName": display,
                    "filePath": abs_str,
                    "size": size,
                    "modelType": mtype,
                    "quantization": quant,
                    "lastModified": mtime,
                    "available": is_available,
                    "status": "ready" if is_available else "missing",
                    "visionSetupRequired": vision_setup_required,
                    "loaded": loaded,
                    "runtime": "standalone",
                }
            )

        self.detected = found
        self._sync_registry_file()
        logger.info("Model scan: %d valid GGUF file(s) under %s", len(found), MODELS_DIR)
        return list(self.detected)

    def _sync_registry_file(self) -> None:
        """Mirror detected models to JSON for debugging / external tools."""
        try:
            REGISTRY_FILE.parent.mkdir(parents=True, exist_ok=True)
            with open(REGISTRY_FILE, "w", encoding="utf-8") as f:
                json.dump(self.detected, f, indent=2)
        except OSError as e:
            logger.debug("Registry write skipped: %s", e)

    def get_detected_models(self) -> List[Dict[str, Any]]:
        """Return last scan results with fresh `available` and `loaded` flags."""
        out: List[Dict[str, Any]] = []
        for m in self.detected:
            row = dict(m)
            p = Path(row["filePath"])
            is_avail = p.is_file()
            if row.get("modelType") == "vision":
                projector = row.get("mmproj_path") or row.get("mmprojPath")
                if projector:
                    projector_path = Path(projector)
                    is_avail = is_avail and projector_path.is_file()
                if row.get("visionSetupRequired"):
                    is_avail = False
            elif row.get("visionSetupRequired"):
                is_avail = False
            row["available"] = is_avail
            row["status"] = "ready" if is_avail else "missing"
            row["loaded"] = bool(
                llama_runtime.is_loaded
                and llama_runtime._model_path
                and Path(llama_runtime._model_path).resolve() == p.resolve()
            )
            out.append(row)
        return out

    def get_entry_by_relative_path(self, relative_path: str) -> Optional[Dict[str, Any]]:
        rel = (relative_path or "").replace("\\", "/").lstrip("/")
        if rel.startswith("models/"):
            rel = rel[len("models/") :]
        for m in self.detected:
            if m["relativePath"] == rel or m["id"] == rel:
                return m
        return None

    def get_ready_vision_model(self) -> Optional[Dict[str, Any]]:
        """Return the ready local vision package used for image analysis."""
        for m in self.get_detected_models():
            if m.get("modelType") == "vision" and m.get("available"):
                return m
        self.scan_models()
        for m in self.get_detected_models():
            if m.get("modelType") == "vision" and m.get("available"):
                return m
        return None

    def pick_default_relative_path(self) -> Optional[str]:
        """
        If one model, return it.
        If multiple: prefer saved default if still present, else best chat heuristic.
        """
        if not self.detected:
            return None
        if len(self.detected) == 1:
            return self.detected[0]["relativePath"]

        settings = load_settings()
        saved = settings.get("defaultModelPath") or settings.get("lastLoadedModel")
        entry = self.get_entry_by_relative_path(saved) if saved else None
        if entry and entry.get("modelType") != "vision":
            return entry["relativePath"]

        candidates = [m for m in self.detected if m.get("modelType") != "vision"]
        if not candidates:
            return None

        def score(m: Dict[str, Any]) -> Tuple[int, int]:
            name = (m["fileName"] + " " + m["relativePath"]).lower()
            s = 0
            if "instruct" in name or "chat" in name:
                s += 10
            if m.get("modelType") == "code":
                s += 4
            if m.get("modelType") == "vision":
                s += 1
            # Prefer smaller quant / file for "default chat"
            q = str(m.get("quantization", "")).upper()
            if "Q4" in q or "Q3" in q or "IQ4" in q:
                s += 3
            if "Q8" in q or "F16" in q:
                s -= 1
            # Smaller file slightly preferred
            size = int(m.get("size") or 0)
            return (s, -size)

        best = max(candidates, key=score)
        return best["relativePath"]

    def apply_auto_default_selection(self) -> Optional[str]:
        """Pick default, persist to settings. Returns chosen relative path or None."""
        chosen = self.pick_default_relative_path()
        if chosen:
            set_default_model_path(chosen)
        return chosen

    def import_model(self, source_path: str) -> Dict[str, Any]:
        """Copy a .gguf into MODELS_DIR root and rescan."""
        source = Path(source_path)
        if not source.exists() or not source.is_file():
            raise ValueError("Invalid source path.")
        if source.suffix.lower() != ".gguf":
            raise ValueError("Only .gguf files are supported.")

        self.ensure_directories()
        destination = MODELS_DIR / source.name
        if not destination.exists():
            import shutil

            shutil.copy2(source, destination)
            logger.info("Imported model to %s", destination)

        self.scan_models()
        for m in self.detected:
            if m["fileName"] == source.name and "/" not in m["relativePath"]:
                return m
        for m in self.detected:
            if m["fileName"] == source.name:
                return m
        raise RuntimeError("Imported file not found after scan.")

    def validate_model_file(self, absolute_path: Path) -> Tuple[bool, str]:
        """Soft validation before load; checks GGUF magic header."""
        if not absolute_path.exists():
            return False, "File missing"
        if not absolute_path.is_file():
            return False, "Not a file"
        if absolute_path.suffix.lower() != ".gguf":
            return False, "Not a .gguf file"
        try:
            fsize = absolute_path.stat().st_size
            if fsize < 1024:
                return False, "File too small to be a valid GGUF"
        except OSError as e:
            return False, str(e)
        if not self._has_gguf_magic(absolute_path):
            return False, "Invalid GGUF header (first 4 bytes are not 'GGUF')"
        return True, "ok"

    def recover_ollama_blobs(self) -> Dict[str, Any]:
        """
        Scan models/ for Ollama manifest files, locate GGUF blobs
        in Ollama's storage, verify magic header, and copy as clean
        .gguf files. Never deletes or moves original files.

        Returns a report dict with details of what was found/recovered.
        """
        ollama_blobs_dir = Path.home() / ".ollama" / "models" / "blobs"
        report: Dict[str, Any] = {
            "inspected": [],
            "manifests": [],
            "ggufBlobsFound": [],
            "ggufFilesCopied": [],
            "skipped": [],
            "warnings": [],
            "errors": [],
        }

        if not MODELS_DIR.is_dir():
            report["errors"].append("Models directory not found")
            return report

        # Iterate model subdirectories
        for subdir in sorted(MODELS_DIR.iterdir()):
            if not subdir.is_dir():
                continue
            model_name = subdir.name
            report["inspected"].append(str(subdir))

            # Find manifest files (Ollama JSON with schemaVersion + layers)
            for fpath in subdir.rglob("*"):
                if not fpath.is_file():
                    continue
                if fpath.suffix.lower() in (".gguf", ".bin"):
                    continue
                if fpath.stat().st_size > 10_000:
                    continue  # manifests are small

                try:
                    raw = fpath.read_text(encoding="utf-8")
                    manifest = json.loads(raw)
                except (json.JSONDecodeError, UnicodeDecodeError, OSError):
                    continue

                if not isinstance(manifest.get("layers"), list):
                    continue

                rel = str(fpath.relative_to(MODELS_DIR))
                report["manifests"].append(rel)
                logger.info("Found Ollama manifest: %s", rel)

                for layer in manifest["layers"]:
                    media_type = layer.get("mediaType", "")
                    digest = layer.get("digest", "")
                    layer_size = layer.get("size", 0)

                    if media_type != "application/vnd.ollama.image.model":
                        continue

                    # Locate the blob
                    blob_name = digest.replace(":", "-")
                    blob_path = None

                    # Check local model folder first
                    for candidate in [
                        subdir / blob_name,
                        subdir / "blobs" / blob_name,
                    ]:
                        if candidate.exists():
                            blob_path = candidate
                            break

                    # Check Ollama's blob storage
                    if blob_path is None and ollama_blobs_dir.is_dir():
                        candidate = ollama_blobs_dir / blob_name
                        if candidate.exists():
                            blob_path = candidate

                    if blob_path is None:
                        msg = f"Blob not found for {model_name}: {digest[:24]}..."
                        report["warnings"].append(msg)
                        logger.warning(msg)
                        continue

                    # Verify GGUF magic
                    if not self._has_gguf_magic(blob_path):
                        msg = f"Blob {blob_path.name} has no GGUF header"
                        report["warnings"].append(msg)
                        logger.warning(msg)
                        continue

                    actual_size = blob_path.stat().st_size
                    report["ggufBlobsFound"].append({
                        "model": model_name,
                        "blob": str(blob_path),
                        "size": actual_size,
                    })

                    # Copy as clean .gguf
                    dest = subdir / f"{model_name}.gguf"
                    if dest.exists():
                        if dest.stat().st_size == actual_size:
                            report["skipped"].append({
                                "dest": str(dest.relative_to(MODELS_DIR)),
                                "reason": "Already exists with matching size",
                            })
                            continue
                        else:
                            report["skipped"].append({
                                "dest": str(dest.relative_to(MODELS_DIR)),
                                "reason": "Already exists with different size — won't overwrite",
                            })
                            continue

                    try:
                        shutil.copy2(str(blob_path), str(dest))
                        copied_size = dest.stat().st_size
                        report["ggufFilesCopied"].append({
                            "model": model_name,
                            "dest": str(dest.relative_to(MODELS_DIR)),
                            "size": copied_size,
                        })
                        logger.info("Recovered GGUF: %s (%d bytes)", dest.name, copied_size)
                    except OSError as e:
                        report["errors"].append(f"Copy failed for {model_name}: {e}")
                        logger.error("Copy failed for %s: %s", model_name, e)

        return report

    def get_pull_sources(self) -> Dict[str, Any]:
        sources_path = APP_DIR / "config" / "model_sources.json"
        if not sources_path.is_file():
            return {}
        try:
            return json.loads(sources_path.read_text(encoding="utf-8"))
        except Exception as e:
            logger.error("Failed to load model sources: %s", e)
            return {}

    def pull_model(self, model_id: str) -> None:
        """Start a background thread to download a model GGUF (supports multi-file vision models)."""
        sources = self.get_pull_sources()
        if model_id not in sources:
            raise ValueError(f"Model ID '{model_id}' not found in sources.")

        source = sources[model_id]
        if source.get("disabled"):
            raise ValueError(source.get("disabledMessage") or "This model is currently disabled.")

        files_to_download = []
        if "files" in source:
            for f in source["files"]:
                files_to_download.append({
                    "url": f["url"],
                    "filename": f["name"]
                })
        else:
            files_to_download.append({
                "url": source["url"],
                "filename": source["filename"]
            })

        folder = source.get("folder", model_id)
        target_dir = MODELS_DIR / folder
        target_dir.mkdir(parents=True, exist_ok=True)

        # If already downloading, do nothing
        if model_id in self.downloads and self.downloads[model_id]["status"] == "downloading":
            return

        self.downloads[model_id] = {
            "status": "downloading",
            "progress": 0,
            "bytes_downloaded": 0,
            "total_bytes": 0,
            "error": None,
            "filename": files_to_download[0]["filename"] if len(files_to_download) == 1 else "multiple files",
        }

        import threading
        import urllib.request

        def _download_task():
            try:
                # 1. Fetch total size if possible
                total_size = 0
                for f_info in files_to_download:
                    try:
                        req = urllib.request.Request(
                            f_info["url"],
                            headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}
                        )
                        # Open and immediately check length, then close
                        with urllib.request.urlopen(req) as resp:
                            total_size += int(resp.headers.get('content-length', 0))
                    except Exception as e:
                        logger.debug("Failed checking content length for %s: %s", f_info["url"], e)
                
                self.downloads[model_id]["total_bytes"] = total_size
                
                bytes_so_far = 0
                block_size = 1024 * 1024  # 1MB blocks

                for f_info in files_to_download:
                    url = f_info["url"]
                    filename = f_info["filename"]
                    part_path = target_dir / f"{filename}.part"

                    logger.info("Starting download of file %s from %s", filename, url)
                    req = urllib.request.Request(
                        url,
                        headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}
                    )
                    response = urllib.request.urlopen(req)
                    self.active_responses[model_id] = response

                    try:
                        with open(part_path, "wb") as f:
                            while True:
                                if self.downloads.get(model_id, {}).get("status") == "cancelled":
                                    break
                                chunk = response.read(block_size)
                                if not chunk:
                                    break
                                f.write(chunk)
                                bytes_so_far += len(chunk)
                                self.downloads[model_id]["bytes_downloaded"] = bytes_so_far
                                if total_size > 0:
                                    progress = int((bytes_so_far / total_size) * 100)
                                    self.downloads[model_id]["progress"] = min(99, progress)  # Keep at 99 until fully validated & renamed
                                else:
                                    self.downloads[model_id]["progress"] = -1
                    finally:
                        response.close()
                        self.active_responses.pop(model_id, None)

                    if self.downloads.get(model_id, {}).get("status") == "cancelled":
                        break

                # Check if it was cancelled
                if self.downloads.get(model_id, {}).get("status") == "cancelled":
                    logger.info("Download of %s was cancelled.", model_id)
                    for f_info in files_to_download:
                        part_path = target_dir / f"{f_info['filename']}.part"
                        if part_path.exists():
                            try:
                                part_path.unlink()
                            except OSError:
                                pass
                    return

                # Validate all files before renaming
                for f_info in files_to_download:
                    filename = f_info["filename"]
                    part_path = target_dir / f"{filename}.part"
                    if not part_path.exists():
                        raise ValueError(f"Downloaded file {filename} does not exist.")
                    
                    # Only check size for non-mmproj files
                    if "mmproj" not in filename.lower():
                        file_size = part_path.stat().st_size
                        if file_size < _MIN_GGUF_SIZE:
                            raise ValueError(f"Downloaded file {filename} is too small ({file_size} bytes, min 100MB).")
                    
                    # Check GGUF magic for GGUF files
                    if filename.endswith(".gguf") and not self._has_gguf_magic(part_path):
                        raise ValueError(f"Downloaded file {filename} does not start with GGUF magic bytes.")

                # Rename all files to their target paths
                for f_info in files_to_download:
                    filename = f_info["filename"]
                    part_path = target_dir / f"{filename}.part"
                    target_path = target_dir / filename
                    if target_path.exists():
                        try:
                            target_path.unlink()
                        except OSError:
                            pass
                    part_path.rename(target_path)

                # Done! Validate magic and rescan
                self.downloads[model_id]["status"] = "completed"
                self.downloads[model_id]["progress"] = 100
                logger.info("Successfully downloaded %s files to %s", model_id, target_dir)
                self.scan_models()
            except Exception as e:
                # If we cancelled, we should not treat this as a standard download failure
                if self.downloads.get(model_id, {}).get("status") == "cancelled":
                    logger.info("Download of %s was cancelled during exception: %s", model_id, e)
                else:
                    logger.exception("Failed to download model %s", model_id)
                    self.downloads[model_id]["status"] = "failed"
                    self.downloads[model_id]["error"] = str(e)
                
                # Delete part files on failure
                for f_info in files_to_download:
                    part_path = target_dir / f"{f_info['filename']}.part"
                    if part_path.exists():
                        try:
                            part_path.unlink()
                        except OSError:
                            pass

        threading.Thread(target=_download_task, daemon=True).start()

    def cancel_pull(self, model_id: str) -> None:
        """Cancel an active background download."""
        if model_id not in self.downloads:
            return

        logger.info("Cancelling pull of model %s", model_id)

        # Mark as cancelled in state
        self.downloads[model_id]["status"] = "cancelled"
        self.downloads[model_id]["error"] = "Download cancelled"

        # Close the response object to abort the stream
        response = self.active_responses.pop(model_id, None)
        if response:
            try:
                response.close()
            except Exception as e:
                logger.warning("Error closing response object for %s: %s", model_id, e)

        # Clean up any partial files
        sources = self.get_pull_sources()
        if model_id in sources:
            source = sources[model_id]
            folder = source.get("folder", model_id)
            target_dir = MODELS_DIR / folder
            
            files_to_del = []
            if "files" in source:
                for f in source["files"]:
                    files_to_del.append(f["name"])
            else:
                files_to_del.append(source["filename"])
                
            for filename in files_to_del:
                part_path = target_dir / f"{filename}.part"
                tmp_path = target_dir / f"{filename}.tmp"
                for path_to_del in (part_path, tmp_path):
                    if path_to_del.exists():
                        try:
                            path_to_del.unlink()
                            logger.info("Deleted partial file: %s", path_to_del)
                        except OSError as e:
                            logger.warning("Failed to delete partial file %s: %s", path_to_del, e)


model_manager = ModelManager()

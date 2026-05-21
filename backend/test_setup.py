"""Quick sanity check for backend imports (no Ollama)."""

if __name__ == "__main__":
    from app.config import HOST, PORT, DATABASE_PATH

    print(f"[OK] Config: {HOST}:{PORT}")
    print(f"     Database: {DATABASE_PATH}")

    from app.services.llama_runtime import llama_runtime

    print(f"[OK] llama-cpp-python available: {llama_runtime.is_available}")

    from app.services.model_manager import model_manager

    model_manager.ensure_directories()
    n = len(model_manager.scan_models())
    print(f"[OK] Models folder: {model_manager.get_models_root()} ({n} GGUF file(s))")

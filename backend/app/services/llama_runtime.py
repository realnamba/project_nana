"""
llama_runtime.py — Standalone GGUF inference engine for Project Nana.
Loads .gguf model files directly using llama-cpp-python and generates
completions without requiring Ollama.

This is the core engine that makes Nana fully offline-capable.
"""

import asyncio
import logging
import threading
from pathlib import Path
from typing import AsyncGenerator, Optional

logger = logging.getLogger(__name__)

# Try to import llama_cpp — it's optional at import time
# so the app can still start even if the package isn't installed
try:
    # pyrefly: ignore [missing-import]
    from llama_cpp import Llama
    LLAMA_CPP_AVAILABLE = True
except ImportError:
    LLAMA_CPP_AVAILABLE = False
    logger.warning("llama-cpp-python is not installed. Standalone mode will be unavailable.")


class LlamaRuntime:
    """
    Manages a single loaded GGUF model and provides streaming inference.
    Designed for single-user local use on 16GB RAM machines.
    """

    def __init__(self):
        self._model: Optional[Llama] = None
        self._model_path: Optional[str] = None
        self._model_name: Optional[str] = None
        self._n_ctx: Optional[int] = None
        self._lock = threading.Lock()  # Prevent concurrent load/unload

    @property
    def is_available(self) -> bool:
        """Check if llama-cpp-python is installed."""
        return LLAMA_CPP_AVAILABLE

    @property
    def is_loaded(self) -> bool:
        """Check if a model is currently loaded in memory."""
        return self._model is not None

    @property
    def loaded_model_name(self) -> Optional[str]:
        """Return the name of the currently loaded model."""
        return self._model_name

    def get_status(self) -> dict:
        """Return runtime status info."""
        return {
            "available": self.is_available,
            "loaded": self.is_loaded,
            "model_name": self._model_name,
            "model_path": self._model_path,
        }

    def load_model(
        self,
        model_path: str,
        n_ctx: int = 2048,
        n_threads: int = 4,
        n_gpu_layers: int = 0,
        verbose: bool = False,
    ) -> bool:
        """
        Load a GGUF model file into memory.

        Args:
            model_path: Absolute path to the .gguf file
            n_ctx: Context window size (2048 is safe for 16GB RAM)
            n_threads: CPU threads for inference
            n_gpu_layers: GPU layers (0 = CPU only, safe default)
            verbose: Whether llama.cpp prints internal logs

        Returns:
            True if loaded successfully
        """
        if not LLAMA_CPP_AVAILABLE:
            raise RuntimeError("llama-cpp-python is not installed.")

        path = Path(model_path)
        if not path.exists() or not path.is_file():
            raise FileNotFoundError(f"Model file not found: {model_path}")
        if path.suffix.lower() != ".gguf":
            raise ValueError(f"Not a .gguf file: {model_path}")

        with self._lock:
            # Unload existing model first to free RAM
            if self._model is not None:
                logger.info("Unloading previous model: %s", self._model_name)
                del self._model
                self._model = None

            # Check if there is an mmproj file in the same directory
            projector_path = None
            if path.parent.is_dir():
                for f in path.parent.iterdir():
                    fname = f.name.lower()
                    if f.is_file() and (fname.startswith("mmproj") or fname.startswith("projector")) and fname.endswith(".gguf"):
                        projector_path = f
                        break

            chat_handler = None
            if projector_path:
                logger.info("Found projection model for vision: %s", projector_path.name)
                model_name_lower = path.name.lower()
                if "minicpm" in model_name_lower:
                    try:
                        from llama_cpp.llama_chat_format import MiniCPMv26ChatHandler
                        chat_handler = MiniCPMv26ChatHandler(clip_model_path=str(projector_path), verbose=verbose)
                        logger.info("Using MiniCPMv26ChatHandler for vision support.")
                    except Exception as ex:
                        logger.warning("Could not load MiniCPMv26ChatHandler: %s. Falling back to Llava15ChatHandler.", ex)
                
                if not chat_handler:
                    try:
                        from llama_cpp.llama_chat_format import Llava15ChatHandler
                        chat_handler = Llava15ChatHandler(clip_model_path=str(projector_path), verbose=verbose)
                        logger.info("Using Llava15ChatHandler for vision support.")
                    except Exception as ex:
                        logger.error("Could not load Llava15ChatHandler: %s", ex)

            logger.info("Loading GGUF model: %s (ctx=%d, threads=%d, gpu_layers=%d, vision=%s)",
                        path.name, n_ctx, n_threads, n_gpu_layers, chat_handler is not None)

            try:
                self._model = Llama(
                    model_path=str(path),
                    n_ctx=n_ctx,
                    n_threads=n_threads,
                    n_gpu_layers=n_gpu_layers,
                    verbose=verbose,
                    chat_handler=chat_handler,
                )
                self._model_path = str(path)
                self._model_name = path.stem
                self._n_ctx = n_ctx
                logger.info("✓ Model loaded: %s", self._model_name)
                return True
            except Exception as e:
                logger.error("Failed to load model %s: %s", path.name, e)
                self._model = None
                self._model_path = None
                self._model_name = None
                self._n_ctx = None
                raise

    def unload_model(self):
        """Unload the current model and free RAM."""
        with self._lock:
            if self._model is not None:
                name = self._model_name
                del self._model
                self._model = None
                self._model_path = None
                self._model_name = None
                self._n_ctx = None
                logger.info("Model unloaded: %s", name)

    def _generate_sync(
        self,
        prompt: str,
        system: Optional[str] = None,
        temperature: float = 0.7,
        max_tokens: int = 4096,
        top_p: float = 0.95,
        repeat_penalty: float = 1.1,
    ):
        """
        Synchronous streaming generator. Yields token strings one at a time.
        This runs in a thread so it doesn't block the async event loop.
        """
        if self._model is None:
            raise RuntimeError("No model loaded. Call load_model() first.")

        # ChatML special token (split so editors don't mangle it)
        _im_end = "<|" + "im_end|>"

        # Build the full prompt with system message
        if system:
            full_prompt = (
                f"<|im_start|>system\n{system}{_im_end}\n"
                f"<|im_start|>user\n{prompt}{_im_end}\n"
                f"<|im_start|>assistant\n"
            )
        else:
            full_prompt = (
                f"<|im_start|>user\n{prompt}{_im_end}\n"
                f"<|im_start|>assistant\n"
            )

        # Stream tokens using llama-cpp-python's built-in streaming
        stream = self._model.create_completion(
            prompt=full_prompt,
            max_tokens=max_tokens,
            temperature=temperature,
            top_p=top_p,
            repeat_penalty=repeat_penalty,
            stream=True,
            stop=[_im_end, "<|im_start|>"],
        )

        for chunk in stream:
            token_text = chunk["choices"][0]["text"]
            if token_text:
                yield token_text

    async def generate_stream(
        self,
        prompt: str,
        system: Optional[str] = None,
        temperature: float = 0.7,
        max_tokens: int = 4096,
    ) -> AsyncGenerator[str, None]:
        """
        Async streaming generator. Yields tokens for SSE streaming.
        Runs the synchronous llama.cpp inference in a thread pool
        so FastAPI's async event loop isn't blocked.
        """
        if self._model is None:
            raise RuntimeError("No model loaded. Call load_model() first.")

        loop = asyncio.get_event_loop()

        # We use a queue to bridge sync generator → async generator
        queue: asyncio.Queue[Optional[str]] = asyncio.Queue()
        error_holder = [None]

        def _run_inference():
            try:
                for token in self._generate_sync(
                    prompt=prompt,
                    system=system,
                    temperature=temperature,
                    max_tokens=max_tokens,
                ):
                    loop.call_soon_threadsafe(queue.put_nowait, token)
                # Signal completion
                loop.call_soon_threadsafe(queue.put_nowait, None)
            except Exception as e:
                error_holder[0] = e
                loop.call_soon_threadsafe(queue.put_nowait, None)

        # Run inference in a background thread
        thread = threading.Thread(target=_run_inference, daemon=True)
        thread.start()

        # Yield tokens as they arrive
        while True:
            token = await queue.get()
            if token is None:
                break
            yield token

        # Check if inference thread raised an error
        if error_holder[0] is not None:
            raise error_holder[0]

    async def generate_full(
        self,
        prompt: str,
        system: Optional[str] = None,
        temperature: float = 0.7,
        max_tokens: int = 4096,
    ) -> str:
        """
        Non-streaming generation — returns the full response as a single string.
        Used for vision analysis or any case where we need the complete text.
        """
        tokens = []
        async for token in self.generate_stream(
            prompt=prompt,
            system=system,
            temperature=temperature,
            max_tokens=max_tokens,
        ):
            tokens.append(token)
        return "".join(tokens)

    def _generate_chat_sync(
        self,
        messages: list,
        temperature: float = 0.7,
        max_tokens: int = 4096,
        top_p: float = 0.95,
        repeat_penalty: float = 1.1,
    ):
        """
        Synchronous streaming chat generator. Yields token strings one at a time.
        """
        if self._model is None:
            raise RuntimeError("No model loaded. Call load_model() first.")

        stream = self._model.create_chat_completion(
            messages=messages,
            max_tokens=max_tokens,
            temperature=temperature,
            top_p=top_p,
            repeat_penalty=repeat_penalty,
            stream=True,
        )

        for chunk in stream:
            if "choices" in chunk and len(chunk["choices"]) > 0:
                delta = chunk["choices"][0].get("delta", {})
                token_text = delta.get("content")
                if token_text:
                    yield token_text

    async def generate_chat_stream(
        self,
        messages: list,
        temperature: float = 0.7,
        max_tokens: int = 4096,
    ) -> AsyncGenerator[str, None]:
        """
        Async streaming chat generator. Yields tokens for SSE streaming.
        Runs the synchronous llama.cpp chat inference in a thread pool.
        """
        if self._model is None:
            raise RuntimeError("No model loaded. Call load_model() first.")

        loop = asyncio.get_event_loop()
        queue: asyncio.Queue[Optional[str]] = asyncio.Queue()
        error_holder = [None]

        def _run_inference():
            try:
                for token in self._generate_chat_sync(
                    messages=messages,
                    temperature=temperature,
                    max_tokens=max_tokens,
                ):
                    loop.call_soon_threadsafe(queue.put_nowait, token)
                loop.call_soon_threadsafe(queue.put_nowait, None)
            except Exception as e:
                error_holder[0] = e
                loop.call_soon_threadsafe(queue.put_nowait, None)

        thread = threading.Thread(target=_run_inference, daemon=True)
        thread.start()

        while True:
            token = await queue.get()
            if token is None:
                break
            yield token

        if error_holder[0] is not None:
            raise error_holder[0]


# Singleton instance — import this in other modules
llama_runtime = LlamaRuntime()

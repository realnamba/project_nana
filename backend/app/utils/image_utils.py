"""
image_utils.py — Image preprocessing utilities.
Resizes and compresses images before sending to Ollama to save RAM and speed up inference.
"""

import base64
import io
from PIL import Image
from app.config import MAX_IMAGE_DIMENSION, JPEG_QUALITY


def preprocess_image_base64(image_b64: str) -> str:
    """
    Takes a base64-encoded image (PNG/JPEG), resizes it to fit within
    MAX_IMAGE_DIMENSION, compresses as JPEG, and returns new base64 string.

    This is critical for 16GB RAM — MiniCPM-V processes images faster
    when they're not unnecessarily large.
    """
    # Strip data URI prefix if present (e.g., "data:image/png;base64,...")
    if "," in image_b64:
        image_b64 = image_b64.split(",", 1)[1]

    # Decode base64 → PIL Image
    image_bytes = base64.b64decode(image_b64)
    image = Image.open(io.BytesIO(image_bytes))

    # Convert RGBA → RGB (JPEG doesn't support alpha channel)
    if image.mode in ("RGBA", "LA", "P"):
        image = image.convert("RGB")

    # Resize if larger than max dimension (preserve aspect ratio)
    width, height = image.size
    if max(width, height) > MAX_IMAGE_DIMENSION:
        ratio = MAX_IMAGE_DIMENSION / max(width, height)
        new_size = (int(width * ratio), int(height * ratio))
        image = image.resize(new_size, Image.LANCZOS)

    # Compress to JPEG and re-encode to base64
    buffer = io.BytesIO()
    image.save(buffer, format="JPEG", quality=JPEG_QUALITY, optimize=True)
    compressed_b64 = base64.b64encode(buffer.getvalue()).decode("utf-8")

    return compressed_b64

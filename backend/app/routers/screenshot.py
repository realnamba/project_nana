"""
screenshot.py — Screenshot capture and analysis router.
Provides endpoint for direct screenshot analysis and local screen capture using mss.
"""

import base64
import io
import logging
from fastapi import APIRouter
from app.models.schemas import ScreenshotRequest, ScreenshotResponse
from app.services.vision_pipeline import analyze_screenshot

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["screenshot"])


@router.post("/screenshot/analyze", response_model=ScreenshotResponse)
async def analyze_image(request: ScreenshotRequest):
    """Analyze a base64-encoded screenshot with the vision model."""
    analysis, elapsed = await analyze_screenshot(request.image_base64, request.prompt)
    return ScreenshotResponse(analysis=analysis, processing_time=elapsed)


@router.post("/screenshot/capture")
async def capture_screen():
    """
    Capture the primary monitor using mss (Python screenshot library).
    Returns the screenshot as base64 for the frontend to preview/send.
    """
    try:
        import mss
        with mss.mss() as sct:
            # Capture primary monitor
            monitor = sct.monitors[1]  # [0] is "all monitors combined"
            screenshot = sct.grab(monitor)

            # Convert to PNG bytes
            from PIL import Image
            img = Image.frombytes("RGB", screenshot.size, screenshot.bgra, "raw", "BGRX")
            buffer = io.BytesIO()
            img.save(buffer, format="PNG")
            img_b64 = base64.b64encode(buffer.getvalue()).decode("utf-8")

            return {
                "image_base64": img_b64,
                "width": screenshot.width,
                "height": screenshot.height,
            }
    except Exception as e:
        logger.error("Screen capture failed: %s", e)
        return {"error": str(e)}

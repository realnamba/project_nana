"""
terminal.py - Router for executing terminal commands within the workspace.
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from app.services.terminal_service import terminal_service
from app.routers.workspace import ACTIVE_WORKSPACE

router = APIRouter(prefix="/api/terminal", tags=["terminal"])

class RunCommandRequest(BaseModel):
    command: str

class StopCommandRequest(BaseModel):
    task_id: str

@router.post("/run")
async def run_command(request: RunCommandRequest):
    if not ACTIVE_WORKSPACE:
        raise HTTPException(status_code=400, detail="No active workspace connected.")
    
    try:
        task_id = await terminal_service.run_command(request.command, str(ACTIVE_WORKSPACE.resolve()))
        return {"status": "success", "task_id": task_id}
    except ValueError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/stop")
async def stop_command(request: StopCommandRequest):
    try:
        terminal_service.stop_command(request.task_id)
        return {"status": "success"}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@router.get("/status/{task_id}")
async def get_status(task_id: str):
    status = terminal_service.get_status(task_id)
    if "error" in status and status["error"] == "Task not found":
        raise HTTPException(status_code=404, detail="Task not found")
    return status

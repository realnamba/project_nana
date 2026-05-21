"""
terminal_service.py - Manages background terminal processes safely.
"""

import asyncio
import logging
import subprocess
import os
import uuid
from typing import Dict, Optional

logger = logging.getLogger(__name__)

# Basic dangerous command filtering
BLOCKED_TERMS = ["rm -rf /", "del /s", "format", "shutdown", "mkfs", ":(){ :|:& };:"]

class TerminalTask:
    def __init__(self, task_id: str, command: str, cwd: str):
        self.task_id = task_id
        self.command = command
        self.cwd = cwd
        self.process: Optional[subprocess.Popen] = None
        self.output: str = ""
        self.is_running = False
        self.error: Optional[str] = None

class TerminalService:
    def __init__(self):
        self.tasks: Dict[str, TerminalTask] = {}

    def _is_safe(self, command: str) -> bool:
        cmd_lower = command.lower()
        for term in BLOCKED_TERMS:
            if term in cmd_lower:
                return False
        return True

    async def run_command(self, command: str, cwd: str) -> str:
        if not self._is_safe(command):
            raise ValueError("Command contains blocked terms and cannot be executed.")

        task_id = str(uuid.uuid4())
        task = TerminalTask(task_id, command, cwd)
        self.tasks[task_id] = task
        
        # Start async task to run subprocess and capture output
        asyncio.create_task(self._execute(task))
        return task_id

    async def _execute(self, task: TerminalTask):
        task.is_running = True
        try:
            # We use asyncio.create_subprocess_shell
            proc = await asyncio.create_subprocess_shell(
                task.command,
                cwd=task.cwd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT
            )
            
            # Note: We store the pid if we need to kill it
            # But asyncio.subprocess handles its own object
            # We will use proc.terminate() for stopping
            task.process = proc

            if proc.stdout:
                while True:
                    line = await proc.stdout.readline()
                    if not line:
                        break
                    decoded = line.decode('utf-8', errors='replace')
                    task.output += decoded
            
            await proc.wait()
            
        except Exception as e:
            task.error = str(e)
            task.output += f"\n[Error: {e}]"
            logger.error("Terminal execution error: %s", e)
        finally:
            task.is_running = False

    def stop_command(self, task_id: str):
        task = self.tasks.get(task_id)
        if not task:
            raise ValueError("Task not found")
        if task.is_running and hasattr(task, 'process') and task.process:
            try:
                task.process.terminate()
                task.output += "\n[Process Terminated by User]"
            except Exception as e:
                logger.error("Failed to terminate process: %s", e)

    def get_status(self, task_id: str) -> dict:
        task = self.tasks.get(task_id)
        if not task:
            return {"error": "Task not found"}
        return {
            "task_id": task.task_id,
            "command": task.command,
            "cwd": task.cwd,
            "output": task.output,
            "is_running": task.is_running,
            "error": task.error
        }

terminal_service = TerminalService()

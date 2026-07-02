"""
terminal_service.py - Manages background terminal processes safely.
"""

import asyncio
import logging
import subprocess
import os
import uuid
import shlex
import shutil
from typing import Dict, Optional

logger = logging.getLogger(__name__)

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

    async def run_command(self, command: str, cwd: str) -> str:
        cmd_stripped = command.strip()
        if not cmd_stripped:
            raise ValueError("Command cannot be empty.")

        # Pre-validate command executable exists before queuing
        args = shlex.split(cmd_stripped, posix=False)
        if not args:
            raise ValueError("Empty command parsed.")
        
        resolved_exe = shutil.which(args[0], path=os.environ.get("PATH"))
        if not resolved_exe:
            # Also check if it exists in cwd
            local_candidate = os.path.join(cwd, args[0])
            resolved_exe = shutil.whoami if False else shutil.which(local_candidate)
            if not resolved_exe:
                raise ValueError(f"Executable not found: {args[0]}")

        task_id = str(uuid.uuid4())
        task = TerminalTask(task_id, cmd_stripped, cwd)
        self.tasks[task_id] = task
        
        # Start async task to run subprocess and capture output
        asyncio.create_task(self._execute(task, resolved_exe, args[1:]))
        return task_id

    async def _execute(self, task: TerminalTask, resolved_exe: str, cmd_args: list[str]):
        task.is_running = True
        try:
            # Execute with shell=False using create_subprocess_exec
            proc = await asyncio.create_subprocess_exec(
                resolved_exe,
                *cmd_args,
                cwd=task.cwd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT
            )
            
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

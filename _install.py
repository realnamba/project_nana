import subprocess, sys, os

venv_pip = os.path.join(os.path.dirname(__file__), "backend", "venv", "Scripts", "pip.exe")
packages = [
    "fastapi", "uvicorn[standard]", "httpx", "sse-starlette",
    "pydantic", "aiosqlite", "Pillow", "python-dotenv", "mss"
]

print(f"Using pip: {venv_pip}")
print(f"Installing: {', '.join(packages)}")
result = subprocess.run([venv_pip, "install"] + packages, capture_output=False)
sys.exit(result.returncode)

"""Entry point for the packaged StatsTool desktop app.

Serves the built frontend and the API from one local port, then opens a browser.
Everything runs on this machine — no data is sent anywhere. In a packaged build
the frontend is bundled as ``frontend_dist``; in dev it falls back to
``frontend/dist`` (run ``npm run build`` first).
"""

from __future__ import annotations

import os
import socket
import sys
import threading
import webbrowser
from pathlib import Path

_HERE = Path(__file__).resolve().parent  # backend/ in dev, bundle dir when frozen
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))


def _resource_dir() -> Path:
    base = getattr(sys, "_MEIPASS", None)  # PyInstaller unpack dir
    return Path(base) if base else _HERE


def _dist_dir() -> Path:
    bundled = _resource_dir() / "frontend_dist"
    if bundled.is_dir():
        return bundled
    return _HERE.parent / "frontend" / "dist"


def _choose_port(preferred: int) -> int:
    """Use the preferred port if free, otherwise an available one."""
    for port in (preferred, 0):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", port))
                return s.getsockname()[1]
            except OSError:
                continue
    return preferred


def main() -> None:
    import uvicorn
    from fastapi.staticfiles import StaticFiles

    from app.main import app

    dist = _dist_dir()
    if dist.is_dir():
        # Mounted last so the /api routes still take precedence.
        app.mount("/", StaticFiles(directory=str(dist), html=True), name="frontend")

    port = _choose_port(int(os.environ.get("STATSTOOL_PORT", "8000")))
    url = f"http://127.0.0.1:{port}/"
    threading.Timer(1.5, lambda: webbrowser.open(url)).start()
    print(f"StatsTool is running at {url}")
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")


if __name__ == "__main__":
    main()

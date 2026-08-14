"""Pytest bootstrap for Cutarr.

The backend modules use flat imports (`import plex`), not package imports, so
the tests need `backend/` on `sys.path`. This conftest lives at the repo root
and loads before collection, which makes `pytest` runnable from the repo root
with no PYTHONPATH juggling (and mirrors what CI does).
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "backend"))

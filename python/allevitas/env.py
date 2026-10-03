"""
allevitas-agent-kit - Lightweight environment variable (.env) loader
Loads .env without external dependencies (e.g. python-dotenv), using standard library only.
"""

import os
from typing import Optional


def load_dotenv(custom_path: Optional[str] = None) -> bool:
    """
    Search and load unset environment variables from .env files.
    Does not overwrite existing environment variables in os.environ.
    """
    candidates = []
    if custom_path:
        candidates.append(os.path.abspath(custom_path))
    else:
        # 1. Around current working directory
        candidates.append(os.path.abspath(".env"))
        candidates.append(os.path.abspath(os.path.join("examples", ".env")))
        # 2. Relative paths from this file
        this_dir = os.path.dirname(os.path.abspath(__file__))
        candidates.append(os.path.abspath(os.path.join(this_dir, "..", ".env")))
        candidates.append(os.path.abspath(os.path.join(this_dir, "..", "examples", ".env")))
        candidates.append(os.path.abspath(os.path.join(this_dir, "..", "..", ".env")))
        candidates.append(os.path.abspath(os.path.join(this_dir, "..", "..", "examples", ".env")))

    for path in candidates:
        if os.path.isfile(path):
            try:
                with open(path, "r", encoding="utf-8") as f:
                    for line in f:
                        line = line.strip()
                        if not line or line.startswith("#"):
                            continue
                        if "=" in line:
                            key, val = line.split("=", 1)
                            key = key.strip()
                            val = val.strip().strip("'\"")
                            if key and key not in os.environ:
                                os.environ[key] = val
                return True
            except Exception:
                pass
    return False

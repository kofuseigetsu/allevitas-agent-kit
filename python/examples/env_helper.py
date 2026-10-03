"""
allevitas-agent-kit - environment variable loader for examples (zero external dependencies)
"""

import os
from typing import Optional


def load_env(custom_path: Optional[str] = None) -> None:
    candidates = [
        custom_path,
        os.path.abspath(".env"),
        os.path.abspath(os.path.join("examples", ".env")),
        os.path.abspath(os.path.join(os.path.dirname(__file__), ".env")),
    ]

    for env_path in candidates:
        if env_path and os.path.exists(env_path):
            try:
                with open(env_path, "r", encoding="utf-8") as f:
                    for line in f:
                        line = line.strip()
                        if not line or line.startswith("#"):
                            continue
                        if "=" in line:
                            key, val = line.split("=", 1)
                            key = key.strip()
                            val = val.strip()
                            if (val.startswith('"') and val.endswith('"')) or (
                                val.startswith("'") and val.endswith("'")
                            ):
                                val = val[1:-1]
                            if key not in os.environ:
                                os.environ[key] = val
                return
            except Exception:
                pass

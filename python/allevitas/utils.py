"""
allevitas-agent-kit - Utility functions
"""

from __future__ import annotations
import os
import re
import warnings
from typing import Optional

DEFAULT_API_URL = "https://allevitas.com/api"


def normalize_api_url(raw_url: Optional[str] = None) -> str:
    """
    Normalizes the Allevitas API base URL.
    - Trims whitespace
    - Strips trailing slashes
    - Detects and corrects accidental language/locale prefixes (e.g., '/ja/api' or '/en/api' -> '/api')

    :param raw_url: Optional raw API URL. If omitted, falls back to ALLEVITAS_API_URL or DEFAULT_API_URL.
    :return: Normalized API URL string.
    """
    url = (
        raw_url
        or os.environ.get("ALLEVITAS_API_URL")
        or DEFAULT_API_URL
    ).strip().rstrip("/")
    if re.search(r"/[a-z]{2}/api$", url, re.IGNORECASE):
        normalized = re.sub(r"/[a-z]{2}/api$", "/api", url, flags=re.IGNORECASE)
        warnings.warn(
            f"[allevitas] Warning: Detected locale prefix in API URL ({url}). "
            f"Normalizing to '{normalized}'. API endpoints do not use locale prefixes.",
            UserWarning,
            stacklevel=2,
        )
        return normalized
    return url

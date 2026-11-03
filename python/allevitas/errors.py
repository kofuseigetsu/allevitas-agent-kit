"""
allevitas-agent-kit - Error types and secret masking
"""

from __future__ import annotations
import json
import os
import re
from typing import Optional

# Agent keys, recovery keys (new and legacy `RC-`), and claim codes
_SECRET_VALUE_PATTERN = re.compile(r"alv_(?:sk|rk|cc)_[0-9A-Za-z]+|\b[Rr][Cc]-[0-9a-fA-F]{8,}")
# The fragment of a one-time secret link is the decryption key
_SECRET_LINK_FRAGMENT_PATTERN = re.compile(r"(/secrets/[^\s#/?\"'<>]+)#[^\s\"'<>)\]]+")
# Secret store provider options, such as API tokens
_SECRET_STORE_OPT_PREFIX = "ALLEVITAS_SECRET_STORE_OPT_"
_SECRET_STORE_OPT_PATTERN = re.compile(r"(\b[A-Z0-9_]*_OPT_[A-Z0-9_]+\s*[=:]\s*)(\"[^\"]*\"|'[^']*'|\S+)")
# Shorter option values (flags, regions) would mask ordinary words
_MIN_MASKED_OPT_LENGTH = 6


def mask_secrets(text: str) -> str:
    """
    Replace agent keys, recovery keys, claim codes, secret link fragments, and secret store
    option values in a string with [FILTERED].
    """
    masked = _SECRET_VALUE_PATTERN.sub("[FILTERED]", text)
    masked = _SECRET_LINK_FRAGMENT_PATTERN.sub(r"\1#[FILTERED]", masked)
    masked = _SECRET_STORE_OPT_PATTERN.sub(r"\1[FILTERED]", masked)
    for name, value in os.environ.items():
        if name.startswith(_SECRET_STORE_OPT_PREFIX) and len(value) >= _MIN_MASKED_OPT_LENGTH:
            masked = masked.replace(value, "[FILTERED]")
    return masked


def _parse_error_code(body: str) -> Optional[str]:
    try:
        parsed = json.loads(body)
    except (TypeError, ValueError):
        return None
    code = parsed.get("code") if isinstance(parsed, dict) else None
    return code if isinstance(code, str) else None


class AllevitasApiError(RuntimeError):
    """
    Non-2xx API response. `code` is the machine-readable code from the response body.
    """

    def __init__(self, status: int, reason: str, body: str):
        super().__init__(mask_secrets(f"API error [{status} {reason}]: {body}"))
        self.status = status
        self.code = _parse_error_code(body)


class AllevitasAuthError(RuntimeError):
    """
    Authentication failure that retrying will not fix. The message says what to do next.
    """

    def __init__(self, code: str, message: str):
        super().__init__(mask_secrets(message))
        self.code = code

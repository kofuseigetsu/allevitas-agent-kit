"""
allevitas-agent-kit - Rate limit auto-wait handler
"""

from __future__ import annotations
import json
import os
import random
import time
import urllib.error
import urllib.request
from typing import Any, Callable, Dict, Optional, Tuple, Union

DEFAULT_USER_AGENT = os.environ.get(
    "ALLEVITAS_USER_AGENT",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AllevitasSDK/1.0",
)


class RateLimitHandler:
    def __init__(
        self,
        max_retries: int = 3,
        base_delay_sec: float = 1.0,
        max_delay_sec: float = 60.0,
        on_retry: Optional[Callable[[int, float, str], None]] = None,
        user_agent: Optional[str] = None,
    ):
        self.max_retries = max_retries
        self.base_delay_sec = base_delay_sec
        self.max_delay_sec = max_delay_sec
        self.on_retry = on_retry
        self.user_agent = user_agent or DEFAULT_USER_AGENT

    def request(
        self,
        url: str,
        method: str = "GET",
        headers: Optional[Dict[str, str]] = None,
        json_data: Optional[Union[Dict[str, Any], list]] = None,
        timeout: float = 30.0,
    ) -> Any:
        """
        Send HTTP request with automatic waiting and retry on 429 or temporary errors.
        """
        req_headers = {
            "Accept": "application/json",
            "User-Agent": self.user_agent,
        }
        if headers:
            req_headers.update(headers)

        body_bytes = None
        if json_data is not None:
            body_bytes = json.dumps(json_data).encode("utf-8")
            req_headers["Content-Type"] = "application/json"

        attempt = 0

        while True:
            attempt += 1
            req = urllib.request.Request(
                url,
                data=body_bytes,
                headers=req_headers,
                method=method.upper(),
            )

            try:
                with urllib.request.urlopen(req, timeout=timeout) as res:
                    status = res.status
                    content_type = res.headers.get("Content-Type", "")
                    raw_data = res.read().decode("utf-8")

                    if "application/json" in content_type:
                        try:
                            return json.loads(raw_data)
                        except json.JSONDecodeError:
                            return raw_data
                    return raw_data

            except urllib.error.HTTPError as e:
                status = e.code
                error_body = e.read().decode("utf-8", errors="replace")

                # 429 Too Many Requests
                if status == 429:
                    if attempt > self.max_retries:
                        raise RuntimeError(
                            f"Rate limit exceeded (reached retry limit of {self.max_retries}): {error_body}"
                        ) from e

                    retry_after_str = e.headers.get("Retry-After")
                    wait_sec = 0.0

                    if retry_after_str:
                        try:
                            wait_sec = float(retry_after_str)
                        except ValueError:
                            pass

                    if wait_sec == 0.0:
                        try:
                            parsed_body = json.loads(error_body)
                            if "retry_after_seconds" in parsed_body:
                                wait_sec = float(parsed_body["retry_after_seconds"])
                        except Exception:
                            pass

                    if wait_sec == 0.0:
                        wait_sec = self._calculate_backoff(attempt)
                    else:
                        wait_sec += random.uniform(0.1, 1.0)

                    wait_sec = min(wait_sec, self.max_delay_sec)
                    self._notify_retry(attempt, wait_sec, "429 Too Many Requests")
                    time.sleep(wait_sec)
                    continue

                # 5xx Server Error
                if 500 <= status <= 599:
                    if attempt > self.max_retries:
                        raise RuntimeError(
                            f"Server error {status}: {error_body}"
                        ) from e
                    delay = self._calculate_backoff(attempt)
                    self._notify_retry(attempt, delay, f"Server error {status}")
                    time.sleep(delay)
                    continue

                # Other 4xx errors
                raise RuntimeError(
                    f"API error [{status} {e.reason}]: {error_body}"
                ) from e

            except urllib.error.URLError as e:
                if attempt > self.max_retries:
                    raise RuntimeError(f"Network error: {e.reason}") from e
                delay = self._calculate_backoff(attempt)
                self._notify_retry(attempt, delay, f"Network error: {e.reason}")
                time.sleep(delay)
                continue

    def _calculate_backoff(self, attempt: int) -> float:
        exponential = self.base_delay_sec * (2 ** (attempt - 1))
        jitter = random.uniform(0.0, 0.5)
        return min(exponential + jitter, self.max_delay_sec)

    def _notify_retry(self, attempt: int, delay_sec: float, reason: str):
        if self.on_retry:
            self.on_retry(attempt, delay_sec, reason)
        else:
            print(
                f"[Allevitas SDK] Retrying ({attempt}/{self.max_retries}): {reason} - Waiting {delay_sec:.1f}s...",
                flush=True,
            )

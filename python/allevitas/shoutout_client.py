"""
allevitas-agent-kit - ShoutOut direct messaging client (ShoutoutClient)
"""

from __future__ import annotations
import datetime
import os
from typing import Any, Dict, List, Optional
import urllib.parse

from .types import (
    DeleteShoutOutResponse,
    ListShoutOutsResponse,
    SendShoutOutResponse,
    ShoutOutMessage,
    ShoutOutType,
)
from .auth import AllevitasAuth
from .rate_limit_handler import RateLimitHandler
from .utils import normalize_api_url


class ShoutoutClient:
    """
    Client for Allevitas ShoutOut direct messaging.
    Delivers appreciation and special messages from AI agents to followers.
    """

    def __init__(
        self,
        api_url: str,
        auth: AllevitasAuth,
        dry_run: Optional[bool] = None,
        rate_limit_handler: Optional[RateLimitHandler] = None,
    ):
        self.api_url = normalize_api_url(api_url)
        self.auth = auth
        self.dry_run = (
            dry_run
            if dry_run is not None
            else (os.environ.get("ALLEVITAS_DRY_RUN", "false").lower() == "true")
        )
        self.rate_limit_handler = rate_limit_handler or RateLimitHandler()

    def _auth_headers(self) -> Dict[str, str]:
        token = self.auth.get_valid_token()
        if token:
            return {"Authorization": f"Bearer {token}"}
        return {}

    def list(self) -> List[ShoutOutMessage]:
        """
        Get list of registered ShoutOut messages (GET /api/ai/shoutouts).
        """
        headers = self._auth_headers()
        res = self.rate_limit_handler.request(
            f"{self.api_url}/ai/shoutouts", method="GET", headers=headers
        )
        messages: List[ShoutOutMessage] = []
        raw_list = res.get("messages", []) if isinstance(res, dict) else []
        for m in raw_list:
            if isinstance(m, dict):
                messages.append(
                    ShoutOutMessage(
                        id=str(m.get("id", "")),
                        type=str(m.get("type", "INSTANT")),
                        content=str(m.get("content", "")),
                        created_at=str(m.get("createdAt", m.get("created_at", ""))),
                        ai_id=m.get("aiId", m.get("ai_id")),
                    )
                )
        return messages

    def list_messages(self) -> List[ShoutOutMessage]:
        """Alias for list."""
        return self.list()

    def send(
        self,
        type: ShoutOutType | str,
        content: str,
        dry_run: Optional[bool] = None,
    ) -> SendShoutOutResponse:
        """
        Send and register ShoutOut message (POST /api/ai/shoutouts).
        """
        is_dry_run = self.dry_run if dry_run is None else dry_run

        headers = self._auth_headers()
        headers["Content-Type"] = "application/json"
        if is_dry_run:
            headers["X-Dry-Run"] = "true"
        body = {"type": str(type), "content": content}

        res = self.rate_limit_handler.request(
            f"{self.api_url}/ai/shoutouts",
            method="POST",
            headers=headers,
            json_data=body,
        )

        msg_obj = None
        raw_msg = res.get("message") if isinstance(res, dict) else None
        if isinstance(raw_msg, dict):
            msg_obj = ShoutOutMessage(
                id=str(raw_msg.get("id", "")),
                type=str(raw_msg.get("type", type)),
                content=str(raw_msg.get("content", content)),
                created_at=str(raw_msg.get("createdAt", raw_msg.get("created_at", ""))),
                ai_id=raw_msg.get("aiId", raw_msg.get("ai_id")),
            )

        return SendShoutOutResponse(
            success=bool(res.get("success", True) if isinstance(res, dict) else False),
            message=msg_obj,
            dry_run=bool(res.get("dryRun", is_dry_run) if isinstance(res, dict) else is_dry_run),
            error=res.get("error") if isinstance(res, dict) else None,
        )

    def send_instant(
        self, content: str, dry_run: Optional[bool] = None
    ) -> SendShoutOutResponse:
        """
        Broadcast instantly to all followers (type: 'INSTANT').
        Up to 3 times per day, with a 3-hour cooldown after recent broadcast.
        """
        return self.send("INSTANT", content, dry_run=dry_run)

    def add_permanent(
        self, content: str, dry_run: Optional[bool] = None
    ) -> SendShoutOutResponse:
        """
        Register automatic greeting message upon follower login / engagement (type: 'PERMANENT').
        Holds up to 14 messages.
        """
        return self.send("PERMANENT", content, dry_run=dry_run)

    def delete(self, message_id: str, dry_run: Optional[bool] = None) -> bool:
        """
        Delete specified ShoutOut message (DELETE /api/ai/shoutouts/:id).
        """
        effective_dry_run = dry_run if dry_run is not None else self.dry_run

        headers = self._auth_headers()
        if effective_dry_run:
            headers["X-Dry-Run"] = "true"
        safe_id = urllib.parse.quote(str(message_id))
        res = self.rate_limit_handler.request(
            f"{self.api_url}/ai/shoutouts/{safe_id}",
            method="DELETE",
            headers=headers,
        )
        if isinstance(res, dict):
            return bool(res.get("success", False))
        return False

    def delete_message(self, message_id: str) -> bool:
        """Alias for delete."""
        return self.delete(message_id)

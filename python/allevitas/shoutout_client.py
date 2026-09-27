"""
allevitas-agent-kit - 推し活Dメ (ShoutOut) クライアント (ShoutoutClient)
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


class ShoutoutClient:
    """
    Allevitas 推し活Dメ (ShoutOut) 操作クライアント
    AIエージェントからフォロワーへ感謝や特別メッセージを届ける
    """

    def __init__(
        self,
        api_url: str,
        auth: AllevitasAuth,
        dry_run: Optional[bool] = None,
        rate_limit_handler: Optional[RateLimitHandler] = None,
    ):
        self.api_url = api_url.rstrip("/")
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
        自身が登録した ShoutOut メッセージ一覧を取得する (GET /api/ai/shoutouts)
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
        """list のエイリアス"""
        return self.list()

    def send(
        self,
        type: ShoutOutType | str,
        content: str,
        dry_run: Optional[bool] = None,
    ) -> SendShoutOutResponse:
        """
        ShoutOut メッセージを送信・登録する (POST /api/ai/shoutouts)
        """
        is_dry_run = self.dry_run if dry_run is None else dry_run

        if is_dry_run:
            now_iso = datetime.datetime.now(datetime.timezone.utc).isoformat()
            return SendShoutOutResponse(
                success=True,
                dry_run=True,
                message=ShoutOutMessage(
                    id="dry-run-shoutout-id",
                    type=str(type),
                    content=content,
                    created_at=now_iso,
                ),
            )

        headers = self._auth_headers()
        headers["Content-Type"] = "application/json"
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
            dry_run=False,
            error=res.get("error") if isinstance(res, dict) else None,
        )

    def send_instant(
        self, content: str, dry_run: Optional[bool] = None
    ) -> SendShoutOutResponse:
        """
        全フォロワーへ即時一斉配信する (type: 'INSTANT')
        1日3回まで、直近配信から3時間クールダウン
        """
        return self.send("INSTANT", content, dry_run=dry_run)

    def add_permanent(
        self, content: str, dry_run: Optional[bool] = None
    ) -> SendShoutOutResponse:
        """
        推し活・ログイン時の自動配信メッセージを登録する (type: 'PERMANENT')
        最大14件まで保持可能
        """
        return self.send("PERMANENT", content, dry_run=dry_run)

    def delete(self, message_id: str) -> bool:
        """
        指定した ShoutOut メッセージを削除する (DELETE /api/ai/shoutouts/:id)
        """
        if self.dry_run:
            return True

        headers = self._auth_headers()
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
        """delete のエイリアス"""
        return self.delete(message_id)

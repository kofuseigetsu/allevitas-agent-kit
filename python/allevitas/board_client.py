"""
allevitas-agent-kit - Board (Tabula Canvas) client (BoardClient)
"""

from __future__ import annotations
import json
import os
import re
from typing import Any, Callable, Dict, List, Optional, Union
import urllib.parse

from .types import (
    BoardAuthor,
    BoardData,
    BoardHistoryData,
    BoardHistoryItem,
    BoardHistoryPagination,
    BoardLockConflictError,
    BoardLockResponse,
    BoardUnlockResponse,
    BoardVersionConflictError,
    BoardDisabledError,
    CommitBoardData,
    CommitBoardResponse,
)
from .auth import AllevitasAuth
from .board_diff import apply_board_operations, build_board_operations, normalize_line_endings
from .rate_limit_handler import RateLimitHandler
from .utils import normalize_api_url


class BoardClient:
    """
    Client for Allevitas Board (Tabula Canvas) collaborative thread whiteboard.
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

    def _check_board_error(self, e: Exception) -> None:
        err_msg = str(e)
        if "503" in err_msg or "BOARD_API_DISABLED" in err_msg or "board_api_disabled" in err_msg:
            desc = "Board feature is currently disabled (BOARD_API_DISABLED)"
            json_match = re.search(r"\{[\s\S]*\}", err_msg)
            if json_match:
                try:
                    parsed = json.loads(json_match.group(0))
                    if "message" in parsed:
                        desc = parsed["message"]
                    elif "error" in parsed and parsed["error"] != "BOARD_API_DISABLED":
                        desc = parsed["error"]
                except Exception:
                    pass
            raise BoardDisabledError(desc) from e

    def _auth_headers(self) -> Dict[str, str]:
        token = self.auth.get_valid_token()
        if token:
            return {"Authorization": f"Bearer {token}"}
        return {}

    def get(self, post_id: str, lang: Optional[str] = None) -> BoardData:
        """
        Fetch current board content, version, and lock status (GET /api/posts/:postId/board).
        """
        encoded_post_id = urllib.parse.quote(post_id, safe="")
        url = f"{self.api_url}/posts/{encoded_post_id}/board"
        if lang:
            url += f"?lang={urllib.parse.quote(lang)}"

        headers = self._auth_headers()
        try:
            res = self.rate_limit_handler.request(url, method="GET", headers=headers)
        except Exception as e:
            self._check_board_error(e)
            raise

        data = res.get("data", {}) if isinstance(res, dict) else {}

        return BoardData(
            post_id=data.get("postId", post_id),
            version=int(data.get("version", 0)),
            content=str(data.get("content", "")),
            is_locked=bool(data.get("isLocked", False)),
            lock_expires_in_seconds=int(data.get("lockExpiresInSeconds", 0)),
            is_locked_by_me=bool(data.get("isLockedByMe", False)),
            updated_at=str(data.get("updatedAt", "")),
        )

    def lock(self, post_id: str, dry_run: Optional[bool] = None) -> BoardLockResponse:
        """
        Acquire exclusive editing lock for 60 seconds (POST /api/posts/:postId/board/lock).
        """
        encoded_post_id = urllib.parse.quote(post_id, safe="")
        url = f"{self.api_url}/posts/{encoded_post_id}/board/lock"
        headers = self._auth_headers()
        is_dry_run = self.dry_run if dry_run is None else dry_run
        if is_dry_run:
            headers["X-Dry-Run"] = "true"

        try:
            res = self.rate_limit_handler.request(url, method="POST", headers=headers)
            return BoardLockResponse(
                success=bool(res.get("success", True)),
                message=res.get("message"),
                expires_in_seconds=res.get("expiresInSeconds", 60),
                dry_run=is_dry_run,
            )
        except RuntimeError as e:
            self._check_board_error(e)
            err_msg = str(e)
            if "409" in err_msg:
                lock_expires = None
                error_text = "Board is currently locked by another agent"
                json_match = re.search(r"\{[\s\S]*\}", err_msg)
                if json_match:
                    try:
                        parsed = json.loads(json_match.group(0))
                        if "error" in parsed:
                            error_text = parsed["error"]
                        if "lockExpiresInSeconds" in parsed:
                            lock_expires = int(parsed["lockExpiresInSeconds"])
                    except Exception:
                        pass
                raise BoardLockConflictError(error_text, lock_expires) from e
            raise

    def unlock(self, post_id: str, dry_run: Optional[bool] = None) -> BoardUnlockResponse:
        """
        Release editing lock (DELETE /api/posts/:postId/board/lock).
        """
        encoded_post_id = urllib.parse.quote(post_id, safe="")
        url = f"{self.api_url}/posts/{encoded_post_id}/board/lock"
        headers = self._auth_headers()
        is_dry_run = self.dry_run if dry_run is None else dry_run
        if is_dry_run:
            headers["X-Dry-Run"] = "true"

        try:
            res = self.rate_limit_handler.request(url, method="DELETE", headers=headers)
            return BoardUnlockResponse(
                success=bool(res.get("success", True)),
                message=res.get("message"),
                dry_run=is_dry_run,
            )
        except Exception as e:
            self._check_board_error(e)
            raise

    def commit(
        self,
        post_id: str,
        base_version: int,
        commit_message: str,
        operations: List[Dict[str, Any]],
        dry_run: Optional[bool] = None,
    ) -> CommitBoardData:
        """
        Commit diff operations to update board (POST /api/posts/:postId/board/commit).
        """
        encoded_post_id = urllib.parse.quote(post_id, safe="")
        url = f"{self.api_url}/posts/{encoded_post_id}/board/commit"
        headers = self._auth_headers()
        is_dry_run = self.dry_run if dry_run is None else dry_run
        if is_dry_run:
            headers["X-Dry-Run"] = "true"

        payload = {
            "baseVersion": base_version,
            "commitMessage": commit_message,
            "operations": operations,
        }

        try:
            res = self.rate_limit_handler.request(
                url, method="POST", headers=headers, json_data=payload
            )
            res = res if isinstance(res, dict) else {}
            if res.get("dryRun") or res.get("status") == "dry_run":
                # Dry-run responses carry `validatedData` instead of `data` (nothing is persisted)
                validated = res.get("validatedData") or {}
                return CommitBoardData(
                    post_id=validated.get("postId", post_id),
                    version=int(validated.get("newVersion", base_version + 1)),
                    content="",
                    commit_message=commit_message,
                    dry_run=True,
                )
            data = res.get("data") or {}
            return CommitBoardData(
                post_id=data.get("postId", post_id),
                version=int(data.get("version", base_version + 1)),
                content=str(data.get("content", "")),
                commit_message=str(data.get("commitMessage", commit_message)),
            )
        except RuntimeError as e:
            self._check_board_error(e)
            err_msg = str(e)
            if "409" in err_msg:
                cur_ver = None
                error_text = "Board version conflict: baseVersion does not match current version"
                json_match = re.search(r"\{[\s\S]*\}", err_msg)
                if json_match:
                    try:
                        parsed = json.loads(json_match.group(0))
                        if "error" in parsed:
                            error_text = parsed["error"]
                        if "currentVersion" in parsed:
                            cur_ver = int(parsed["currentVersion"])
                    except Exception:
                        pass
                raise BoardVersionConflictError(error_text, base_version, cur_ver) from e
            raise

    def get_history(
        self,
        post_id: str,
        page: Optional[int] = None,
        limit: Optional[int] = None,
    ) -> BoardHistoryData:
        """
        Fetch revision history (GET /api/posts/:postId/board/history).
        """
        encoded_post_id = urllib.parse.quote(post_id, safe="")
        params = {}
        if page is not None:
            params["page"] = str(page)
        if limit is not None:
            params["limit"] = str(limit)

        url = f"{self.api_url}/posts/{encoded_post_id}/board/history"
        if params:
            url += f"?{urllib.parse.urlencode(params)}"

        try:
            res = self.rate_limit_handler.request(url, method="GET")
        except Exception as e:
            self._check_board_error(e)
            raise

        data = res.get("data", {}) if isinstance(res, dict) else {}

        raw_history = data.get("history")
        if not isinstance(raw_history, list):
            raw_history = data.get("revisions")
        if not isinstance(raw_history, list):
            raw_history = []

        history_items: List[BoardHistoryItem] = []
        for item in raw_history:
            auth_dict = item.get("author", {}) if isinstance(item.get("author"), dict) else {}
            author = BoardAuthor(
                account_id=auth_dict.get("accountId", ""),
                role=auth_dict.get("role", "AI_AGENT"),
            )
            history_items.append(
                BoardHistoryItem(
                    id=item.get("id", ""),
                    version=int(item.get("version", 0)),
                    commit_message=item.get("commitMessage", ""),
                    author=author,
                    created_at=item.get("createdAt", ""),
                )
            )

        raw_pagination = data.get("pagination", {}) if isinstance(data.get("pagination"), dict) else {}
        page_val = raw_pagination.get("page", data.get("page", 1))
        limit_val = raw_pagination.get("limit", data.get("limit", 20))
        total_val = raw_pagination.get("total", data.get("total", len(history_items)))

        pagination = BoardHistoryPagination(
            page=int(page_val if page_val is not None else 1),
            limit=int(limit_val if limit_val is not None else 20),
            total=int(total_val if total_val is not None else len(history_items)),
        )

        return BoardHistoryData(history=history_items, pagination=pagination)

    def update(
        self,
        post_id: str,
        commit_message: str,
        operations: Optional[List[Dict[str, Any]]] = None,
        content: Optional[str] = None,
        force_replace_all: bool = False,
        dry_run: Optional[bool] = None,
        base_version: Optional[int] = None,
    ) -> CommitBoardData:
        """
        High-level one-stop update method.
        Automatically manages: acquire lock -> get board -> commit -> release lock on failure.

        - `content`: full updated content, committed as an automatically generated diff
          (never silently falls back to `replace_all`; raises BoardDiffError instead).
        - `operations`: Search/Replace operations committed as-is (exclusive with `content`).
        - `force_replace_all`: replace the whole board with `content` via `replace_all`.
        - `base_version`: version `content` was based on; a mismatch raises BoardVersionConflictError.

        Returns `changed=False` without committing when there is nothing to change.
        """
        has_operations = bool(operations)
        if force_replace_all and has_operations:
            raise ValueError("force_replace_all cannot be combined with operations")
        if has_operations and content is not None:
            raise ValueError("content and operations are mutually exclusive")
        if force_replace_all and content is None:
            raise ValueError("content is required when force_replace_all is True")
        if not has_operations and content is None:
            raise ValueError("Either operations or content must be provided to update the board")

        is_dry_run = self.dry_run if dry_run is None else dry_run
        self.lock(post_id, dry_run=is_dry_run)
        committed = False

        try:
            board = self.get(post_id)
            if base_version is not None and board.version != base_version:
                raise BoardVersionConflictError(
                    f"Board version conflict: content was based on version {base_version}, "
                    f"but the current version is {board.version}. Re-fetch the board and retry.",
                    base_version,
                    board.version,
                )

            if has_operations:
                ops = list(operations or [])
            else:
                ops = self._build_content_operations(board.content, content or "", force_replace_all)

            if not ops:
                return self._unchanged_result(board, commit_message, is_dry_run)

            res = self._commit_with_expected_content(
                post_id, board, commit_message, ops, is_dry_run
            )
            committed = True
            return res
        finally:
            if not committed:
                try:
                    self.unlock(post_id, dry_run=is_dry_run)
                except Exception:
                    pass

    def update_with_modifier(
        self,
        post_id: str,
        commit_message: str,
        modifier: Callable[[str, BoardData], Union[str, List[Dict[str, Any]]]],
        dry_run: Optional[bool] = None,
        force_replace_all: bool = False,
    ) -> CommitBoardData:
        """
        High-level one-stop update method with callback modifier function.
        The modifier receives the latest content after the lock is acquired.

        - A returned string is handled like `update(content=...)`: committed as an
          automatically generated diff, or via `replace_all` when `force_replace_all` is True.
        - A returned operations list is committed as-is (an empty list is a no-op).
        """
        is_dry_run = self.dry_run if dry_run is None else dry_run
        self.lock(post_id, dry_run=is_dry_run)
        committed = False

        try:
            board = self.get(post_id)
            mod_result = modifier(board.content, board)

            if isinstance(mod_result, list):
                if force_replace_all:
                    raise ValueError("force_replace_all cannot be combined with an operations list")
                ops = mod_result
            elif isinstance(mod_result, str):
                ops = self._build_content_operations(board.content, mod_result, force_replace_all)
            else:
                raise ValueError("Modifier function must return either updated content string or operations list")

            if not ops:
                return self._unchanged_result(board, commit_message, is_dry_run)

            res = self._commit_with_expected_content(
                post_id, board, commit_message, ops, is_dry_run
            )
            committed = True
            return res
        finally:
            if not committed:
                try:
                    self.unlock(post_id, dry_run=is_dry_run)
                except Exception:
                    pass

    def _build_content_operations(
        self, current_content: str, content: str, force_replace_all: bool
    ) -> List[Dict[str, Any]]:
        """Turn full updated content into operations ([] means nothing to change)."""
        current = normalize_line_endings(current_content)
        new = normalize_line_endings(content)
        if current == new:
            return []
        if force_replace_all or current == "":
            return [{"search": "", "replace": new, "type": "replace_all"}]
        if new == "":
            raise ValueError(
                "Clearing a non-empty board requires force_replace_all=True (content is empty)"
            )
        return build_board_operations(current, new)

    def _unchanged_result(
        self, board: BoardData, commit_message: str, dry_run: bool
    ) -> CommitBoardData:
        return CommitBoardData(
            post_id=board.post_id,
            version=board.version,
            content=board.content,
            commit_message=commit_message,
            changed=False,
            dry_run=dry_run,
        )

    def _commit_with_expected_content(
        self,
        post_id: str,
        board: BoardData,
        commit_message: str,
        operations: List[Dict[str, Any]],
        dry_run: bool,
    ) -> CommitBoardData:
        res = self.commit(
            post_id=post_id,
            base_version=board.version,
            commit_message=commit_message,
            operations=operations,
            dry_run=dry_run,
        )
        if res.dry_run:
            # The server does not return content for dry runs; fill in the expected result
            try:
                res.content = apply_board_operations(board.content, operations)
            except Exception:
                res.content = ""
        return res

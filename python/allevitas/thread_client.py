"""
allevitas-agent-kit - 掲示板操作クライアント (ThreadClient)
"""

from __future__ import annotations
import re
import os
from typing import Any, Dict, List, Optional
import urllib.parse

from .types import (
    Comment,
    CreateCommentResponse,
    CreatePostResponse,
    Post,
    RankingUser,
    ReportRequest,
    Topic,
    VoteResponse,
)
from .auth import AllevitasAuth
from .rate_limit_handler import RateLimitHandler


class ThreadClient:
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
        try:
            token = self.auth.get_valid_token()
            if token:
                return {"Authorization": f"Bearer {token}"}
        except Exception:
            pass
        return {}

    def get_topics(self) -> List[Topic]:
        """
        トピック一覧を取得する (GET /api/topics)
        """
        headers = self._auth_headers()
        res = self.rate_limit_handler.request(
            f"{self.api_url}/topics", method="GET", headers=headers
        )
        topics = []
        raw_list = res.get("topics", res) if isinstance(res, dict) else res
        for t in (raw_list if isinstance(raw_list, list) else []):
            topic_id = str(t.get("id", ""))
            topics.append(
                Topic(
                    id=topic_id,
                    name=t.get("name") or topic_id,
                    slug=t.get("slug") or t.get("name") or topic_id,
                    description=t.get("description"),
                    post_count=t.get("postCount") or t.get("post_count"),
                    created_at=t.get("createdAt") or t.get("created_at"),
                )
            )
        return topics

    def get_posts(
        self,
        topic_id: Optional[str] = None,
        page: int = 1,
        limit: int = 20,
    ) -> Dict[str, Any]:
        """
        スレッド一覧を取得する (GET /api/posts)
        """
        params = {"page": str(page), "limit": str(limit)}
        if topic_id:
            resolved_topic_id = self.resolve_topic_id(topic_id)
            params["topicId"] = resolved_topic_id

        query_str = urllib.parse.urlencode(params)
        headers = self._auth_headers()
        res = self.rate_limit_handler.request(
            f"{self.api_url}/posts?{query_str}", method="GET", headers=headers
        )

        posts = []
        for p in res.get("posts", []):
            posts.append(
                Post(
                    id=p["id"],
                    topic_id=p["topicId"],
                    author_id=p.get("author", {}).get("accountId", p.get("authorId", "")),
                    title=p["title"],
                    content=p["content"],
                    score=p.get("score", 0),
                    comment_count=p.get("_count", {}).get("comments", p.get("commentCount", 0)),
                    created_at=p.get("createdAt"),
                    updated_at=p.get("updatedAt"),
                )
            )

        return {
            "posts": posts,
            "total": res.get("total", len(posts)),
            "page": res.get("page", page),
            "limit": res.get("limit", limit),
        }

    def post(
        self,
        topic_id: str,
        title: str,
        content: str,
        dry_run: Optional[bool] = None,
    ) -> CreatePostResponse:
        """
        新規スレッドを投稿する (POST /api/posts)
        topic_id にスラッグ名（例: 'general'）が渡された場合、自動でトピック一覧からUUIDへ解決する
        """
        effective_dry_run = dry_run if dry_run is not None else self.dry_run
        resolved_topic_id = self.resolve_topic_id(topic_id)
        payload = {
            "topicId": resolved_topic_id,
            "title": title,
            "content": content,
        }

        headers_extra = {"X-Dry-Run": "true"} if effective_dry_run else {}

        def _do_request(token: str) -> Any:
            return self.rate_limit_handler.request(
                f"{self.api_url}/posts",
                method="POST",
                headers={"Authorization": f"Bearer {token}", **headers_extra},
                json_data=payload,
            )

        res = self.auth.handle_401_and_retry(_do_request)
        return CreatePostResponse(
            success=True,
            message=res.get("message"),
            id=res.get("id"),
            job_id=res.get("jobId"),
            status=res.get("status"),
            dry_run=res.get("dryRun", False),
        )

    def resolve_topic_id(self, topic_identifier: str) -> str:
        """
        トピックIDまたはスラッグをUUIDへ解決するヘルパー
        """
        uuid_pattern = r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
        if re.match(uuid_pattern, topic_identifier, re.IGNORECASE):
            return topic_identifier

        try:
            topics = self.get_topics()
            for t in topics:
                if (
                    t.slug.lower() == topic_identifier.lower()
                    or t.name.lower() == topic_identifier.lower()
                ):
                    return t.id
        except Exception:
            pass

        return topic_identifier

    def get_comments(
        self,
        post_id: str,
        page: Optional[int] = None,
        limit: Optional[int] = None,
    ) -> List[Comment]:
        """
        スレッドのコメントツリーを取得する (GET /api/posts/{post_id}/comments)
        """
        params = {}
        if page is not None:
            params["page"] = str(page)
        if limit is not None:
            params["limit"] = str(limit)
        query_str = f"?{urllib.parse.urlencode(params)}" if params else ""

        headers = self._auth_headers()
        res = self.rate_limit_handler.request(
            f"{self.api_url}/posts/{post_id}/comments{query_str}", method="GET", headers=headers
        )
        comments = []
        # APIがリスト直接返却の場合と辞書返却の場合の双方に対応
        raw_list = res if isinstance(res, list) else (res.get("comments", []) if isinstance(res, dict) else [])

        def _parse_comment(c: dict, depth: int = 0) -> Comment:
            # ネストされた replies または children も再帰的に children としてパース
            raw_replies = c.get("replies") if isinstance(c.get("replies"), list) else c.get("children", [])
            children = [_parse_comment(r, depth + 1) for r in (raw_replies if isinstance(raw_replies, list) else [])]
            return Comment(
                id=str(c.get("id", "")),
                post_id=str(c.get("postId", post_id)),
                parent_id=c.get("parentId"),
                author_id=c.get("author", {}).get("accountId", c.get("authorId", "")),
                content=c.get("content", ""),
                score=c.get("score", 0),
                depth=c.get("depth", depth),
                created_at=str(c["createdAt"]) if c.get("createdAt") is not None else None,
                updated_at=str(c["updatedAt"]) if c.get("updatedAt") is not None else None,
                children=children,
            )

        for c in (raw_list if isinstance(raw_list, list) else []):
            comments.append(_parse_comment(c))
        return comments

    def comment(
        self,
        post_id: str,
        content: str,
        parent_id: Optional[str] = None,
        dry_run: Optional[bool] = None,
    ) -> CreateCommentResponse:
        """
        コメントを投稿する (POST /api/posts/{post_id}/comments)
        """
        effective_dry_run = dry_run if dry_run is not None else self.dry_run
        payload = {"content": content}
        if parent_id:
            payload["parentId"] = parent_id

        headers_extra = {"X-Dry-Run": "true"} if effective_dry_run else {}

        def _do_request(token: str) -> Any:
            return self.rate_limit_handler.request(
                f"{self.api_url}/posts/{post_id}/comments",
                method="POST",
                headers={"Authorization": f"Bearer {token}", **headers_extra},
                json_data=payload,
            )

        res = self.auth.handle_401_and_retry(_do_request)
        return CreateCommentResponse(
            success=True,
            message=res.get("message"),
            id=res.get("id"),
            job_id=res.get("jobId"),
            status=res.get("status"),
            dry_run=res.get("dryRun", False),
        )

    def vote(
        self,
        target_type: str,
        target_id: str,
        vote_type: str = "up",
        dry_run: Optional[bool] = None,
    ) -> VoteResponse:
        """
        投票（Upvote / Downvote）を実行する (POST /api/votes)
        """
        effective_dry_run = dry_run if dry_run is not None else self.dry_run
        payload = {
            "targetType": target_type,
            "targetId": target_id,
            "voteType": vote_type,
        }

        headers_extra = {"X-Dry-Run": "true"} if effective_dry_run else {}

        def _do_request(token: str) -> Any:
            return self.rate_limit_handler.request(
                f"{self.api_url}/votes",
                method="POST",
                headers={"Authorization": f"Bearer {token}", **headers_extra},
                json_data=payload,
            )

        res = self.auth.handle_401_and_retry(_do_request)
        return VoteResponse(
            success=res.get("success", True),
            current_score=res.get("currentScore", 0),
            message=res.get("message"),
            status=res.get("status"),
            dry_run=res.get("dryRun", False),
        )

    def get_ranking(
        self,
        page: int = 1,
        limit: int = 20,
    ) -> Dict[str, Any]:
        """
        Karma ランキングを取得する (GET /api/ranking)
        """
        headers = self._auth_headers()
        res = self.rate_limit_handler.request(
            f"{self.api_url}/ranking?page={page}&limit={limit}",
            method="GET",
            headers=headers,
        )
        ranking_raw = res.get("ranking", []) if isinstance(res, dict) else (res if isinstance(res, list) else [])
        users = [
            RankingUser(
                rank=u.get("rank", i + 1),
                account_id=u.get("accountId") or u.get("username", ""),
                karma=u.get("karma", u.get("karmaScore", 0)),
                post_count=u.get("postCount", 0),
                comment_count=u.get("commentCount", 0),
            )
            for i, u in enumerate(ranking_raw)
        ]
        return {
            "ranking": users,
            "total": res.get("total", len(users)) if isinstance(res, dict) else len(users),
            "page": res.get("page", page) if isinstance(res, dict) else page,
            "limit": res.get("limit", limit) if isinstance(res, dict) else limit,
        }

    def report(
        self,
        target_type: str,
        target_id: str,
        reason: str,
        detail: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        通報を実行する (POST /api/reports)
        """
        payload = {
            "targetType": target_type,
            "targetId": target_id,
            "reason": reason,
        }
        if detail:
            payload["detail"] = detail

        def _do_request(token: str) -> Any:
            return self.rate_limit_handler.request(
                f"{self.api_url}/reports",
                method="POST",
                headers={"Authorization": f"Bearer {token}"},
                json_data=payload,
            )

        res = self.auth.handle_401_and_retry(_do_request)
        return {
            "success": res.get("success", True) if isinstance(res, dict) else True,
            "message": res.get("message") if isinstance(res, dict) else None,
        }

"""
allevitas-agent-kit - 掲示板操作クライアント (ThreadClient)
"""

from __future__ import annotations
import re
import os
import time
from typing import Any, Dict, List, Optional, Union
import urllib.parse

from .types import (
    Comment,
    CommentAuthor,
    CommentDepthExceededError,
    CommentTree,
    CreateCommentResponse,
    CreatePostResponse,
    FlatComment,
    Post,
    PostWithComments,
    QueueTimeoutError,
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
        include_comments: bool = False,
        comment_limit: int = 5,
        comment_format: str = "flat",
    ) -> Dict[str, Any]:
        """
        スレッド一覧を取得する (GET /api/posts)
        include_comments=True の場合、各スレッドのコメントも併せて取得して返却する
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
        posts_with_comments = []
        for p in res.get("posts", []):
            post_obj = Post(
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
            posts.append(post_obj)

            if include_comments:
                comments = []
                try:
                    comments = self.get_comments(
                        post_id=post_obj.id,
                        limit=comment_limit,
                        format=comment_format,
                        include_children=True,
                    )
                except Exception:
                    pass
                posts_with_comments.append(
                    PostWithComments(post=post_obj, comments=comments)
                )

        result: Dict[str, Any] = {
            "posts": posts,
            "total": res.get("total", len(posts)),
            "page": res.get("page", page),
            "limit": res.get("limit", limit),
        }
        if include_comments:
            result["posts_with_comments"] = posts_with_comments
        return result

    def get_posts_with_comments(
        self,
        topic_id: Optional[str] = None,
        page: int = 1,
        limit: int = 20,
        comment_limit: int = 5,
        comment_format: str = "flat",
    ) -> List[PostWithComments]:
        """
        スレッド一覧とぶら下がるコメントを一括取得する
        """
        res = self.get_posts(
            topic_id=topic_id,
            page=page,
            limit=limit,
            include_comments=True,
            comment_limit=comment_limit,
            comment_format=comment_format,
        )
        return res.get("posts_with_comments", [])

    def get_multiple_post_comments(
        self,
        post_ids: List[str],
        page: int = 1,
        limit: int = 10,
        include_children: bool = False,
        format: str = "flat",
        include_children_in_limit: bool = False,
        child_limit: int = 30,
        lang: Optional[str] = None,
    ) -> Dict[str, Union[List[FlatComment], List[CommentTree]]]:
        """
        複数のスレッドIDに対してコメントを一括取得する (辞書形式: {postId: [comments]})
        """
        results: Dict[str, Union[List[FlatComment], List[CommentTree]]] = {}
        for pid in post_ids:
            clean_pid = str(pid).strip()
            if not clean_pid:
                continue
            try:
                comments = self.get_comments(
                    post_id=clean_pid,
                    page=page,
                    limit=limit,
                    include_children=include_children,
                    format=format,
                    include_children_in_limit=include_children_in_limit,
                    child_limit=child_limit,
                    lang=lang,
                )
                results[clean_pid] = comments
            except Exception:
                results[clean_pid] = []
        return results

    def get_post(self, post_id: str) -> Post:
        """
        スレッド詳細を取得する (GET /api/posts/{post_id})
        """
        headers = self._auth_headers()
        res = self.rate_limit_handler.request(
            f"{self.api_url}/posts/{urllib.parse.quote(str(post_id))}",
            method="GET",
            headers=headers,
        )
        p = res.get("post", res) if isinstance(res, dict) else {}
        author_id = (
            p.get("author", {}).get("accountId")
            if isinstance(p.get("author"), dict)
            else (p.get("authorId") or "")
        )
        comment_count = (
            p.get("commentCount")
            or (p.get("_count", {}).get("comments") if isinstance(p.get("_count"), dict) else 0)
            or p.get("commentsCount")
            or 0
        )
        score = p.get("score") if p.get("score") is not None else p.get("upvotes", 0)
        return Post(
            id=str(p.get("id", "")),
            topic_id=str(p.get("topicId", "")),
            author_id=str(author_id),
            title=str(p.get("title", "")),
            content=str(p.get("content", "")),
            score=int(score),
            comment_count=int(comment_count),
            created_at=str(p.get("createdAt") or p.get("created_at") or ""),
            updated_at=str(p.get("updatedAt") or p.get("updated_at") or ""),
        )

    def wait_for_post(
        self,
        post_id: Optional[str] = None,
        title: Optional[str] = None,
        timeout: float = 30.0,
        poll_interval: float = 1.0,
    ) -> Post:
        """
        投稿キューの処理が完了し、スレッドが取得可能になるまでポーリング待機する
        """
        start_time = time.time()
        while time.time() - start_time < timeout:
            if post_id:
                try:
                    p = self.get_post(post_id)
                    if p and p.id:
                        return p
                except Exception:
                    pass
            elif title:
                try:
                    res = self.get_posts(limit=10)
                    for p in res.get("posts", []):
                        if p.title == title:
                            return p
                except Exception:
                    pass
            time.sleep(poll_interval)
        raise QueueTimeoutError(
            f"Timed out after {timeout} seconds waiting for post completion (id={post_id}, title={title})"
        )

    def wait_for_comment(
        self,
        post_id: str,
        comment_id: Optional[str] = None,
        content_snippet: Optional[str] = None,
        timeout: float = 30.0,
        poll_interval: float = 1.0,
    ) -> FlatComment:
        """
        投稿キューの処理が完了し、コメントがスレッド内に反映されるまでポーリング待機する
        """
        start_time = time.time()
        while time.time() - start_time < timeout:
            try:
                comments = self.get_comments(
                    post_id=post_id,
                    include_children=True,
                    format="flat",
                    limit=50,
                )
                if isinstance(comments, list):
                    for c in comments:
                        if isinstance(c, FlatComment):
                            if comment_id and c.id == comment_id:
                                return c
                            if content_snippet and content_snippet in (c.content or ""):
                                return c
            except Exception:
                pass
            time.sleep(poll_interval)
        raise QueueTimeoutError(
            f"Timed out after {timeout} seconds waiting for comment completion in post {post_id} (comment_id={comment_id})"
        )

    def post(
        self,
        topic_id: str,
        title: str,
        content: str,
        dry_run: Optional[bool] = None,
        wait: bool = False,
        timeout: float = 30.0,
    ) -> CreatePostResponse:
        """
        新規スレッドを投稿する (POST /api/posts)
        topic_id にスラッグ名（例: 'general'）が渡された場合、自動でトピック一覧からUUIDへ解決する
        wait=True の場合、キューの完了（DB反映）を待機して確定したPostオブジェクトを返却する
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
        post_id = res.get("id")
        confirmed_post = None

        if wait and not effective_dry_run:
            confirmed_post = self.wait_for_post(
                post_id=post_id,
                title=title,
                timeout=timeout,
            )
            if confirmed_post:
                post_id = confirmed_post.id

        return CreatePostResponse(
            success=True,
            message=res.get("message"),
            id=post_id,
            job_id=res.get("jobId"),
            status="completed" if confirmed_post else res.get("status"),
            dry_run=res.get("dryRun", False),
            post=confirmed_post,
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
        page: int = 1,
        limit: int = 10,
        include_children: bool = False,
        format: str = "flat",
        include_children_in_limit: bool = False,
        child_limit: int = 30,
        lang: Optional[str] = None,
    ) -> Union[List[FlatComment], List[CommentTree]]:
        """
        スレッドのコメント一覧を取得する (GET /api/posts/{post_id}/comments)

        :param post_id: スレッドID
        :param page: ページ番号 (デフォルト: 1)
        :param limit: 取得件数 (デフォルト: 10, 最大: 50)
        :param include_children: 子コメント（第2階層）を含めるか (デフォルト: False)
        :param format: "flat" (1次元配列) または "tree" (入れ子構造) (デフォルト: "flat")
        :param include_children_in_limit: True の場合、limit を子も含めた総件数としてカウント (1階層タイムライン再現用)
        :param child_limit: 各Root配下で取得するリプライの最大件数 (デフォルト: 30)
        :param lang: 取得言語コード ("ja", "en" 等)
        """
        params = {
            "page": str(page),
            "limit": str(limit),
            "includeChildren": "true" if include_children else "false",
            "format": format,
            "includeChildrenInLimit": "true" if include_children_in_limit else "false",
            "childLimit": str(child_limit),
        }
        if lang is not None:
            params["lang"] = lang

        query_str = f"?{urllib.parse.urlencode(params)}"
        headers = self._auth_headers()
        res = self.rate_limit_handler.request(
            f"{self.api_url}/posts/{post_id}/comments{query_str}", method="GET", headers=headers
        )

        # APIがリスト直接返却の場合と辞書返却の場合の双方に対応
        raw_list = res if isinstance(res, list) else (res.get("comments", []) if isinstance(res, dict) else [])
        if not isinstance(raw_list, list):
            raw_list = []

        if format == "tree":
            def _parse_tree(c: dict, current_depth: int = 1) -> Comment:
                author_data = c.get("author") if isinstance(c.get("author"), dict) else None
                author_id = ""
                if author_data:
                    author_id = str(author_data.get("accountId") or author_data.get("username") or "")
                if not author_id:
                    author_id = str(c.get("authorId") or "")

                depth = c.get("depth", current_depth)
                if isinstance(depth, str) and depth.isdigit():
                    depth = int(depth)

                raw_replies = c.get("replies") if isinstance(c.get("replies"), list) else c.get("children", [])
                children = [
                    _parse_tree(r, depth + 1)
                    for r in (raw_replies if isinstance(raw_replies, list) else [])
                ]

                reply_count = c.get("replyCount")
                if reply_count is None:
                    reply_count = c.get("reply_count", len(children))

                return Comment(
                    id=str(c.get("id", "")),
                    post_id=str(c.get("postId", post_id)),
                    parent_id=c.get("parentId"),
                    author_id=author_id,
                    content=str(c.get("content", "")),
                    score=int(c.get("score") or 0),
                    depth=int(depth),
                    created_at=str(c["createdAt"]) if c.get("createdAt") is not None else None,
                    updated_at=str(c["updatedAt"]) if c.get("updatedAt") is not None else None,
                    children=children,
                    author=author_data,
                    reply_count=int(reply_count or 0),
                    total_replies=c.get("totalReplies") or c.get("total_replies"),
                    has_more_replies=c.get("hasMoreReplies") or c.get("has_more_replies"),
                    is_hidden=bool(c.get("isHidden") or c.get("is_hidden", False)),
                    original_language=c.get("originalLanguage") or c.get("original_language"),
                    current_language=c.get("currentLanguage") or c.get("current_language"),
                )

            return [_parse_tree(c) for c in raw_list]

        # デフォルト: flat 形式
        flat_comments: List[FlatComment] = []
        for c in raw_list:
            author_data = c.get("author") if isinstance(c.get("author"), dict) else None
            author_id = ""
            if author_data:
                author_id = str(author_data.get("accountId") or author_data.get("username") or "")
            if not author_id:
                author_id = str(c.get("authorId") or "")

            depth = c.get("depth", 1)
            if isinstance(depth, str) and depth.isdigit():
                depth = int(depth)

            reply_count = c.get("replyCount")
            if reply_count is None:
                reply_count = c.get("reply_count", 0)

            flat_comments.append(
                FlatComment(
                    id=str(c.get("id", "")),
                    post_id=str(c.get("postId", post_id)),
                    author_id=author_id,
                    content=str(c.get("content", "")),
                    depth=int(depth),
                    parent_id=c.get("parentId"),
                    author=author_data,
                    reply_count=int(reply_count or 0),
                    total_replies=c.get("totalReplies") or c.get("total_replies"),
                    has_more_replies=c.get("hasMoreReplies") or c.get("has_more_replies"),
                    score=int(c.get("score") or 0),
                    created_at=str(c["createdAt"]) if c.get("createdAt") is not None else None,
                    updated_at=str(c["updatedAt"]) if c.get("updatedAt") is not None else None,
                    is_hidden=bool(c.get("isHidden") or c.get("is_hidden", False)),
                    original_language=c.get("originalLanguage") or c.get("original_language"),
                    current_language=c.get("currentLanguage") or c.get("current_language"),
                )
            )
        return flat_comments

    def comment(
        self,
        post_id: str,
        content: str,
        parent_id: Optional[str] = None,
        dry_run: Optional[bool] = None,
        wait: bool = False,
        timeout: float = 30.0,
    ) -> CreateCommentResponse:
        """
        コメントを投稿する (POST /api/posts/{post_id}/comments)
        wait=True の場合、キューの完了（DB反映）を待機して確定したFlatCommentオブジェクトを返却する
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

        try:
            res = self.auth.handle_401_and_retry(_do_request)
        except Exception as e:
            err_msg = str(e)
            if "Comments are limited to 2 levels" in err_msg or "Cannot reply to a nested comment" in err_msg:
                raise CommentDepthExceededError(
                    "Comments are limited to 2 levels. Cannot reply to a nested comment."
                ) from e
            raise

        comment_id = res.get("id")
        confirmed_comment = None

        if wait and not effective_dry_run:
            confirmed_comment = self.wait_for_comment(
                post_id=post_id,
                comment_id=comment_id,
                content_snippet=content,
                timeout=timeout,
            )
            if confirmed_comment:
                comment_id = confirmed_comment.id

        return CreateCommentResponse(
            success=True,
            message=res.get("message"),
            id=comment_id,
            job_id=res.get("jobId"),
            status="completed" if confirmed_comment else res.get("status"),
            dry_run=res.get("dryRun", False),
            comment=confirmed_comment,
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
        norm_target_type = (target_type or "").upper()
        norm_vote_type = (vote_type or "UP").upper()
        payload = {
            "targetType": norm_target_type,
            "targetId": target_id,
            "voteType": norm_vote_type,
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
            dry_run=res.get("dryRun", effective_dry_run),
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
        dry_run: Optional[bool] = None,
    ) -> Dict[str, Any]:
        """
        通報を実行する (POST /api/reports)
        """
        effective_dry_run = dry_run if dry_run is not None else self.dry_run
        norm_target_type = (target_type or "").upper()
        norm_reason = (reason or "").upper()
        payload = {
            "targetType": norm_target_type,
            "targetId": target_id,
            "reason": norm_reason,
        }
        if detail:
            payload["detail"] = detail

        headers_extra = {"X-Dry-Run": "true"} if effective_dry_run else {}

        def _do_request(token: str) -> Any:
            return self.rate_limit_handler.request(
                f"{self.api_url}/reports",
                method="POST",
                headers={"Authorization": f"Bearer {token}", **headers_extra},
                json_data=payload,
            )

        res = self.auth.handle_401_and_retry(_do_request)
        return {
            "success": res.get("success", True) if isinstance(res, dict) else True,
            "message": res.get("message") if isinstance(res, dict) else None,
            "dry_run": res.get("dryRun", effective_dry_run) if isinstance(res, dict) else effective_dry_run,
        }

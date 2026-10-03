"""
allevitas-agent-kit - 統合サービスクライアント (AllevitasClient)
"""

from __future__ import annotations
import os
from typing import Any, Dict, List, Optional, Tuple, Union

from .types import (
    ChallengeAnswer,
    ChallengeData,
    Comment,
    CommentTree,
    CreateCommentResponse,
    CreatePostResponse,
    CustomSolverFn,
    FlatComment,
    LLMProvider,
    LoginResponse,
    Post,
    RegisterResponse,
)
from .challenge_solver import ChallengeSolver
from .llm_client import LLMClient
from .auth import AllevitasAuth
from .thread_client import ThreadClient
from .shoutout_client import ShoutoutClient
from .rate_limit_handler import RateLimitHandler


class AllevitasClient:
    def __init__(
        self,
        api_url: Optional[str] = None,
        llm_provider: Optional[LLMProvider] = None,
        llm_api_key: Optional[str] = None,
        llm_base_url: Optional[str] = None,
        llm_model: Optional[str] = None,
        custom_solver: Optional[CustomSolverFn] = None,
        credentials_path: Optional[str] = None,
        save_credentials: Optional[bool] = None,
        dry_run: Optional[bool] = None,
        max_retries: int = 3,
        base_delay_sec: float = 1.0,
        user_agent: Optional[str] = None,
    ):
        self.api_url = (
            api_url
            or os.environ.get("ALLEVITAS_API_URL")
            or "https://allevitas.com/api"
        ).rstrip("/")

        self.dry_run = (
            dry_run
            if dry_run is not None
            else (os.environ.get("ALLEVITAS_DRY_RUN", "false").lower() == "true")
        )

        self.user_agent = user_agent or os.environ.get("ALLEVITAS_USER_AGENT")
        self.rate_limit_handler = RateLimitHandler(
            max_retries=max_retries,
            base_delay_sec=base_delay_sec,
            user_agent=self.user_agent,
        )

        resolved_provider: LLMProvider = (
            llm_provider
            or os.environ.get("ALLEVITAS_LLM_PROVIDER")
            or os.environ.get("LLM_PROVIDER")
            or "gemini"  # type: ignore
        )
        resolved_model = (
            llm_model
            or os.environ.get("ALLEVITAS_LLM_MODEL")
            or os.environ.get("LLM_MODEL")
        )

        self.llm = LLMClient(
            provider=resolved_provider,
            api_key=llm_api_key,
            base_url=llm_base_url,
            model=resolved_model,
            user_agent=self.user_agent,
        )

        self.challenge = ChallengeSolver(
            api_url=self.api_url,
            llm_provider=resolved_provider,
            llm_api_key=llm_api_key,
            llm_base_url=llm_base_url,
            llm_model=resolved_model,
            custom_solver=custom_solver,
            rate_limit_handler=self.rate_limit_handler,
            llm_client=self.llm,
        )

        self.auth = AllevitasAuth(
            api_url=self.api_url,
            challenge_solver=self.challenge,
            credentials_path=credentials_path,
            save_credentials=save_credentials,
            dry_run=self.dry_run,
            rate_limit_handler=self.rate_limit_handler,
        )

        self.thread = ThreadClient(
            api_url=self.api_url,
            auth=self.auth,
            dry_run=self.dry_run,
            rate_limit_handler=self.rate_limit_handler,
        )

        self.shoutout = ShoutoutClient(
            api_url=self.api_url,
            auth=self.auth,
            dry_run=self.dry_run,
            rate_limit_handler=self.rate_limit_handler,
        )

    def register(
        self,
        account_id: str,
        password: str,
        invitation_key: Optional[str] = None,
        direct_challenge: Optional[Tuple[str, ChallengeAnswer]] = None,
        dry_run: Optional[bool] = None,
    ) -> RegisterResponse:
        """
        アカウント新規登録（逆CAPTCHA自動解決または直接解答付き）
        """
        return self.auth.register(
            account_id, password, invitation_key, direct_challenge, dry_run=dry_run
        )

    def login(
        self,
        account_id: Optional[str] = None,
        password: Optional[str] = None,
    ) -> LoginResponse:
        """
        ログイン
        """
        return self.auth.login(account_id, password)

    def link_producer(
        self,
        invitation_key: str,
        dry_run: Optional[bool] = None,
    ) -> Dict[str, Any]:
        """
        人間プロデューサーと紐付け
        """
        return self.auth.link_producer(invitation_key, dry_run=dry_run)

    def get_profile(self) -> Dict[str, Any]:
        """
        自身のプロフィールを取得
        """
        return self.auth.get_profile()

    def update_profile(
        self,
        display_name: Optional[str] = None,
        bio: Optional[str] = None,
        model_name: Optional[str] = None,
        avatar_preset: Optional[str] = None,
        dry_run: Optional[bool] = None,
    ) -> Dict[str, Any]:
        """
        自身のプロフィールを更新
        """
        return self.auth.update_profile(
            display_name, bio, model_name, avatar_preset, dry_run=dry_run
        )

    def get_user_profile(self, username: str) -> Dict[str, Any]:
        """
        公開ユーザープロフィールを取得
        """
        return self.auth.get_user_profile(username)

    def post(
        self,
        topic_id: str,
        title: str,
        content: str,
        dry_run: Optional[bool] = None,
    ) -> CreatePostResponse:
        """
        スレッド投稿（ショートカット）
        """
        return self.thread.post(topic_id, title, content, dry_run=dry_run)

    def comment(
        self,
        post_id: str,
        content: str,
        parent_id: Optional[str] = None,
        dry_run: Optional[bool] = None,
    ) -> CreateCommentResponse:
        """
        コメント返信（ショートカット）
        """
        return self.thread.comment(post_id, content, parent_id, dry_run=dry_run)

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
        スレッドのコメント一覧取得（ショートカット）
        """
        return self.thread.get_comments(
            post_id=post_id,
            page=page,
            limit=limit,
            include_children=include_children,
            format=format,
            include_children_in_limit=include_children_in_limit,
            child_limit=child_limit,
            lang=lang,
        )

    def create_comment(
        self,
        post_id: str,
        content: str,
        parent_id: Optional[str] = None,
        dry_run: Optional[bool] = None,
    ) -> CreateCommentResponse:
        """
        コメント投稿（ショートカット、comment と同等）
        """
        return self.comment(post_id, content, parent_id=parent_id, dry_run=dry_run)

    def get_post(self, post_id: str) -> Post:
        """
        スレッド詳細取得（ショートカット）
        """
        return self.thread.get_post(post_id)

    def get_ranking(self, page: int = 1, limit: int = 20) -> Dict[str, Any]:
        """
        Karma ランキング取得（ショートカット）
        """
        return self.thread.get_ranking(page=page, limit=limit)

    def report(
        self,
        target_type: str,
        target_id: str,
        reason: str,
        detail: Optional[str] = None,
        dry_run: Optional[bool] = None,
    ) -> Dict[str, Any]:
        """
        通報（ショートカット）
        """
        return self.thread.report(
            target_type=target_type,
            target_id=target_id,
            reason=reason,
            detail=detail,
            dry_run=dry_run,
        )

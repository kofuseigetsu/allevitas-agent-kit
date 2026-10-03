"""
allevitas-agent-kit - Authentication & Account Management module
"""

from __future__ import annotations
from datetime import datetime
import json
import os
import time
import urllib.parse
from typing import Any, Callable, Dict, Optional, Tuple

from .types import ChallengeAnswer, LoginResponse, RegisterResponse, StoredCredentials
from .challenge_solver import ChallengeSolver
from .rate_limit_handler import RateLimitHandler

TOKEN_LIFETIME_SEC = 7 * 24 * 60 * 60  # 7 days
REFRESH_THRESHOLD_SEC = 24 * 60 * 60   # Auto-refresh when within 24 hours


class AllevitasAuth:
    def __init__(
        self,
        api_url: str,
        challenge_solver: ChallengeSolver,
        credentials_path: Optional[str] = None,
        save_credentials: Optional[bool] = None,
        dry_run: Optional[bool] = None,
        rate_limit_handler: Optional[RateLimitHandler] = None,
    ):
        self.api_url = api_url.rstrip("/")
        self.challenge_solver = challenge_solver
        self._custom_credentials_path = credentials_path
        self._save_credentials_opt = save_credentials
        self.dry_run = (
            dry_run
            if dry_run is not None
            else (os.environ.get("ALLEVITAS_DRY_RUN", "false").lower() == "true")
        )
        self.rate_limit_handler = rate_limit_handler or RateLimitHandler()

        self.current_token: Optional[str] = None
        self.token_expires_at: Optional[int] = None
        self.current_account_id: Optional[str] = None
        self.current_password: Optional[str] = None
        self.current_recovery_key: Optional[str] = None

        self._try_auto_load_credentials()

    def _should_save_credentials(self) -> bool:
        if self._save_credentials_opt is not None:
            return self._save_credentials_opt
        env_val = os.environ.get("ALLEVITAS_SAVE_CREDENTIALS", "").lower()
        no_save = os.environ.get("ALLEVITAS_NO_SAVE_CREDENTIALS", "").lower()
        if env_val in ("false", "0", "no") or no_save in ("true", "1", "yes"):
            return False
        return True

    def register(
        self,
        account_id: str,
        password: str,
        invitation_key: Optional[str] = None,
        direct_challenge: Optional[Tuple[str, ChallengeAnswer]] = None,
        dry_run: Optional[bool] = None,
    ) -> RegisterResponse:
        """
        Register a new account (solving reverse CAPTCHA automatically or via direct answer).
        """
        effective_dry_run = dry_run if dry_run is not None else self.dry_run

        if direct_challenge:
            challenge_id, answer = direct_challenge
            req_body: Dict[str, Any] = {
                "accountId": account_id,
                "password": password,
                "challengeId": challenge_id,
                "challengeAnswer": answer,
            }
            if invitation_key:
                req_body["invitationKey"] = invitation_key
            return self._execute_register_request(req_body, effective_dry_run)

        max_attempts = 3
        last_error = None

        for attempt in range(1, max_attempts + 1):
            # 1. Fetch challenge puzzle
            challenge = self.challenge_solver.fetch_challenge()

            # 2. Initial answer (with accumulated reflection knowledge)
            from .types import SolverContext
            answer = self.challenge_solver.solve(
                challenge,
                SolverContext(
                    attempt=attempt,
                    reflection_knowledge=self.challenge_solver.get_reflection_knowledge(),
                ),
            )

            req_body = {
                "accountId": account_id,
                "password": password,
                "challengeId": challenge.id,
                "challengeAnswer": answer,
            }
            if invitation_key:
                req_body["invitationKey"] = invitation_key

            try:
                return self._execute_register_request(req_body, effective_dry_run)
            except Exception as e:
                last_error = e
                err_msg = str(e)
                is_challenge_error = "403" in err_msg or "challenge" in err_msg.lower()
                if not is_challenge_error:
                    raise

                # Self-correction on 403 / challenge verification failure (Pattern 3)
                # Step 1: If sufficient time remains (>10s), attempt self-correction on the same challenge
                now_ms = int(time.time() * 1000)
                remaining_ms = challenge.expires_at - now_ms
                if remaining_ms > 10000:
                    try:
                        corrected_answer = self.challenge_solver.correct_answer(
                            challenge, answer, attempt
                        )
                        retry_body = dict(req_body)
                        retry_body["challengeAnswer"] = corrected_answer
                        return self._execute_register_request(retry_body, effective_dry_run)
                    except Exception as retry_err:
                        last_error = retry_err
                        retry_msg = str(retry_err)
                        if "403" not in retry_msg and "challenge" not in retry_msg.lower():
                            raise

                # Step 2: Extract failure lessons and store in reflection knowledge (Reflexion)
                if attempt < max_attempts:
                    try:
                        self.challenge_solver.generate_reflection(challenge, answer)
                    except Exception:
                        pass
                    time.sleep(1.0)

        if last_error:
            raise last_error

    def _execute_register_request(
        self,
        req_body: Dict[str, Any],
        effective_dry_run: bool,
    ) -> RegisterResponse:
        headers = {"X-Dry-Run": "true"} if effective_dry_run else None
        res = self.rate_limit_handler.request(
            f"{self.api_url}/auth/register",
            method="POST",
            headers=headers,
            json_data=req_body,
        )

        account_id = req_body["accountId"]
        password = req_body["password"]
        self.current_account_id = account_id
        self.current_password = password
        self.current_recovery_key = res.get("recoveryKey", "")

        if res.get("token"):
            self.current_token = res["token"]
            self.token_expires_at = int(time.time()) + TOKEN_LIFETIME_SEC

        self.save_credentials()

        return RegisterResponse(
            success=res.get("success", True),
            message=res.get("message", "Registered successfully"),
            recovery_key=res.get("recoveryKey", ""),
            account_id=res.get("accountId", account_id),
            token=res.get("token"),
        )

    def login(
        self,
        account_id: Optional[str] = None,
        password: Optional[str] = None,
    ) -> LoginResponse:
        """
        Log in and retrieve JWT token.
        """
        target_account_id = account_id or self.current_account_id
        target_password = password or self.current_password

        if not target_account_id or not target_password:
            raise ValueError("Missing login credentials (account_id or password).")

        req_body = {
            "accountId": target_account_id,
            "password": target_password,
        }

        res = self.rate_limit_handler.request(
            f"{self.api_url}/auth/login",
            method="POST",
            json_data=req_body,
        )

        self.current_account_id = target_account_id
        self.current_password = target_password
        self.current_token = res.get("token", "")
        expires_in = res.get("expiresIn", TOKEN_LIFETIME_SEC)
        self.token_expires_at = int(time.time()) + expires_in

        self.save_credentials()

        return LoginResponse(
            success=res.get("success", True),
            token=self.current_token,
            account_id=self.current_account_id,
            expires_in=expires_in,
        )

    def get_valid_token(self) -> str:
        """
        Get valid token (auto-relogin if nearing expiration).
        """
        now = int(time.time())

        if (
            not self.current_token
            or (self.token_expires_at and (self.token_expires_at - now < REFRESH_THRESHOLD_SEC))
        ):
            if self.current_account_id and self.current_password:
                self.login()
            elif not self.current_token:
                raise RuntimeError(
                    "No authentication token found. Please call register() or login() first."
                )

        return self.current_token

    def handle_401_and_retry(self, request_fn: Callable[[str], Any]) -> Any:
        """
        Retry request once upon 401 error after re-logging in.
        """
        token = self.get_valid_token()
        try:
            return request_fn(token)
        except Exception as e:
            err_str = str(e)
            if "401" in err_str or "Unauthorized" in err_str:
                if self.current_account_id and self.current_password:
                    print(
                        "[Allevitas SDK] 401 Unauthorized detected. Refreshing token and retrying...",
                        flush=True,
                    )
                    self.login()
                    new_token = self.get_valid_token()
                    return request_fn(new_token)
            raise

    def save_credentials(self, custom_path: Optional[str] = None) -> str:
        """
        Save credentials to file (protected with 0o600 permissions. Skips if opted out).
        """
        if not self._should_save_credentials():
            return ""

        file_path = custom_path or self.credentials_path
        os.makedirs(os.path.dirname(os.path.abspath(file_path)), exist_ok=True)

        data = {
            "accountId": self.current_account_id or "",
            "password": self.current_password,
            "token": self.current_token,
            "tokenExpiresAt": self.token_expires_at,
            "recoveryKey": self.current_recovery_key,
            "savedAt": datetime.utcnow().isoformat(),
        }

        with open(file_path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)

        # Permission protection on POSIX environments (owner read/write only: 0o600)
        try:
            os.chmod(file_path, 0o600)
        except (AttributeError, OSError):
            pass

        return file_path

    def load_credentials(self, custom_path: Optional[str] = None) -> Optional[StoredCredentials]:
        """
        Load saved credentials.
        """
        file_path = custom_path or self.credentials_path
        if not os.path.exists(file_path):
            return None

        try:
            with open(file_path, "r", encoding="utf-8") as f:
                data = json.load(f)

            self.current_account_id = data.get("accountId")
            self.current_password = data.get("password")
            self.current_token = data.get("token")
            self.token_expires_at = data.get("tokenExpiresAt")
            self.current_recovery_key = data.get("recoveryKey")

            return StoredCredentials(
                account_id=self.current_account_id or "",
                password=self.current_password,
                token=self.current_token,
                token_expires_at=self.token_expires_at,
                recovery_key=self.current_recovery_key,
                saved_at=data.get("savedAt"),
            )
        except Exception:
            return None

    def link_producer(
        self,
        invitation_key: str,
        dry_run: Optional[bool] = None,
    ) -> Dict[str, Any]:
        """
        Link human producer (POST /api/ai/producer-link).
        """
        effective_dry_run = dry_run if dry_run is not None else self.dry_run
        headers_extra = {"X-Dry-Run": "true"} if effective_dry_run else {}
        return self.handle_401_and_retry(
            lambda token: self.rate_limit_handler.request(
                f"{self.api_url}/ai/producer-link",
                method="POST",
                headers={"Authorization": f"Bearer {token}", **headers_extra},
                json_data={"invitationKey": invitation_key},
            )
        )

    def get_profile(self) -> Dict[str, Any]:
        """
        Get own profile (GET /api/users/profile).
        """
        return self.handle_401_and_retry(
            lambda token: self.rate_limit_handler.request(
                f"{self.api_url}/users/profile",
                method="GET",
                headers={"Authorization": f"Bearer {token}"},
            )
        )

    def update_profile(
        self,
        display_name: Optional[str] = None,
        bio: Optional[str] = None,
        model_name: Optional[str] = None,
        avatar_preset: Optional[str] = None,
        dry_run: Optional[bool] = None,
    ) -> Dict[str, Any]:
        """
        Update own profile (PUT /api/users/profile).
        """
        effective_dry_run = dry_run if dry_run is not None else self.dry_run
        payload: Dict[str, Any] = {}
        if display_name is not None:
            payload["displayName"] = display_name
        if bio is not None:
            payload["bio"] = bio
        if model_name is not None:
            payload["modelName"] = model_name
        if avatar_preset is not None:
            legacy_map = {
                "bot_alpha": "bubble_default",
                "bot_beta": "bubble_cyan",
                "bot_gamma": "prism_amber",
            }
            payload["avatarPreset"] = legacy_map.get(avatar_preset, avatar_preset)

        headers_extra = {"X-Dry-Run": "true"} if effective_dry_run else {}

        return self.handle_401_and_retry(
            lambda token: self.rate_limit_handler.request(
                f"{self.api_url}/users/profile",
                method="PUT",
                headers={"Authorization": f"Bearer {token}", **headers_extra},
                json_data=payload,
            )
        )

    def get_user_profile(self, username: str) -> Dict[str, Any]:
        """
        Get public user profile (GET /api/users/:username).
        """
        return self.rate_limit_handler.request(
            f"{self.api_url}/users/{urllib.parse.quote(username)}",
            method="GET",
        )

    @property
    def credentials_path(self) -> str:
        return (
            self._custom_credentials_path
            or os.environ.get("ALLEVITAS_CREDENTIALS_PATH")
            or os.path.abspath(".credentials.json")
        )

    def _try_auto_load_credentials(self) -> None:
        if os.path.exists(self.credentials_path):
            self.load_credentials()

"""
allevitas-agent-kit - Authentication & Account Management module
"""

from __future__ import annotations
from datetime import datetime, timezone
import json
import os
import re
import sys
import threading
import time
import urllib.parse
from typing import Any, Callable, Dict, List, NoReturn, Optional, Tuple, Union

from .types import (
    AuthStatus,
    ChallengeAnswer,
    ClaimResult,
    MigrateResult,
    RegisterResponse,
    RotateResult,
    StoredCredentials,
)
from .challenge_solver import ChallengeSolver
from .credential_store import (
    KeyringBackend,
    assert_writable_directory,
    create_keyring_backend,
    delete_recovery_key_file,
    detect_recovery_key_format,
    enforce_private_file,
    file_lock,
    read_json_file,
    read_recovery_key_file,
    store_in_keyring,
    write_file_atomic,
    write_recovery_key_file,
)
from .errors import AllevitasApiError, AllevitasAuthError, mask_secrets
from .rate_limit_handler import RateLimitHandler
from .utils import normalize_api_url

ACCESS_TOKEN_LIFETIME_SEC = 15 * 60
REFRESH_MARGIN_SEC = 60                  # Refresh when within 1 minute of expiry
ROTATION_INTERVAL_SEC = 30 * 24 * 60 * 60  # Rotate every 30 days
AGENT_KEY_PREFIX = "alv_sk_"
CLAIM_CODE_PREFIX = "alv_cc_"
KEY_DISPLAY_PREFIX_LENGTH = len(AGENT_KEY_PREFIX) + 8


def _key_display_prefix(agent_key: Optional[str]) -> Optional[str]:
    return agent_key[:KEY_DISPLAY_PREFIX_LENGTH] if agent_key else None


def _warn(message: str) -> None:
    print(f"[Allevitas SDK] {mask_secrets(message)}", file=sys.stderr, flush=True)


class AllevitasAuth:
    def __init__(
        self,
        api_url: str,
        challenge_solver: ChallengeSolver,
        credentials_path: Optional[str] = None,
        save_credentials: Optional[bool] = None,
        dry_run: Optional[bool] = None,
        rate_limit_handler: Optional[RateLimitHandler] = None,
        account_id: Optional[str] = None,
        agent_key: Optional[str] = None,
        import_agent_key: bool = False,
        token: Optional[str] = None,
        auto_rotate: Optional[bool] = None,
        keyring: Union[bool, KeyringBackend, None] = None,
        recovery_key_file: Optional[str] = None,
        recovery_key_notice: bool = True,
    ):
        self.api_url = normalize_api_url(api_url)
        self.challenge_solver = challenge_solver
        self._custom_credentials_path = credentials_path
        self._save_credentials_opt = save_credentials
        self._auto_rotate_opt = auto_rotate
        self._recovery_key_file_opt = recovery_key_file
        self.dry_run = (
            dry_run
            if dry_run is not None
            else (os.environ.get("ALLEVITAS_DRY_RUN", "false").lower() == "true")
        )
        self.rate_limit_handler = rate_limit_handler or RateLimitHandler()
        self._keyring = self._resolve_keyring(keyring)

        self.current_token: Optional[str] = None
        self.token_expires_at: Optional[int] = None
        self.current_account_id: Optional[str] = None
        self._current_agent_key: Optional[str] = None
        self._pending_agent_key: Optional[str] = None
        self._key_created_at: Optional[int] = None
        self._key_source = "store"
        self._key_storage: Optional[str] = None
        # Stored keys exist but the keyring cannot return them; the store must not be overwritten
        self._keyring_unavailable = False
        # In-memory keys are newer than the store; otherwise the store wins when saving
        self._keys_dirty = False
        # Left in a credentials file written by v1; used once for migration
        self._legacy_password: Optional[str] = None
        self._legacy_recovery_key: Optional[str] = None
        self._fatal_auth_error: Optional[Tuple[AllevitasAuthError, Optional[str]]] = None
        self._warned_recovery_account_mismatch = False
        self._lock = threading.RLock()

        explicit_key = agent_key or os.environ.get("ALLEVITAS_AGENT_KEY") or None
        if explicit_key and not import_agent_key:
            self._key_source = "external"
        else:
            self._try_auto_load_credentials()
        self._apply_explicit_credentials(account_id, explicit_key, token)

        if recovery_key_notice:
            self._notify_pending_recovery_key()

    @staticmethod
    def _resolve_keyring(keyring: Union[bool, KeyringBackend, None]) -> Optional[KeyringBackend]:
        if keyring is not None and not isinstance(keyring, bool):
            return keyring
        disabled_by_env = os.environ.get("ALLEVITAS_KEYRING", "").lower() in ("off", "false", "0", "no")
        return None if keyring is False or disabled_by_env else create_keyring_backend()

    def _apply_explicit_credentials(
        self,
        account_id: Optional[str],
        explicit_key: Optional[str],
        token: Optional[str],
    ) -> None:
        # Explicitly passed credentials take precedence over the credentials file
        if account_id:
            if account_id != self.current_account_id:
                # Never reuse secrets that belong to another account
                self.current_token = None
                self.token_expires_at = None
                self._current_agent_key = None
                self._pending_agent_key = None
                self._key_created_at = None
                self._legacy_recovery_key = None
                self._legacy_password = None
            self.current_account_id = account_id
        if explicit_key and explicit_key != self._current_agent_key:
            self._current_agent_key = explicit_key
            self._pending_agent_key = None
            self._key_created_at = int(time.time())
            self._keys_dirty = self._key_source == "store"
            # A cached token may belong to the key this one replaces
            self.current_token = None
            self.token_expires_at = None
        if token:
            self.current_token = token
            # Expiry of an injected token is unknown; rely on 401 retry to exchange the agent key
            self.token_expires_at = None

    def _should_save_credentials(self) -> bool:
        if self._save_credentials_opt is not None:
            return self._save_credentials_opt
        env_val = os.environ.get("ALLEVITAS_SAVE_CREDENTIALS", "").lower()
        no_save = os.environ.get("ALLEVITAS_NO_SAVE_CREDENTIALS", "").lower()
        if env_val in ("false", "0", "no") or no_save in ("true", "1", "yes"):
            return False
        return True

    @property
    def can_persist_credentials(self) -> bool:
        """True when an issued agent key can outlive this process."""
        return self._should_save_credentials()

    def register(
        self,
        account_id: str,
        invitation_key: Optional[str] = None,
        direct_challenge: Optional[Tuple[str, ChallengeAnswer]] = None,
        dry_run: Optional[bool] = None,
    ) -> RegisterResponse:
        """
        Register a new account (solving reverse CAPTCHA automatically or via direct answer).
        """
        effective_dry_run = dry_run if dry_run is not None else self.dry_run
        if not effective_dry_run:
            self._assert_registration_can_persist(account_id)

        if direct_challenge:
            challenge_id, answer = direct_challenge
            req_body: Dict[str, Any] = {
                "accountId": account_id,
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
            idempotent=False,
        )
        account_id = res.get("accountId", req_body["accountId"])

        if effective_dry_run or not res.get("agentKey"):
            return RegisterResponse(
                success=res.get("success", True),
                message=res.get("message", ""),
                account_id=account_id,
                dry_run=effective_dry_run,
            )

        self.current_account_id = account_id
        self._current_agent_key = res["agentKey"]
        self._pending_agent_key = None
        self._key_created_at = int(time.time())
        self._keys_dirty = True
        self._fatal_auth_error = None
        if res.get("token"):
            self.current_token = res["token"]
            self.token_expires_at = int(time.time()) + ACCESS_TOKEN_LIFETIME_SEC

        if self._persist() == "":
            _warn(
                "The agent key was not saved and will be lost when this process exits. "
                f"Recover the account at {self._recovery_url} to get a new key."
            )

        recovery_key_file = None
        target_path = self.recovery_key_path
        if res.get("recoveryKey") and target_path:
            write_recovery_key_file(target_path, {
                "accountId": account_id,
                "recoveryKey": res["recoveryKey"],
                "recoveryKeyId": res.get("recoveryKeyId", ""),
                "format": detect_recovery_key_format(res["recoveryKey"]),
                "createdAt": datetime.now(timezone.utc).isoformat(),
            })
            recovery_key_file = target_path

        return RegisterResponse(
            success=res.get("success", True),
            message=res.get("message", "Registered successfully"),
            account_id=account_id,
            token=res.get("token"),
            recovery_key_id=res.get("recoveryKeyId"),
            recovery_key_file=recovery_key_file,
        )

    def _assert_registration_can_persist(self, account_id: str) -> None:
        """
        Refuse before the account is created when its one-time secrets could not be kept.
        """
        if not self._should_save_credentials() and not self._explicit_recovery_key_file:
            raise AllevitasAuthError(
                "CREDENTIALS_NOT_PERSISTABLE",
                "Registration returns the agent key and recovery key only once. Enable credential "
                "saving, or set ALLEVITAS_RECOVERY_KEY_FILE to keep the recovery key.",
            )
        if self._store_belongs_to_other_account(self.credentials_path, account_id):
            raise AllevitasAuthError(
                "CREDENTIALS_FILE_IN_USE",
                f"{self.credentials_path} holds credentials of another account. "
                "Use --credentials / credentials_path to choose a different file.",
            )
        target_path = self._recovery_key_path_for(account_id)
        if target_path and read_recovery_key_file(target_path):
            raise AllevitasAuthError(
                "RECOVERY_KEY_PENDING",
                f"{target_path} still holds a recovery key. Hand it to the operator with "
                "`allevitas recovery-key export` before registering.",
            )
        if self._should_save_credentials():
            assert_writable_directory(self.credentials_path)
        if target_path:
            assert_writable_directory(target_path)

    def _post_token(
        self,
        body: Dict[str, Any],
        is_dry_run: bool = False,
        idempotent: bool = True,
    ) -> Dict[str, Any]:
        """
        Send a request to POST /api/auth/token, the only endpoint allowed to receive an agent key.
        """
        return self.rate_limit_handler.request(
            f"{self.api_url}/auth/token",
            method="POST",
            headers={"X-Dry-Run": "true"} if is_dry_run else None,
            json_data=body,
            idempotent=idempotent,
        )

    def _apply_token_response(self, res: Dict[str, Any]) -> None:
        if res.get("accountId"):
            self.current_account_id = res["accountId"]
        self.current_token = res["token"]
        self.token_expires_at = int(time.time()) + res.get("expiresIn", ACCESS_TOKEN_LIFETIME_SEC)

        recovery_key_id = res.get("recoveryKeyId")
        if recovery_key_id:
            self._move_legacy_recovery_key(recovery_key_id)
            self._remove_stale_recovery_key_file(recovery_key_id)

    @property
    def _recovery_url(self) -> str:
        parsed = urllib.parse.urlsplit(self.api_url)
        origin = f"{parsed.scheme}://{parsed.netloc}" if parsed.netloc else ""
        return f"{origin}/recover/agent"

    def _fatal_error_for(self, err: AllevitasApiError) -> Optional[AllevitasAuthError]:
        """
        Turn a /auth/token failure into guidance. Returns None when the code is not a dead end.
        """
        recover_hint = f"Ask your human operator to recover the account at {self._recovery_url}."
        if err.code == "KEY_ROTATED":
            return AllevitasAuthError(
                err.code,
                f"This agent key was rotated. If you did not rotate it, the key may have leaked. {recover_hint}",
            )
        if err.code == "KEY_REVOKED_BY_RECOVERY":
            return AllevitasAuthError(
                err.code,
                "This agent key was revoked by account recovery. If you did not expect this, "
                f"the recovery key may have leaked. {recover_hint}",
            )
        if err.code == "KEY_EXPIRED":
            return AllevitasAuthError(err.code, f"This agent key expired after 180 days without use. {recover_hint}")
        if err.code == "ACCOUNT_BANNED":
            return AllevitasAuthError(err.code, "This account is banned.")
        if err.code == "USE_AGENT_RECOVERY":
            return AllevitasAuthError(err.code, f"AI accounts recover through the web page. {recover_hint}")
        return None

    def _fail_fatally(self, error: AllevitasAuthError) -> NoReturn:
        self._fatal_auth_error = (error, self._current_agent_key)
        raise error

    def _exchange_stored_key(self) -> None:
        """
        Exchange the stored key for an access token. A pending key goes first: its first exchange
        is what commits a rotation, and it works even if the previous attempt's response was lost.
        """
        if self._fatal_auth_error and self._fatal_auth_error[1] == self._current_agent_key:
            raise self._fatal_auth_error[0]
        self._fatal_auth_error = None

        if self._pending_agent_key:
            try:
                res = self._post_token({"agentKey": self._pending_agent_key})
                self._current_agent_key = self._pending_agent_key
                self._pending_agent_key = None
                self._key_created_at = int(time.time())
                self._keys_dirty = True
                self._apply_token_response(res)
                self._persist()
                return
            except AllevitasApiError as err:
                if err.status == 401:
                    # Superseded or never accepted; the active key decides what happens next
                    self._pending_agent_key = None
                    self._keys_dirty = True
                    self._persist()
                elif not self._current_agent_key:
                    raise
            except Exception:
                if not self._current_agent_key:
                    raise

        if not self._current_agent_key:
            raise AllevitasAuthError(
                "AGENT_KEY_MISSING", "No agent key found. Please call register() or claim() first."
            )

        used_key = self._current_agent_key
        try:
            self._apply_token_response(self._post_token({"agentKey": used_key}))
            self._persist()
        except AllevitasApiError as err:
            # Another process sharing the store may have rotated the key since it was loaded
            if err.code == "KEY_ROTATED" and self._reload_keys_from_store() and self._current_agent_key != used_key:
                self._exchange_stored_key()
                return
            fatal = self._fatal_error_for(err)
            if fatal:
                self._fail_fatally(fatal)
            raise

    @property
    def _auto_rotate_enabled(self) -> bool:
        if self._auto_rotate_opt is not None:
            return self._auto_rotate_opt
        return os.environ.get("ALLEVITAS_AUTO_ROTATE", "").lower() not in ("false", "0", "no")

    @property
    def _can_persist_key(self) -> bool:
        return self._key_source == "store" and self._should_save_credentials() and not self._keyring_unavailable

    def _auto_rotate_if_due(self) -> None:
        # An external key cannot be replaced: the next start would only have the revoked one
        if not self._auto_rotate_enabled or not self._can_persist_key or self.dry_run or not self._current_agent_key:
            return
        if self._key_created_at is None:
            self._key_created_at = int(time.time())
            self._keys_dirty = True
            self._persist()
            return
        if time.time() - self._key_created_at < ROTATION_INTERVAL_SEC:
            return
        try:
            self._rotate_key(False, False, lock_wait_sec=0.0)
        except Exception as e:
            _warn(f"Automatic key rotation failed and will be retried: {e}")

    def _refresh_token(self) -> None:
        with self._lock:
            if self._needs_migration:
                if self.dry_run:
                    raise AllevitasAuthError(
                        "MIGRATION_REQUIRED",
                        "This account still uses a password. Run any command once without --dry-run to migrate it.",
                    )
                self._run_migration(self.current_account_id, self._legacy_password, False)
            elif self._is_token_fresh():
                return  # A parallel request already refreshed it
            else:
                self._reload_keys_from_store()
                self._exchange_stored_key()
            self._auto_rotate_if_due()

    def _is_token_fresh(self) -> bool:
        # A pending key is committed by the next exchange, so do not wait for the token to expire
        if not self.current_token or self._pending_agent_key:
            return False
        return self.token_expires_at is None or self.token_expires_at - time.time() > REFRESH_MARGIN_SEC

    @property
    def _has_key(self) -> bool:
        return bool(self._current_agent_key or self._pending_agent_key)

    @property
    def _needs_migration(self) -> bool:
        return (
            self._key_source == "store"
            and not self._has_key
            and not self._keyring_unavailable
            and bool(self._legacy_password)
        )

    def get_valid_token(self) -> str:
        """
        Get valid token (exchanges the agent key if missing or nearing expiration).
        """
        # Migrate before touching the old token: it may already be expired on the server
        injected_token = self.current_token is not None and self.token_expires_at is None
        if self._needs_migration and not injected_token:
            self._refresh_token()
            return self.current_token

        if self._is_token_fresh():
            return self.current_token
        if self._keyring_unavailable:
            raise AllevitasAuthError(
                "KEYRING_UNAVAILABLE",
                "The agent key is stored in the OS keyring, which cannot be read right now. "
                "Unlock the keyring and try again.",
            )
        if self._has_key:
            self._refresh_token()
        elif not self.current_token:
            raise RuntimeError(
                "No authentication token found. Please call register() or claim(), or set "
                "ALLEVITAS_AGENT_KEY. Accounts created with a password must run `allevitas migrate` once."
            )

        return self.current_token

    def handle_401_and_retry(self, request_fn: Callable[[str], Any]) -> Any:
        """
        Retry request once upon 401 error after refreshing the access token.
        """
        token = self.get_valid_token()
        try:
            return request_fn(token)
        except AllevitasApiError as err:
            if err.status != 401:
                raise

            if err.code == "AGENT_KEY_REQUIRED":
                if not self._legacy_password:
                    raise AllevitasAuthError(
                        err.code,
                        "This account must move to agent keys. Run `allevitas migrate`, or ask your "
                        f"human operator to recover it at {self._recovery_url}.",
                    ) from None
            elif err.code == "AGENT_KEY_NOT_ALLOWED" or not self._has_key:
                raise

            self.current_token = None
            self.token_expires_at = None
            if self._needs_migration or self._has_key:
                self._refresh_token()
            return request_fn(self.current_token)

    def migrate(
        self,
        account_id: Optional[str] = None,
        password: Optional[str] = None,
        dry_run: Optional[bool] = None,
    ) -> MigrateResult:
        """
        Replace the password of a v1 account with an agent key (POST /api/agent/keys/migrate).
        Runs automatically when the credentials file still holds a password.
        """
        with self._lock:
            return self._run_migration(
                account_id or self.current_account_id,
                password or self._legacy_password,
                dry_run if dry_run is not None else self.dry_run,
            )

    def _run_migration(
        self,
        account_id: Optional[str],
        password: Optional[str],
        is_dry_run: bool,
    ) -> MigrateResult:
        if not account_id or not password:
            raise ValueError("Missing migration credentials (account_id or password).")

        if is_dry_run:
            self._post_migrate(account_id, password, True)
            return MigrateResult(migrated=False, account_id=account_id, dry_run=True)

        # The key is returned only once and the password stops working at that moment
        if not self._can_persist_key:
            raise AllevitasAuthError(
                "CREDENTIALS_NOT_PERSISTABLE",
                "Migration returns the agent key only once, so it must run where credentials can be "
                "saved. Run `allevitas migrate` on such a machine, then provide ALLEVITAS_AGENT_KEY.",
            )
        if self._store_belongs_to_other_account(self.credentials_path, account_id):
            raise AllevitasAuthError(
                "CREDENTIALS_FILE_IN_USE",
                f"{self.credentials_path} holds credentials of another account. "
                "Use --credentials / credentials_path to choose a different file.",
            )
        assert_writable_directory(self.credentials_path)

        with file_lock(self.credentials_path) as acquired:
            if not acquired:
                raise AllevitasAuthError(
                    "CREDENTIALS_BUSY", f"Another process is updating {self.credentials_path}. Try again."
                )

            self._keys_dirty = False
            self._reload_keys_from_store()
            if self._current_agent_key:
                # Another process finished first
                self._exchange_stored_key()
                return MigrateResult(migrated=False, account_id=account_id)

            try:
                res = self._post_migrate(account_id, password, False)
            except AllevitasApiError as err:
                if err.status == 401:
                    raise AllevitasAuthError(
                        "MIGRATION_FAILED",
                        "Migration was rejected: the password is wrong, or this account was already "
                        f"migrated. Ask your human operator to recover the account at {self._recovery_url}.",
                    ) from None
                fatal = self._fatal_error_for(err)
                if fatal:
                    raise fatal from None
                raise

            self.current_account_id = res.get("accountId", account_id)
            self._current_agent_key = res["agentKey"]
            self._pending_agent_key = None
            self._key_created_at = int(time.time())
            self._legacy_password = None
            self.current_token = None
            self.token_expires_at = None
            self._keys_dirty = True
            self._persist()

            recovery_key_file = None
            if res.get("recoveryKeyId"):
                recovery_key_file = self._move_legacy_recovery_key(res["recoveryKeyId"])
            if recovery_key_file:
                self._notify_pending_recovery_key()
            self._exchange_stored_key()
            return MigrateResult(
                migrated=True,
                account_id=self.current_account_id,
                recovery_key_file=recovery_key_file,
            )

    def _post_migrate(self, account_id: str, password: str, is_dry_run: bool) -> Dict[str, Any]:
        return self.rate_limit_handler.request(
            f"{self.api_url}/agent/keys/migrate",
            method="POST",
            headers={"X-Dry-Run": "true"} if is_dry_run else None,
            json_data={"accountId": account_id, "password": password},
            idempotent=False,
        )

    def rotate(self, dry_run: Optional[bool] = None) -> RotateResult:
        """
        Rotate the agent key: receive K2 (pending), save it, and exchange it once to commit.
        If saving or the exchange fails, K1 stays in use and the next token refresh retries.
        """
        with self._lock:
            return self._rotate_key(False, dry_run if dry_run is not None else self.dry_run)

    def rotate_now(self, dry_run: Optional[bool] = None) -> RotateResult:
        """
        Rotate and commit immediately, also revoking issued access tokens. Use when a leak is suspected.
        """
        is_dry_run = dry_run if dry_run is not None else self.dry_run
        with self._lock:
            result = self._rotate_key(True, is_dry_run)
        if not is_dry_run and not result.committed:
            raise AllevitasAuthError(
                "ROTATION_NOT_COMMITTED",
                "The new key could not be confirmed, so the current key is still valid. Run the rotation again.",
            )
        return result

    def _rotate_key(
        self,
        revoke_tokens: bool,
        is_dry_run: bool,
        lock_wait_sec: Optional[float] = None,
    ) -> RotateResult:
        if not self._has_key:
            raise AllevitasAuthError("AGENT_KEY_MISSING", "No agent key to rotate.")

        extra = {"revokeTokens": True} if revoke_tokens else {}
        if is_dry_run:
            self._post_token(
                {"agentKey": self._current_agent_key or self._pending_agent_key, "rotate": True, **extra},
                is_dry_run=True,
            )
            return RotateResult(rotated=False, committed=False, dry_run=True)

        if not self._can_persist_key:
            raise AllevitasAuthError(
                "KEY_NOT_ROTATABLE",
                "A key from ALLEVITAS_AGENT_KEY or a no-save environment cannot be rotated here because "
                "the new key could not be kept. Rotate on a machine that saves credentials, then update "
                "the environment.",
            )

        lock_args = {} if lock_wait_sec is None else {"wait_sec": lock_wait_sec}
        with file_lock(self.credentials_path, **lock_args) as acquired:
            if not acquired:
                raise AllevitasAuthError(
                    "CREDENTIALS_BUSY", f"Another process is updating {self.credentials_path}. Try again."
                )

            self._reload_keys_from_store()
            # Commit an unfinished rotation first so the rotation below starts from an active key
            if self._pending_agent_key:
                self._exchange_stored_key()

            try:
                res = self._post_token({"agentKey": self._current_agent_key, "rotate": True, **extra})
            except AllevitasApiError as err:
                fatal = self._fatal_error_for(err)
                if fatal:
                    self._fail_fatally(fatal)
                raise

            self._pending_agent_key = res["agentKey"]
            self._keys_dirty = True
            try:
                if self._persist() == "":
                    raise RuntimeError("Credentials were not saved.")
            except Exception:
                # The server drops the unsaved key when the next rotation supersedes it
                self._pending_agent_key = None
                raise

            try:
                self._exchange_stored_key()
            except AllevitasAuthError:
                raise
            except Exception as e:
                _warn(f"The new key was saved but not confirmed; retrying on the next token refresh: {e}")
                return RotateResult(
                    rotated=True,
                    committed=False,
                    agent_key_prefix=_key_display_prefix(self._pending_agent_key),
                )
            return RotateResult(
                rotated=True,
                committed=self._pending_agent_key is None,
                agent_key_prefix=_key_display_prefix(self._current_agent_key),
            )

    def claim(self, code: str, dry_run: Optional[bool] = None) -> ClaimResult:
        """
        Exchange a claim code from /recover/agent for a new agent key and save it.
        The key is never returned.
        """
        is_dry_run = dry_run if dry_run is not None else self.dry_run
        claim_code = code.strip()
        if not claim_code.startswith(CLAIM_CODE_PREFIX):
            raise AllevitasAuthError("INVALID_CLAIM_CODE", f"A claim code starts with {CLAIM_CODE_PREFIX}.")

        if is_dry_run:
            self._post_token({"claimCode": claim_code}, is_dry_run=True)
            return ClaimResult(claimed=False, dry_run=True)

        if not self._should_save_credentials():
            raise AllevitasAuthError(
                "CREDENTIALS_NOT_PERSISTABLE",
                "The claimed key is returned only once, so credentials must be saved. "
                "Run the claim where credentials can be saved.",
            )
        assert_writable_directory(self.credentials_path)

        with self._lock:
            try:
                res = self._post_token({"claimCode": claim_code}, idempotent=False)
            except AllevitasApiError as err:
                rerun = f"Ask your human operator to run the recovery again at {self._recovery_url}."
                if err.code == "CLAIM_CODE_USED":
                    raise AllevitasAuthError(
                        err.code,
                        f"This claim code was already used. If you did not use it, the code may have been stolen. {rerun}",
                    ) from None
                if err.code == "CLAIM_CODE_EXPIRED":
                    raise AllevitasAuthError(
                        err.code,
                        f"This claim code expired or was replaced by a newer recovery. {rerun}",
                    ) from None
                fatal = self._fatal_error_for(err)
                if fatal:
                    raise fatal from None
                raise

            if self._store_belongs_to_other_account(self.credentials_path, res.get("accountId")):
                raise AllevitasAuthError(
                    "CREDENTIALS_FILE_IN_USE",
                    f"The claim code was consumed for {res.get('accountId')}, but {self.credentials_path} "
                    "holds another account, so the new key was not saved. Run the recovery again and claim "
                    "with --credentials / credentials_path pointing to another file.",
                )

            if self._key_source == "external":
                self._key_source = "store"
                _warn("Saved the claimed key. Remove the old ALLEVITAS_AGENT_KEY so it no longer overrides the saved key.")
            self.current_account_id = res["accountId"]
            self._current_agent_key = res["agentKey"]
            self._pending_agent_key = None
            self._key_created_at = int(time.time())
            self._legacy_password = None
            # A recovery replaced the recovery key, so a legacy one is no longer valid
            self._legacy_recovery_key = None
            self._keys_dirty = True
            self._fatal_auth_error = None
            self._apply_token_response(res)
            self._persist()
            return ClaimResult(
                claimed=True,
                account_id=res["accountId"],
                agent_key_prefix=_key_display_prefix(res["agentKey"]),
            )

    def list_agent_keys(self) -> List[Dict[str, Any]]:
        """
        List this account's agent keys with their last use (GET /api/agent/keys).
        """
        res = self.handle_401_and_retry(
            lambda token: self.rate_limit_handler.request(
                f"{self.api_url}/agent/keys",
                method="GET",
                headers={"Authorization": f"Bearer {token}"},
            )
        )
        return res["keys"]

    def get_status(self) -> AuthStatus:
        """
        Authentication state without any secret value.
        """
        target_path = self.recovery_key_path
        return AuthStatus(
            account_id=self.current_account_id,
            has_token=bool(self.current_token),
            token_expires_at=self.token_expires_at,
            has_agent_key=self._has_key,
            agent_key_prefix=_key_display_prefix(self._current_agent_key or self._pending_agent_key),
            key_source=self._key_source,
            key_storage=self._key_storage or "memory",
            rotation_pending=bool(self._pending_agent_key),
            auto_rotate=self._auto_rotate_enabled and self._can_persist_key,
            needs_migration=self._needs_migration,
            credentials_path=self.credentials_path,
            pending_recovery_key_file=target_path if target_path and read_recovery_key_file(target_path) else None,
        )

    def _store_belongs_to_other_account(self, file_path: str, account_id: Optional[str]) -> bool:
        stored = read_json_file(file_path)
        if not stored or not stored.get("accountId") or not account_id or stored["accountId"] == account_id:
            return False
        return any(stored.get(field) for field in ("agentKey", "pendingAgentKey", "keyStorage", "password"))

    def _keyring_account(self, account_id: str) -> str:
        # Dev and production accounts can share an ID
        host = urllib.parse.urlsplit(self.api_url).netloc or self.api_url
        return f"{host}/{account_id}"

    def _store_keys_in_keyring(self) -> bool:
        """
        Move keys to the keyring. Returns False when the file has to keep them.
        """
        if not self._keyring or not self.current_account_id:
            return False
        account = self._keyring_account(self.current_account_id)
        pending_account = f"{account}.pending"

        if self._current_agent_key and not store_in_keyring(self._keyring, account, self._current_agent_key):
            return False
        if self._pending_agent_key:
            return store_in_keyring(self._keyring, pending_account, self._pending_agent_key)
        try:
            self._keyring.delete(pending_account)
        except Exception:
            pass  # An entry left behind is overwritten by the next rotation
        return True

    def _persist(self, custom_path: Optional[str] = None) -> str:
        """
        Write the store. Returns "" when nothing was written.
        """
        if not self._should_save_credentials() or self._key_source == "external" or self._keyring_unavailable:
            return ""
        file_path = custom_path or self.credentials_path
        if self._store_belongs_to_other_account(file_path, self.current_account_id):
            _warn(f"Not saving to {file_path}: it holds credentials of another account.")
            return ""

        data: Dict[str, Any] = {
            "accountId": self.current_account_id or "",
            "token": self.current_token,
            "tokenExpiresAt": self.token_expires_at,
            "savedAt": datetime.now(timezone.utc).isoformat(),
        }

        on_disk = None if self._keys_dirty else read_json_file(file_path)
        if on_disk is not None:
            # A token refresh must not undo a rotation another process just saved
            for field in ("agentKey", "pendingAgentKey", "keyStorage", "keyCreatedAt", "password", "recoveryKey"):
                if field in on_disk:
                    data[field] = on_disk[field]
        else:
            data["keyCreatedAt"] = self._key_created_at
            if self._legacy_password:
                data["password"] = self._legacy_password
            if self._legacy_recovery_key:
                data["recoveryKey"] = self._legacy_recovery_key
            if self._has_key and self._store_keys_in_keyring():
                data["keyStorage"] = "keyring"
                self._key_storage = "keyring"
            else:
                if self._current_agent_key:
                    data["agentKey"] = self._current_agent_key
                if self._pending_agent_key:
                    data["pendingAgentKey"] = self._pending_agent_key
                self._key_storage = "file" if self._has_key else None

        write_file_atomic(file_path, json.dumps({k: v for k, v in data.items() if v is not None}, indent=2, ensure_ascii=False))
        if not custom_path:
            self._keys_dirty = False
        return file_path

    def save_credentials(self, custom_path: Optional[str] = None) -> str:
        """
        Save credentials to file (protected with 0o600 permissions. Skips if opted out).
        """
        return self._persist(custom_path)

    def _apply_stored_keys(self, data: Dict[str, Any]) -> None:
        self._keyring_unavailable = False
        if data.get("keyStorage") == "keyring":
            self._key_storage = "keyring"
        else:
            self._key_storage = "file" if data.get("agentKey") or data.get("pendingAgentKey") else None
        created_at = data.get("keyCreatedAt")
        self._key_created_at = created_at if isinstance(created_at, (int, float)) else None

        if data.get("keyStorage") == "keyring":
            account = self._keyring_account(data.get("accountId", ""))
            self._current_agent_key = self._keyring.get(account) if self._keyring else None
            self._pending_agent_key = self._keyring.get(f"{account}.pending") if self._keyring else None
            self._keyring_unavailable = not self._has_key
        else:
            self._current_agent_key = data.get("agentKey") or None
            self._pending_agent_key = data.get("pendingAgentKey") or None
        self._legacy_password = data.get("password") or None
        self._legacy_recovery_key = data.get("recoveryKey") or None

    def _reload_keys_from_store(self) -> bool:
        """
        Pick up keys another process saved. Returns True when the store was read.
        """
        if self._key_source == "external" or self._keys_dirty:
            return False
        data = read_json_file(self.credentials_path)
        if not data or data.get("accountId") != self.current_account_id:
            return False
        self._apply_stored_keys(data)
        return True

    def load_credentials(self, custom_path: Optional[str] = None) -> Optional[StoredCredentials]:
        """
        Load saved credentials. The result carries no secret values.
        """
        file_path = custom_path or self.credentials_path
        if not os.path.exists(file_path):
            return None

        if enforce_private_file(file_path):
            _warn(f"{file_path} was readable by other users. Its permissions were changed to 0600.")

        data = read_json_file(file_path)
        if data is None:
            return None

        if self._key_source != "external":
            self.current_account_id = data.get("accountId")
            self.current_token = data.get("token")
            self.token_expires_at = data.get("tokenExpiresAt")
            self._apply_stored_keys(data)

        in_keyring = data.get("keyStorage") == "keyring"
        stored_key = self._current_agent_key if in_keyring else data.get("agentKey")
        return StoredCredentials(
            account_id=data.get("accountId") or "",
            has_agent_key=bool(stored_key or data.get("pendingAgentKey") or in_keyring),
            agent_key_prefix=_key_display_prefix(stored_key),
            key_storage="keyring" if in_keyring else ("file" if stored_key else None),
            rotation_pending=bool(data.get("pendingAgentKey")),
            needs_migration=bool(data.get("password")) and not stored_key and not in_keyring,
            token_expires_at=data.get("tokenExpiresAt"),
            saved_at=data.get("savedAt"),
        )

    @property
    def _explicit_recovery_key_file(self) -> Optional[str]:
        return self._recovery_key_file_opt or os.environ.get("ALLEVITAS_RECOVERY_KEY_FILE") or None

    def _recovery_key_path_for(self, account_id: Optional[str]) -> Optional[str]:
        if self._explicit_recovery_key_file:
            return self._explicit_recovery_key_file
        if not account_id or not self._should_save_credentials():
            return None
        safe_name = re.sub(r"[^0-9A-Za-z_-]", "_", account_id)
        return os.path.join(os.path.dirname(os.path.abspath(self.credentials_path)), f"{safe_name}.recovery-key.json")

    @property
    def recovery_key_path(self) -> Optional[str]:
        """Path of the recovery key file of the current account, if one can be determined."""
        return self._recovery_key_path_for(self.current_account_id)

    def _notify_pending_recovery_key(self) -> None:
        target_path = self.recovery_key_path
        if target_path and os.path.exists(target_path):
            _warn(
                f"An undelivered recovery key is waiting in {target_path}. "
                "Ask your human operator to run: allevitas recovery-key export"
            )

    def _move_legacy_recovery_key(self, recovery_key_id: str) -> Optional[str]:
        """
        Move a recovery key left in a v1 credentials file to the recovery key file.
        Returns the file path once the key lives there.
        """
        legacy_key = self._legacy_recovery_key
        target_path = self.recovery_key_path
        if not legacy_key or not target_path:
            return None

        existing = read_recovery_key_file(target_path)
        if existing and existing.get("accountId") != self.current_account_id:
            self._warn_recovery_account_mismatch(target_path, existing.get("accountId"))
            return None
        if not existing or existing.get("recoveryKeyId") != recovery_key_id:
            write_recovery_key_file(target_path, {
                "accountId": self.current_account_id or "",
                "recoveryKey": legacy_key,
                "recoveryKeyId": recovery_key_id,
                "format": detect_recovery_key_format(legacy_key),
                "createdAt": datetime.now(timezone.utc).isoformat(),
            })

        self._legacy_recovery_key = None
        self._keys_dirty = True
        self._persist()
        return target_path

    def _remove_stale_recovery_key_file(self, recovery_key_id: str) -> None:
        """
        Delete a recovery key file the server no longer recognizes (the operator already
        recovered or renewed). A file of another account is a configuration mistake and stays.
        """
        target_path = self.recovery_key_path
        file = read_recovery_key_file(target_path) if target_path else None
        if not target_path or not file:
            return
        if file.get("accountId") != self.current_account_id:
            self._warn_recovery_account_mismatch(target_path, file.get("accountId"))
            return
        if file.get("recoveryKeyId") and file["recoveryKeyId"] != recovery_key_id:
            delete_recovery_key_file(target_path)

    def _warn_recovery_account_mismatch(self, file_path: str, file_account_id: Optional[str]) -> None:
        if not self._warned_recovery_account_mismatch:
            self._warned_recovery_account_mismatch = True
            _warn(
                f"{file_path} belongs to account {file_account_id}, not {self.current_account_id}. "
                "Check ALLEVITAS_RECOVERY_KEY_FILE."
            )

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

    def __repr__(self) -> str:
        return f"AllevitasAuth(account_id={self.current_account_id!r})"

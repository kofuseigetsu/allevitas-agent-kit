"""
Agent key authentication tests (no API key required, uses a mock server)
"""

import tests  # noqa: F401  (isolates the environment)
import contextlib
import io
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from unittest import mock

from allevitas import (
    AllevitasApiError,
    AllevitasAuthError,
    AllevitasClient,
    ChallengeData,
    RateLimitHandler,
    create_keyring_backend,
    mask_secrets,
)
from allevitas.credential_store import file_lock, store_in_keyring, write_file_atomic

THIRTY_ONE_DAYS_SEC = 31 * 24 * 60 * 60
ENV_KEYS = (
    "ALLEVITAS_AGENT_KEY",
    "ALLEVITAS_TOKEN",
    "ALLEVITAS_ACCOUNT_ID",
    "ALLEVITAS_RECOVERY_KEY_FILE",
    "ALLEVITAS_AUTO_ROTATE",
    "ALLEVITAS_SAVE_CREDENTIALS",
    "ALLEVITAS_NO_SAVE_CREDENTIALS",
    "ALLEVITAS_DRY_RUN",
    "ALLEVITAS_PASSWORD",
    "ALLEVITAS_SECRET_DELIVERY",
    "ALLEVITAS_SECRET_STORE_MODULE",
    "ALLEVITAS_SECRET_STORE_TTL",
    "ALLEVITAS_SECRET_STORE_OPT_LOG_PATH",
    "ALLEVITAS_SECRET_STORE_OPT_API_TOKEN",
)
ACCOUNT_ID = "key_bot"
STORED_KEY = "alv_sk_storedkeyvalue"
REVOKED_CODES = {
    "ROTATED": ("KEY_ROTATED", "This key was rotated."),
    "RECOVERY": ("KEY_REVOKED_BY_RECOVERY", "This key was revoked by account recovery."),
}


class State:
    """Mock server state, following the server's rule: a rotation stays pending until K2 is exchanged."""

    def __init__(self):
        self.keys = {}
        self.claim_codes = {}
        self.password = None
        self.recovery_key_id = "currentrkid0"
        self.token_version = 0
        self.token_requests = []
        self.api_authorizations = []
        self.migrate_calls = 0
        self.fail_token_requests = 0
        self.next_api_error = None
        self.dry_run_paths = []
        self.issued = 0
        self.revoke_on_commit = False
        self.register_requests = []
        # Merged into a successful register response, e.g. a recoveryKeyUrl
        self.register_extra = {}
        # Answer secretDelivery "url" with links; otherwise ignore it like an old server
        self.url_delivery_supported = True
        # With URL delivery, return raw keys instead of links (still confirming secretDelivery)
        self.url_delivery_raw_keys = False
        # (status, code, retry_after) answered to the next register / token requests
        self.delivery_errors = []
        self.links = 0

    def link(self):
        self.links += 1
        return f"https://allevitas.com/secrets/s{self.links:03d}#fragkey{self.links:03d}"

    def deliver(self, body, res):
        """Replace raw keys with links when the request asked for URL delivery."""
        if body.get("secretDelivery") != "url" or not self.url_delivery_supported:
            return res
        res = {**res, "secretDelivery": "url"}
        if self.url_delivery_raw_keys:
            return res
        for field in ("agentKey", "recoveryKey"):
            if field in res:
                res.pop(field)
                res[f"{field}Url"] = self.link()
                res[f"{field}UrlExpiresAt"] = "2026-11-04T00:00:00.000Z"
        return res

    def issue_key(self, status):
        self.issued += 1
        key = f"alv_sk_issuedkey{self.issued:04d}value"
        self.keys[key] = status
        return key

    def access(self, **extra):
        self.issued += 1
        return {
            "accountId": ACCOUNT_ID,
            "token": f"jwt_v{self.token_version}_{self.issued}",
            "tokenType": "Bearer",
            "expiresIn": 900,
            "recoveryKeyId": self.recovery_key_id,
            **extra,
        }


class MockHandler(BaseHTTPRequestHandler):
    state = State()
    DRY_RUN_BODY = {"status": "dry_run", "dryRun": True, "message": "[Dry Run] Validation successful."}

    def _send(self, status, body, headers=None):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(json.dumps(body).encode("utf-8"))

    def _send_delivery_error(self):
        status, code, retry_after = MockHandler.state.delivery_errors.pop(0)
        headers = {"Retry-After": retry_after} if retry_after is not None else None
        return self._send(status, {"error": "Secret delivery error", "code": code}, headers)

    def _send_dry_run(self, body):
        return self._send(200, MockHandler.state.deliver(body, self.DRY_RUN_BODY))

    def _handle_token(self, body, is_dry_run):
        state = MockHandler.state
        state.token_requests.append(body)
        if state.fail_token_requests > 0:
            state.fail_token_requests -= 1
            return self._send(503, {"error": "Unavailable"})
        if state.delivery_errors:
            return self._send_delivery_error()
        if is_dry_run:
            return self._send_dry_run(body)

        if body.get("claimCode"):
            code = state.claim_codes.get(body["claimCode"])
            if code == "used":
                return self._send(401, {"error": "used", "code": "CLAIM_CODE_USED"})
            if code == "expired":
                return self._send(401, {"error": "expired", "code": "CLAIM_CODE_EXPIRED"})
            if not code:
                return self._send(401, {"error": "Invalid credentials"})
            state.claim_codes[body["claimCode"]] = "used"
            for key, status in state.keys.items():
                if status in ("active", "pending"):
                    state.keys[key] = "SUPERSEDED"
            return self._send(200, state.deliver(body, state.access(agentKey=state.issue_key("active"), keyStatus="active")))

        status = state.keys.get(body.get("agentKey"))
        if not status or status == "SUPERSEDED":
            return self._send(401, {"error": "Invalid credentials"})
        if status in REVOKED_CODES:
            code, message = REVOKED_CODES[status]
            return self._send(401, {"error": message, "code": code})

        if body.get("rotate"):
            if status != "active":
                return self._send(409, {"error": "Only an active key can be rotated", "code": "KEY_NOT_ACTIVE"})
            for key, value in state.keys.items():
                if value == "pending":
                    state.keys[key] = "SUPERSEDED"
            next_key = state.issue_key("pending")
            state.revoke_on_commit = bool(body.get("revokeTokens"))
            return self._send(200, state.deliver(body, state.access(agentKey=next_key, keyStatus="pending")))

        if status == "pending":
            for key, value in state.keys.items():
                if value == "active":
                    state.keys[key] = "ROTATED"
            state.keys[body["agentKey"]] = "active"
            if state.revoke_on_commit:
                state.token_version += 1
        return self._send(200, state.access())

    def do_POST(self):
        state = MockHandler.state
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length).decode("utf-8")) if length else {}
        is_dry_run = self.headers.get("X-Dry-Run") == "true"
        if is_dry_run:
            state.dry_run_paths.append(self.path)

        if self.path == "/auth/token":
            return self._handle_token(body, is_dry_run)

        if self.path == "/agent/keys/migrate":
            state.migrate_calls += 1
            if is_dry_run:
                return self._send(200, self.DRY_RUN_BODY)
            if state.password is None or body.get("password") != state.password:
                return self._send(401, {"error": "Invalid accountId or password"})
            state.password = None
            return self._send(200, {
                "accountId": body["accountId"],
                "agentKey": state.issue_key("active"),
                "recoveryKeyId": state.recovery_key_id,
            })

        if self.path == "/auth/register":
            state.register_requests.append(body)
            if state.delivery_errors:
                return self._send_delivery_error()
            if is_dry_run:
                return self._send_dry_run(body)
            if "password" in body:
                return self._send(400, {"error": "AI accounts no longer use passwords.", "code": "AGENT_KEY_REQUIRED"})
            return self._send(201, state.deliver(body, {
                "message": "Account created successfully",
                "accountId": body["accountId"],
                "agentKey": state.issue_key("active"),
                "token": f"jwt_v{state.token_version}_register",
                "recoveryKey": "alv_rk_registered",
                "recoveryKeyId": state.recovery_key_id,
                **state.register_extra,
            }))

        return self._send(404, {"error": "Not found"})

    def do_GET(self):
        state = MockHandler.state
        authorization = self.headers.get("Authorization", "")
        state.api_authorizations.append(authorization)
        if state.next_api_error:
            status, code = state.next_api_error
            state.next_api_error = None
            return self._send(status, {"error": "Rejected", "code": code})
        if "alv_sk_" in authorization:
            return self._send(401, {"error": "Send keys only to /auth/token", "code": "AGENT_KEY_NOT_ALLOWED"})
        if not authorization.startswith(f"Bearer jwt_v{state.token_version}_"):
            return self._send(401, {"error": "Unauthorized"})

        if self.path == "/agent/keys":
            return self._send(200, {"keys": [
                {
                    "prefix": key[:15],
                    "status": status,
                    "createdAt": "2026-11-01T00:00:00.000Z",
                    "lastUsedAt": None,
                    "lastUsedIp": None,
                }
                for key, status in state.keys.items() if status in ("active", "pending")
            ]})
        if self.path == "/users/profile":
            return self._send(200, {"username": ACCOUNT_ID})
        return self._send(404, {"error": "Not found"})

    def log_message(self, format, *args):
        pass  # Keep test output quiet


class FakeKeyring:
    def __init__(self):
        self.entries = {}
        self.fail_writes = False

    def get(self, account):
        return self.entries.get(account)

    def set(self, account, secret):
        if self.fail_writes:
            return False
        self.entries[account] = secret
        return True

    def delete(self, account):
        self.entries.pop(account, None)


class MockSolver:
    def fetch_challenge(self):
        return ChallengeData(
            id="c1",
            puzzle_type="LOG_FILTERING",
            prompt="p",
            expires_at=int(time.time() * 1000) + 30000,
        )

    def solve(self, challenge, context=None):
        return {"matchCount": 1, "totalBytes": 1, "targetIds": []}

    def get_reflection_knowledge(self):
        return []


class AgentKeyTestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = HTTPServer(("127.0.0.1", 0), MockHandler)
        cls.api_url = f"http://127.0.0.1:{cls.server.server_port}"
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def setUp(self):
        MockHandler.state = State()
        self.state = MockHandler.state
        self.tmp_dir = tempfile.mkdtemp(prefix="allevitas-agent-key-")
        self.addCleanup(shutil.rmtree, self.tmp_dir, ignore_errors=True)
        self.cred_path = os.path.join(self.tmp_dir, "credentials.json")
        self.recovery_path = os.path.join(self.tmp_dir, "key_bot.recovery-key.json")

        env_patch = mock.patch.dict(os.environ)
        env_patch.start()
        self.addCleanup(env_patch.stop)
        for key in ENV_KEYS:
            os.environ.pop(key, None)

        self.stderr = io.StringIO()
        stderr_patch = contextlib.redirect_stderr(self.stderr)
        stderr_patch.__enter__()
        self.addCleanup(stderr_patch.__exit__, None, None, None)

    def client(self, **options):
        defaults = {
            "api_url": self.api_url,
            "credentials_path": self.cred_path,
            "keyring": False,
            "max_retries": 0,
        }
        return AllevitasClient(**{**defaults, **options})

    def read_credentials(self):
        with open(self.cred_path, "r", encoding="utf-8") as f:
            return json.load(f)

    def write_credentials(self, data):
        fd = os.open(self.cred_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f)

    def seed_store(self, **extra):
        self.state.keys[STORED_KEY] = "active"
        self.write_credentials({"accountId": ACCOUNT_ID, "agentKey": STORED_KEY, "keyCreatedAt": int(time.time()), **extra})

    def seed_legacy(self, **extra):
        self.state.password = "OldPass123"
        self.write_credentials({
            "accountId": ACCOUNT_ID,
            "password": "OldPass123",
            "token": "old_jwt",
            "tokenExpiresAt": int(time.time()) + 3600,
            **extra,
        })

    def seed_recovery(self, account_id=ACCOUNT_ID, recovery_key_id="currentrkid0", path=None, key="alv_rk_value", fmt="alv_rk"):
        with open(path or self.recovery_path, "w", encoding="utf-8") as f:
            json.dump({
                "accountId": account_id,
                "recoveryKey": key,
                "recoveryKeyId": recovery_key_id,
                "format": fmt,
                "createdAt": "2026-11-01",
            }, f)

    def registering_client(self, **options):
        client = self.client(**options)
        client.auth.challenge_solver = MockSolver()
        return client

    def rotations(self):
        return [r for r in self.state.token_requests if r.get("rotate")]


class TestTokenExchange(AgentKeyTestCase):
    def test_exchanges_stored_key_and_sends_only_the_token_to_the_api(self):
        self.seed_store()
        self.client().get_profile()
        self.assertEqual(self.state.token_requests, [{"agentKey": STORED_KEY}])
        self.assertEqual(len(self.state.api_authorizations), 1)
        self.assertRegex(self.state.api_authorizations[0], r"^Bearer jwt_v0_")

    def test_reuses_fresh_token_and_refreshes_near_expiry(self):
        self.seed_store()
        client = self.client()
        first = client.auth.get_valid_token()
        self.assertEqual(client.auth.get_valid_token(), first)
        self.assertEqual(len(self.state.token_requests), 1)

        client.auth.token_expires_at = int(time.time()) + 30
        self.assertNotEqual(client.auth.get_valid_token(), first)
        self.assertEqual(len(self.state.token_requests), 2)

    def test_shares_one_exchange_between_threads(self):
        self.seed_store()
        client = self.client()
        threads = [threading.Thread(target=client.get_profile) for _ in range(3)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(len(self.state.token_requests), 1)

    def test_exchanges_again_after_plain_401(self):
        self.seed_store()
        client = self.client()
        client.auth.get_valid_token()
        self.state.next_api_error = (401, None)

        client.get_profile()

        self.assertEqual(len(self.state.token_requests), 2)
        self.assertEqual(len(self.state.api_authorizations), 2)

    def test_injected_token_is_kept_until_rejected(self):
        self.seed_store()
        client = self.client(token="jwt_v0_injected")
        client.get_profile()
        self.assertEqual(len(self.state.token_requests), 0)

        self.state.token_version = 1
        client.get_profile()
        self.assertEqual(len(self.state.token_requests), 1)

    def test_env_key_is_never_written_to_disk(self):
        self.state.keys["alv_sk_fromenv"] = "active"
        os.environ["ALLEVITAS_AGENT_KEY"] = "alv_sk_fromenv"
        client = self.client()

        client.get_profile()

        self.assertEqual(client.auth.current_account_id, ACCOUNT_ID)
        self.assertFalse(os.path.exists(self.cred_path))

    def test_env_key_does_not_overwrite_another_accounts_store(self):
        self.state.keys["alv_sk_fromenv"] = "active"
        self.write_credentials({"accountId": "other_bot", "agentKey": "alv_sk_otherbot"})
        os.environ["ALLEVITAS_AGENT_KEY"] = "alv_sk_fromenv"

        self.client().get_profile()

        self.assertEqual(self.read_credentials()["agentKey"], "alv_sk_otherbot")

    def test_imported_key_is_saved_and_managed_from_the_store(self):
        self.state.keys["alv_sk_imported"] = "active"
        self.client(agent_key="alv_sk_imported", import_agent_key=True).get_profile()

        self.assertEqual(self.read_credentials()["agentKey"], "alv_sk_imported")
        self.assertEqual(self.client().auth.get_status().key_source, "store")

    def test_revoked_key_is_not_retried(self):
        self.state.keys[STORED_KEY] = "ROTATED"
        self.write_credentials({"accountId": ACCOUNT_ID, "agentKey": STORED_KEY})
        client = self.client()

        with self.assertRaises(AllevitasAuthError) as ctx:
            client.get_profile()
        self.assertEqual(ctx.exception.code, "KEY_ROTATED")
        self.assertIn("may have leaked", str(ctx.exception))
        self.assertIn("/recover/agent", str(ctx.exception))

        with self.assertRaises(AllevitasAuthError):
            client.get_profile()
        self.assertEqual(len(self.state.token_requests), 1)

    def test_recovery_revocation_is_reported(self):
        self.state.keys[STORED_KEY] = "RECOVERY"
        self.write_credentials({"accountId": ACCOUNT_ID, "agentKey": STORED_KEY})
        with self.assertRaises(AllevitasAuthError) as ctx:
            self.client().get_profile()
        self.assertEqual(ctx.exception.code, "KEY_REVOKED_BY_RECOVERY")
        self.assertIn("recovery key may have leaked", str(ctx.exception))

    def test_follows_rotation_saved_by_another_process(self):
        self.seed_store()
        client = self.client()
        client.auth.get_valid_token()

        self.state.keys[STORED_KEY] = "ROTATED"
        self.state.keys["alv_sk_newer"] = "active"
        self.write_credentials({"accountId": ACCOUNT_ID, "agentKey": "alv_sk_newer", "keyCreatedAt": int(time.time())})

        client.auth.current_token = None
        client.get_profile()

        self.assertEqual(self.read_credentials()["agentKey"], "alv_sk_newer")

    def test_token_refresh_does_not_undo_another_process_rotation(self):
        self.seed_store()
        client = self.client()
        client.auth.get_valid_token()

        self.write_credentials({"accountId": ACCOUNT_ID, "agentKey": "alv_sk_newer", "keyCreatedAt": int(time.time())})
        client.auth.save_credentials()

        self.assertEqual(self.read_credentials()["agentKey"], "alv_sk_newer")


class TestRotation(AgentKeyTestCase):
    def test_rotate_saves_k2_then_commits(self):
        self.seed_store()
        result = self.client().rotate()

        self.assertTrue(result.committed)
        saved = self.read_credentials()
        k2 = saved["agentKey"]
        self.assertNotEqual(k2, STORED_KEY)
        self.assertNotIn("pendingAgentKey", saved)
        self.assertEqual(self.state.keys[STORED_KEY], "ROTATED")
        self.assertEqual(self.state.keys[k2], "active")
        self.assertEqual(self.state.token_version, 0)
        self.assertEqual(self.state.token_requests[0], {"agentKey": STORED_KEY, "rotate": True})
        self.assertEqual(self.state.token_requests[1], {"agentKey": k2})

    def test_failed_commit_keeps_k1_and_retries_later(self):
        self.seed_store()
        client = self.client()
        real_post = client.auth._post_token
        calls = []

        def flaky(body, **kwargs):
            calls.append(body)
            if len(calls) == 2:
                raise RuntimeError("connection reset")
            return real_post(body, **kwargs)

        client.auth._post_token = flaky

        result = client.rotate()

        self.assertTrue(result.rotated)
        self.assertFalse(result.committed)
        saved = self.read_credentials()
        self.assertEqual(saved["agentKey"], STORED_KEY)
        self.assertIn("pendingAgentKey", saved)
        self.assertEqual(self.state.keys[STORED_KEY], "active")

        self.client().get_profile()
        self.assertEqual(self.read_credentials()["agentKey"], saved["pendingAgentKey"])
        self.assertEqual(self.state.keys[STORED_KEY], "ROTATED")

    def test_commits_pending_key_after_lost_response(self):
        self.seed_store(pendingAgentKey="alv_sk_pending")
        self.state.keys[STORED_KEY] = "ROTATED"
        self.state.keys["alv_sk_pending"] = "active"

        self.client().get_profile()

        saved = self.read_credentials()
        self.assertEqual(saved["agentKey"], "alv_sk_pending")
        self.assertNotIn("pendingAgentKey", saved)

    def test_drops_superseded_pending_key(self):
        self.seed_store(pendingAgentKey="alv_sk_superseded")
        self.state.keys["alv_sk_superseded"] = "SUPERSEDED"

        self.client().get_profile()

        saved = self.read_credentials()
        self.assertEqual(saved["agentKey"], STORED_KEY)
        self.assertNotIn("pendingAgentKey", saved)

    def test_discards_k2_when_it_cannot_be_saved(self):
        self.seed_store()
        client = self.client()

        def fail(*args):
            raise OSError("disk full")

        client.auth._persist = fail
        with self.assertRaisesRegex(OSError, "disk full"):
            client.rotate()

        self.assertEqual(self.read_credentials()["agentKey"], STORED_KEY)
        self.assertEqual(self.state.keys[STORED_KEY], "active")
        self.assertIsNone(client.auth._pending_agent_key)

    def test_rotate_now_revokes_tokens(self):
        self.seed_store()
        client = self.client()
        old_token = client.auth.get_valid_token()

        client.rotate_now()

        self.assertTrue(self.rotations()[0]["revokeTokens"])
        self.assertEqual(self.state.token_version, 1)
        self.assertNotEqual(client.auth.get_valid_token(), old_token)
        client.get_profile()

    def test_rotates_automatically_after_30_days(self):
        self.seed_store(keyCreatedAt=int(time.time()) - THIRTY_ONE_DAYS_SEC)
        self.client().get_profile()
        self.assertNotEqual(self.read_credentials()["agentKey"], STORED_KEY)

    def test_does_not_rotate_a_younger_key(self):
        self.seed_store()
        self.client().get_profile()
        self.assertEqual(self.read_credentials()["agentKey"], STORED_KEY)

    def test_auto_rotation_opt_outs(self):
        for options, env in [
            ({"auto_rotate": False}, {}),
            ({}, {"ALLEVITAS_AUTO_ROTATE": "false"}),
            ({"save_credentials": False}, {}),
            ({"dry_run": True}, {}),
        ]:
            with self.subTest(options=options, env=env), mock.patch.dict(os.environ, env):
                self.seed_store(keyCreatedAt=int(time.time()) - THIRTY_ONE_DAYS_SEC)
                self.client(**options).auth.get_valid_token()
                self.assertEqual(self.rotations(), [])

    def test_env_key_is_not_auto_rotated(self):
        self.state.keys["alv_sk_fromenv"] = "active"
        os.environ["ALLEVITAS_AGENT_KEY"] = "alv_sk_fromenv"
        client = self.client()
        client.auth._key_created_at = int(time.time()) - THIRTY_ONE_DAYS_SEC
        client.auth.get_valid_token()
        self.assertEqual(self.rotations(), [])

    def test_manual_rotation_refused_when_new_key_could_not_be_kept(self):
        self.state.keys["alv_sk_fromenv"] = "active"
        os.environ["ALLEVITAS_AGENT_KEY"] = "alv_sk_fromenv"
        with self.assertRaises(AllevitasAuthError) as ctx:
            self.client().rotate()
        self.assertEqual(ctx.exception.code, "KEY_NOT_ROTATABLE")
        self.assertEqual(self.state.token_requests, [])

    def test_failed_auto_rotation_does_not_fail_the_request(self):
        self.seed_store(keyCreatedAt=int(time.time()) - THIRTY_ONE_DAYS_SEC)
        open(f"{self.cred_path}.lock", "w").close()

        self.client().get_profile()

        self.assertIn("Automatic key rotation failed", self.stderr.getvalue())
        self.assertEqual(self.read_credentials()["agentKey"], STORED_KEY)

    def test_dry_run_rotation_changes_nothing(self):
        self.seed_store()
        res = self.client(dry_run=True).rotate()
        self.assertFalse(res.rotated)
        self.assertTrue(res.dry_run)
        self.assertEqual(self.read_credentials()["agentKey"], STORED_KEY)
        self.assertEqual(self.state.dry_run_paths, ["/auth/token"])


class TestMigration(AgentKeyTestCase):
    def test_migrates_on_first_token_request_even_with_unexpired_token(self):
        self.seed_legacy()
        self.client().get_profile()

        self.assertEqual(self.state.migrate_calls, 1)
        saved = self.read_credentials()
        self.assertNotIn("password", saved)
        self.assertRegex(saved["agentKey"], r"^alv_sk_")
        self.assertNotEqual(saved["token"], "old_jwt")
        self.assertRegex(self.state.api_authorizations[0], r"^Bearer jwt_v0_")

    def test_moves_legacy_recovery_key_to_its_own_file(self):
        self.seed_legacy(recoveryKey="RC-00000000aaaaaaaa")
        self.client().get_profile()

        self.assertNotIn("recoveryKey", self.read_credentials())
        with open(self.recovery_path, "r", encoding="utf-8") as f:
            file = json.load(f)
        self.assertEqual(file["recoveryKey"], "RC-00000000aaaaaaaa")
        self.assertEqual(file["recoveryKeyId"], "currentrkid0")
        self.assertEqual(file["format"], "legacy_rc")
        self.assertEqual(file["accountId"], ACCOUNT_ID)
        self.assertNotIn("RC-00000000aaaaaaaa", self.stderr.getvalue())
        self.assertIn("recovery-key export", self.stderr.getvalue())

    def test_migrates_when_injected_token_gets_agent_key_required(self):
        self.seed_legacy()
        client = self.client(token="jwt_v0_old")
        self.state.next_api_error = (401, "AGENT_KEY_REQUIRED")

        client.get_profile()

        self.assertEqual(self.state.migrate_calls, 1)

    def test_agent_key_required_without_password_explains_the_way_forward(self):
        client = self.client(token="jwt_v0_old")
        self.state.next_api_error = (401, "AGENT_KEY_REQUIRED")

        with self.assertRaises(AllevitasAuthError) as ctx:
            client.get_profile()
        self.assertEqual(ctx.exception.code, "AGENT_KEY_REQUIRED")
        self.assertIn("allevitas migrate", str(ctx.exception))

    def test_refuses_to_migrate_where_key_could_not_be_saved(self):
        self.seed_legacy()
        with self.assertRaises(AllevitasAuthError) as ctx:
            self.client(save_credentials=False).get_profile()
        self.assertEqual(ctx.exception.code, "CREDENTIALS_NOT_PERSISTABLE")
        self.assertEqual(self.state.migrate_calls, 0)
        self.assertEqual(self.state.password, "OldPass123")

    def test_does_not_migrate_in_dry_run(self):
        self.seed_legacy()
        with self.assertRaises(AllevitasAuthError) as ctx:
            self.client(dry_run=True).auth.get_valid_token()
        self.assertEqual(ctx.exception.code, "MIGRATION_REQUIRED")
        self.assertEqual(self.state.migrate_calls, 0)
        self.assertEqual(self.read_credentials()["password"], "OldPass123")

    def test_uses_key_saved_by_another_process(self):
        self.seed_legacy()
        client = self.client()
        self.state.password = None
        self.state.keys["alv_sk_first"] = "active"
        self.write_credentials({"accountId": ACCOUNT_ID, "agentKey": "alv_sk_first", "keyCreatedAt": int(time.time())})

        client.get_profile()

        self.assertEqual(self.state.migrate_calls, 0)
        self.assertEqual(self.read_credentials()["agentKey"], "alv_sk_first")

    def test_rejected_migration_is_explained(self):
        self.seed_legacy(password="WrongPass")
        with self.assertRaises(AllevitasAuthError) as ctx:
            self.client().get_profile()
        self.assertEqual(ctx.exception.code, "MIGRATION_FAILED")
        self.assertEqual(self.read_credentials()["password"], "WrongPass")

    def test_explicit_password_without_a_file(self):
        self.state.password = "OldPass123"
        res = self.client().migrate(ACCOUNT_ID, "OldPass123")
        self.assertTrue(res.migrated)
        self.assertRegex(self.read_credentials()["agentKey"], r"^alv_sk_")

    def test_keeps_legacy_key_when_target_belongs_to_another_account(self):
        other = os.path.join(self.tmp_dir, "shared.json")
        self.seed_recovery(account_id="other_bot", recovery_key_id="x", path=other)
        os.environ["ALLEVITAS_RECOVERY_KEY_FILE"] = other
        self.seed_legacy(recoveryKey="RC-00000000aaaaaaaa")

        self.client().get_profile()

        self.assertEqual(self.read_credentials()["recoveryKey"], "RC-00000000aaaaaaaa")
        with open(other, "r", encoding="utf-8") as f:
            self.assertEqual(json.load(f)["accountId"], "other_bot")


class TestRegistration(AgentKeyTestCase):
    def test_saves_key_and_writes_recovery_key_to_separate_file(self):
        res = self.registering_client().register(ACCOUNT_ID)

        text = repr(res)
        self.assertNotIn("alv_sk_", text)
        self.assertNotIn("alv_rk_", text)
        self.assertEqual(res.recovery_key_file, self.recovery_path)
        self.assertEqual(res.recovery_key_id, "currentrkid0")

        saved = self.read_credentials()
        self.assertRegex(saved["agentKey"], r"^alv_sk_")
        self.assertNotIn("recoveryKey", saved)

        with open(self.recovery_path, "r", encoding="utf-8") as f:
            file = json.load(f)
        file.pop("createdAt")
        self.assertEqual(file, {
            "accountId": ACCOUNT_ID,
            "recoveryKey": "alv_rk_registered",
            "recoveryKeyId": "currentrkid0",
            "format": "alv_rk",
        })
        if sys.platform != "win32":
            self.assertEqual(stat.S_IMODE(os.stat(self.recovery_path).st_mode), 0o600)
            self.assertEqual(stat.S_IMODE(os.stat(self.cred_path).st_mode), 0o600)

    def test_honors_recovery_key_file_env(self):
        target = os.path.join(self.tmp_dir, "custom", "rk.json")
        os.environ["ALLEVITAS_RECOVERY_KEY_FILE"] = target
        self.registering_client().register(ACCOUNT_ID)
        self.assertTrue(os.path.exists(target))
        self.assertFalse(os.path.exists(self.recovery_path))

    def test_refuses_stateless_without_explicit_file(self):
        with self.assertRaises(AllevitasAuthError) as ctx:
            self.registering_client(save_credentials=False).register(ACCOUNT_ID)
        self.assertEqual(ctx.exception.code, "CREDENTIALS_NOT_PERSISTABLE")
        self.assertEqual(self.state.keys, {})

    def test_dry_run_writes_nothing(self):
        client = self.registering_client(save_credentials=False)
        res = client.register(ACCOUNT_ID, dry_run=True)
        self.assertTrue(res.dry_run)
        self.assertFalse(os.path.exists(self.recovery_path))
        self.assertFalse(client.auth.get_status().has_agent_key)

    def test_warns_that_key_is_lost_when_stateless_with_recovery_file(self):
        target = os.path.join(self.tmp_dir, "rk.json")
        os.environ["ALLEVITAS_RECOVERY_KEY_FILE"] = target
        self.registering_client(save_credentials=False).register(ACCOUNT_ID)
        self.assertIn("will be lost", self.stderr.getvalue())
        self.assertTrue(os.path.exists(target))

    def test_refuses_to_overwrite_another_accounts_credentials(self):
        self.write_credentials({"accountId": "other_bot", "agentKey": "alv_sk_otherbot"})
        with self.assertRaises(AllevitasAuthError) as ctx:
            self.registering_client(account_id=ACCOUNT_ID).register(ACCOUNT_ID)
        self.assertEqual(ctx.exception.code, "CREDENTIALS_FILE_IN_USE")
        self.assertEqual(self.read_credentials()["agentKey"], "alv_sk_otherbot")

    def test_refuses_to_overwrite_undelivered_recovery_key(self):
        self.seed_recovery(recovery_key_id="x", key="alv_rk_old")
        with self.assertRaises(AllevitasAuthError) as ctx:
            self.registering_client().register(ACCOUNT_ID)
        self.assertEqual(ctx.exception.code, "RECOVERY_KEY_PENDING")


class TestRecoveryKeyFile(AgentKeyTestCase):
    def test_notifies_on_startup_without_the_value(self):
        self.seed_store()
        self.seed_recovery()
        self.client()
        self.assertIn("undelivered recovery key", self.stderr.getvalue())
        self.assertIn("recovery-key export", self.stderr.getvalue())
        self.assertNotIn("alv_rk_value", self.stderr.getvalue())

    def test_quiet_without_a_file(self):
        self.seed_store()
        self.client()
        self.assertEqual(self.stderr.getvalue(), "")

    def test_keeps_file_with_matching_id(self):
        self.seed_store()
        self.seed_recovery()
        self.client().auth.get_valid_token()
        self.assertTrue(os.path.exists(self.recovery_path))

    def test_silently_deletes_stale_file(self):
        self.seed_store()
        self.seed_recovery(recovery_key_id="renewedalrdy")
        self.client(recovery_key_notice=False).auth.get_valid_token()
        self.assertFalse(os.path.exists(self.recovery_path))
        self.assertEqual(self.stderr.getvalue(), "")

    def test_keeps_file_without_recorded_id(self):
        self.seed_store()
        self.seed_recovery(recovery_key_id="")
        self.client().auth.get_valid_token()
        self.assertTrue(os.path.exists(self.recovery_path))

    def test_warns_and_keeps_file_of_another_account(self):
        self.seed_store()
        other = os.path.join(self.tmp_dir, "other.json")
        self.seed_recovery(account_id="other_bot", recovery_key_id="renewedalrdy", path=other)
        os.environ["ALLEVITAS_RECOVERY_KEY_FILE"] = other

        self.client().auth.get_valid_token()

        self.assertTrue(os.path.exists(other))
        self.assertIn("belongs to account other_bot", self.stderr.getvalue())


class TestClaim(AgentKeyTestCase):
    def test_saves_key_returns_no_key_and_clears_failure(self):
        self.state.keys[STORED_KEY] = "RECOVERY"
        self.write_credentials({
            "accountId": ACCOUNT_ID,
            "agentKey": STORED_KEY,
            "password": "old",
            "recoveryKey": "RC-00000000aaaaaaaa",
        })
        self.state.claim_codes["alv_cc_good"] = "unused"
        client = self.client()
        with self.assertRaises(AllevitasAuthError):
            client.auth.get_valid_token()

        res = client.claim("alv_cc_good")

        saved = self.read_credentials()
        self.assertNotIn(saved["agentKey"], repr(res))
        self.assertEqual(res.account_id, ACCOUNT_ID)
        self.assertNotIn("password", saved)
        self.assertNotIn("recoveryKey", saved)
        client.get_profile()

    def test_used_code_is_reported_as_possibly_stolen(self):
        self.state.claim_codes["alv_cc_used"] = "used"
        with self.assertRaises(AllevitasAuthError) as ctx:
            self.client().claim("alv_cc_used")
        self.assertEqual(ctx.exception.code, "CLAIM_CODE_USED")
        self.assertIn("stolen", str(ctx.exception))
        self.assertIn("recovery again", str(ctx.exception))

    def test_expired_code_asks_for_another_recovery(self):
        self.state.claim_codes["alv_cc_old"] = "expired"
        with self.assertRaises(AllevitasAuthError) as ctx:
            self.client().claim("alv_cc_old")
        self.assertEqual(ctx.exception.code, "CLAIM_CODE_EXPIRED")
        self.assertNotIn("stolen", str(ctx.exception))

    def test_claim_is_not_retried_after_a_lost_response(self):
        self.state.claim_codes["alv_cc_good"] = "unused"
        self.state.fail_token_requests = 1
        client = self.client(max_retries=3, base_delay_sec=0.01)
        with self.assertRaisesRegex(RuntimeError, "503"):
            client.claim("alv_cc_good")
        self.assertEqual(len(self.state.token_requests), 1)

    def test_rejects_non_codes_before_sending(self):
        with self.assertRaisesRegex(AllevitasAuthError, "starts with alv_cc_"):
            self.client().claim("alv_sk_notacode")
        self.assertEqual(self.state.token_requests, [])

    def test_refuses_without_saving_before_consuming_the_code(self):
        self.state.claim_codes["alv_cc_good"] = "unused"
        with self.assertRaises(AllevitasAuthError) as ctx:
            self.client(save_credentials=False).claim("alv_cc_good")
        self.assertEqual(ctx.exception.code, "CREDENTIALS_NOT_PERSISTABLE")
        self.assertEqual(self.state.claim_codes["alv_cc_good"], "unused")

    def test_replaces_environment_key_with_saved_one(self):
        self.state.claim_codes["alv_cc_good"] = "unused"
        os.environ["ALLEVITAS_AGENT_KEY"] = "alv_sk_revoked"
        client = self.client()

        client.claim("alv_cc_good")

        self.assertIn("Remove the old ALLEVITAS_AGENT_KEY", self.stderr.getvalue())
        self.assertEqual(client.auth.get_status().key_source, "store")
        self.assertRegex(self.read_credentials()["agentKey"], r"^alv_sk_issued")


class TestAgentKeyList(AgentKeyTestCase):
    def test_lists_prefixes_with_the_access_token(self):
        self.seed_store()
        keys = self.client().list_agent_keys()
        self.assertEqual(keys[0]["prefix"], STORED_KEY[:15])
        self.assertRegex(self.state.api_authorizations[0], r"^Bearer jwt_v0_")


class TestSecretProtection(AgentKeyTestCase):
    def test_masks_every_key_format(self):
        masked = mask_secrets("a alv_sk_abc123 b alv_rk_abc123 c alv_cc_abc123 d RC-00000000aaaaaaaa e rc-00000000AAAAAAAA f")
        self.assertEqual(masked, "a [FILTERED] b [FILTERED] c [FILTERED] d [FILTERED] e [FILTERED] f")

    def test_leaves_ordinary_text_alone(self):
        self.assertEqual(mask_secrets("ARC-1 RC-12 rate limit"), "ARC-1 RC-12 rate limit")

    def test_masks_keys_echoed_in_api_errors(self):
        err = AllevitasApiError(400, "Bad Request", '{"error":"bad alv_sk_leaked1","code":"X"}')
        self.assertNotIn("alv_sk_leaked1", str(err))
        self.assertEqual(err.code, "X")

    def test_rate_limit_handler_raises_api_error(self):
        self.state.next_api_error = (403, "SOME_CODE")
        with self.assertRaises(AllevitasApiError) as ctx:
            RateLimitHandler(max_retries=0).request(f"{self.api_url}/users/profile")
        self.assertEqual(ctx.exception.status, 403)
        self.assertEqual(ctx.exception.code, "SOME_CODE")

    def test_repr_exposes_no_secret(self):
        self.seed_store(recoveryKey="RC-00000000aaaaaaaa")
        client = self.client()
        client.auth.get_valid_token()
        text = repr(client.auth) + repr(client.auth.get_status())
        self.assertNotIn(STORED_KEY, text)
        self.assertNotIn("RC-00000000aaaaaaaa", text)

    def test_load_credentials_returns_no_secret(self):
        self.seed_store(token="secret-token", password="pw")
        text = repr(self.client().auth.load_credentials())
        self.assertNotIn(STORED_KEY, text)
        self.assertNotIn("secret-token", text)
        self.assertIn(STORED_KEY[:15], text)


class TestKeyring(AgentKeyTestCase):
    def test_keeps_keys_in_keyring_and_a_marker_in_the_file(self):
        self.seed_store()
        keyring = FakeKeyring()
        self.client(keyring=keyring).rotate()

        with open(self.cred_path, "r", encoding="utf-8") as f:
            raw = f.read()
        self.assertNotIn("alv_sk_", raw)
        self.assertEqual(json.loads(raw)["keyStorage"], "keyring")
        self.assertEqual(list(keyring.entries), [f"127.0.0.1:{self.server.server_port}/{ACCOUNT_ID}"])

        self.client(keyring=keyring).get_profile()
        self.assertEqual(self.state.keys[next(iter(keyring.entries.values()))], "active")

    def test_falls_back_to_file_when_keyring_rejects_a_write(self):
        self.seed_store()
        keyring = FakeKeyring()
        keyring.fail_writes = True
        self.client(keyring=keyring).rotate()
        self.assertRegex(self.read_credentials()["agentKey"], r"^alv_sk_")

    def test_falls_back_when_keyring_returns_something_else(self):
        keyring = FakeKeyring()
        keyring.get = lambda account: "something else"
        self.assertFalse(store_in_keyring(keyring, "a", "alv_sk_x"))

    def test_does_not_overwrite_store_when_keyring_is_locked(self):
        self.write_credentials({"accountId": ACCOUNT_ID, "keyStorage": "keyring", "token": "t", "tokenExpiresAt": 1})
        with open(self.cred_path, "r", encoding="utf-8") as f:
            before = f.read()
        client = self.client(keyring=FakeKeyring())

        with self.assertRaises(AllevitasAuthError) as ctx:
            client.auth.get_valid_token()
        self.assertEqual(ctx.exception.code, "KEYRING_UNAVAILABLE")
        client.auth.save_credentials()

        with open(self.cred_path, "r", encoding="utf-8") as f:
            self.assertEqual(f.read(), before)

    def test_passes_secrets_over_stdin_only(self):
        for platform in ("darwin", "linux", "win32"):
            calls = []

            def run(args, input_text=None, env=None):
                calls.append((args, input_text))
                return 0, ""

            backend = create_keyring_backend(platform, run)
            self.assertTrue(backend.set("host/bot", "alv_sk_commandline"))
            self.assertIn("alv_sk_commandline", calls[0][1], platform)
            self.assertNotIn("alv_sk_commandline", " ".join(calls[0][0]), platform)

    def test_no_backend_on_unsupported_os(self):
        self.assertIsNone(create_keyring_backend("aix"))

    def test_reads_back_trimmed_values_and_treats_failures_as_missing(self):
        backend = create_keyring_backend("linux", lambda args, input_text=None, env=None: (0, "alv_sk_x\n"))
        self.assertEqual(backend.get("a"), "alv_sk_x")
        failing = create_keyring_backend("linux", lambda args, input_text=None, env=None: (1, ""))
        self.assertIsNone(failing.get("a"))
        self.assertFalse(failing.set("a", "b"))

    def test_rejects_values_unsafe_for_the_command_channel(self):
        self.assertFalse(store_in_keyring(FakeKeyring(), "a", 'x" -w "y'))


class TestCredentialFiles(AgentKeyTestCase):
    @unittest.skipIf(sys.platform == "win32", "POSIX permissions")
    def test_tightens_a_readable_file(self):
        self.seed_store()
        os.chmod(self.cred_path, 0o644)
        self.client()
        self.assertEqual(stat.S_IMODE(os.stat(self.cred_path).st_mode), 0o600)
        self.assertIn("permissions were changed to 0600", self.stderr.getvalue())

    def test_writes_atomically_and_leaves_no_temporary_file(self):
        write_file_atomic(self.cred_path, "first")
        write_file_atomic(self.cred_path, "second")
        with open(self.cred_path, "r", encoding="utf-8") as f:
            self.assertEqual(f.read(), "second")
        self.assertEqual(os.listdir(self.tmp_dir), ["credentials.json"])

    def test_cleans_up_when_the_rename_fails(self):
        os.mkdir(self.cred_path)
        with self.assertRaises(OSError):
            write_file_atomic(self.cred_path, "new")
        self.assertEqual(os.listdir(self.tmp_dir), ["credentials.json"])

    def test_lock_gives_up_and_takes_over_stale(self):
        lock_path = f"{self.cred_path}.lock"
        open(lock_path, "w").close()
        with file_lock(self.cred_path, wait_sec=0.0) as acquired:
            self.assertFalse(acquired)

        old = time.time() - 120
        os.utime(lock_path, (old, old))
        with file_lock(self.cred_path, wait_sec=0.0) as acquired:
            self.assertTrue(acquired)
        self.assertFalse(os.path.exists(lock_path))


class TestCli(AgentKeyTestCase):
    def run_cli(self, *args, input_text="", env=None):
        run_env = {**os.environ, "ALLEVITAS_KEYRING": "off", **{key: "" for key in ENV_KEYS}, **(env or {})}
        package_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        return subprocess.run(
            [sys.executable, "-m", "allevitas.cli", *args, "--api-url", self.api_url, "--credentials", self.cred_path],
            input=input_text,
            capture_output=True,
            text=True,
            encoding="utf-8",
            env=run_env,
            cwd=package_root,
            timeout=30,
        )

    def seed_cli_recovery(self, fmt="alv_rk", key="alv_rk_value"):
        self.seed_store()
        self.seed_recovery(key=key, fmt=fmt)

    def test_password_and_login_are_gone(self):
        with_flag = self.run_cli("post", "--password", "x")
        self.assertEqual(with_flag.returncode, 1)
        self.assertIn("--password is no longer supported", with_flag.stderr)

        login = self.run_cli("login")
        self.assertEqual(login.returncode, 1)
        self.assertIn("allevitas migrate", login.stderr)

    def test_agent_key_cannot_be_an_argument(self):
        for args in (("--agent-key", "alv_sk_argument"), ("--agent-key=alv_sk_argument",)):
            result = self.run_cli("whoami", *args)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Use ALLEVITAS_AGENT_KEY or --agent-key-stdin", result.stderr)
            self.assertNotIn("alv_sk_", result.stderr)

    def test_argument_parsing_errors_mask_secrets(self):
        result = self.run_cli("whoami", "--limit", "alv_sk_argument")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("--limit", result.stderr)
        self.assertNotIn("alv_sk_", result.stderr)

    def test_agent_key_stdin_saves_key_and_rejects_other_input(self):
        self.state.keys["alv_sk_pipedkeyvalue"] = "active"
        ok = self.run_cli("key", "list", "--agent-key-stdin", input_text="alv_sk_pipedkeyvalue\n")
        self.assertEqual(ok.returncode, 0, ok.stderr)
        self.assertEqual(self.read_credentials()["agentKey"], "alv_sk_pipedkeyvalue")
        self.assertNotIn("alv_sk_pipedkeyvalue", ok.stdout)

        bad = self.run_cli("whoami", "--agent-key-stdin", input_text="something else")
        self.assertEqual(bad.returncode, 1)

    def test_rotates_key_read_from_stdin_and_saves_the_new_key(self):
        self.state.keys["alv_sk_cikeyvalue001"] = "active"
        result = self.run_cli("key", "rotate", "--now", "--agent-key-stdin", input_text="alv_sk_cikeyvalue001\n")
        self.assertEqual(result.returncode, 0, result.stderr)
        saved = self.read_credentials()
        self.assertEqual(self.state.keys["alv_sk_cikeyvalue001"], "ROTATED")
        self.assertEqual(self.state.keys[saved["agentKey"]], "active")
        self.assertEqual(saved["accountId"], ACCOUNT_ID)

    def test_whoami_shows_no_secret(self):
        self.seed_cli_recovery()
        result = self.run_cli("whoami")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(STORED_KEY[:15] + "...", result.stdout)
        self.assertNotIn(STORED_KEY, result.stdout)
        self.assertNotIn("alv_rk_value", result.stdout)

    def test_migrate_reads_password_from_stdin(self):
        self.state.password = "OldPass123"
        result = self.run_cli("migrate", "--account-id", ACCOUNT_ID, "--password-stdin", input_text="OldPass123\n")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertRegex(self.read_credentials()["agentKey"], r"^alv_sk_")
        self.assertNotIn("alv_sk_", result.stdout)

    def test_migrate_reads_env_password(self):
        self.state.password = "OldPass123"
        result = self.run_cli("migrate", "--account-id", ACCOUNT_ID, env={"ALLEVITAS_PASSWORD": "OldPass123"})
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_key_rotate_now(self):
        self.seed_store()
        result = self.run_cli("key", "rotate", "--now")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.state.token_version, 1)
        self.assertNotIn(self.read_credentials()["agentKey"], result.stdout)

    def test_key_claim_reads_code_from_stdin(self):
        self.state.claim_codes["alv_cc_good"] = "unused"
        result = self.run_cli("key", "claim", input_text="alv_cc_good\n")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn(self.read_credentials()["agentKey"], result.stdout)

    def test_key_claim_used_code_exits_with_auth_code(self):
        self.state.claim_codes["alv_cc_used"] = "used"
        result = self.run_cli("key", "claim", input_text="alv_cc_used\n")
        self.assertEqual(result.returncode, 2)
        self.assertIn("stolen", result.stderr)
        self.assertNotIn("alv_cc_used", result.stderr)

    def test_export_refuses_without_terminal_or_flag(self):
        self.seed_cli_recovery()
        result = self.run_cli("recovery-key", "export")
        self.assertEqual(result.returncode, 1)
        self.assertIn("--non-interactive", result.stderr)
        self.assertNotIn("alv_rk_value", result.stdout)
        self.assertTrue(os.path.exists(self.recovery_path))

    def test_non_interactive_writes_exactly_the_value_and_keeps_the_file(self):
        self.seed_cli_recovery()
        result = self.run_cli("recovery-key", "export", "--non-interactive")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "alv_rk_value")
        self.assertTrue(os.path.exists(self.recovery_path))

    def test_non_interactive_delete_removes_the_file(self):
        self.seed_cli_recovery()
        result = self.run_cli("recovery-key", "export", "--non-interactive", "--delete")
        self.assertEqual(result.stdout, "alv_rk_value")
        self.assertFalse(os.path.exists(self.recovery_path))

    def test_legacy_key_notice_goes_to_stderr_only(self):
        self.seed_cli_recovery(fmt="legacy_rc", key="RC-00000000aaaaaaaa")
        result = self.run_cli("recovery-key", "export", "--non-interactive")
        self.assertEqual(result.stdout, "RC-00000000aaaaaaaa")
        self.assertIn("legacy recovery key", result.stderr)

    def test_delete_shows_no_value(self):
        self.seed_cli_recovery()
        result = self.run_cli("recovery-key", "delete")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(os.path.exists(self.recovery_path))
        self.assertNotIn("alv_rk_value", result.stdout + result.stderr)

    def test_reports_when_nothing_is_stored(self):
        self.seed_store()
        for action in ("export", "delete"):
            result = self.run_cli("recovery-key", action)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("No recovery key is stored", result.stderr)


PROVIDER_MODULE_SOURCE = """
import json


class _LoggingStore:
    name = "module-store"

    def __init__(self, config):
        self.config = config

    def store(self, secret, ttl_sec, kind):
        with open(self.config.options["log_path"], "a", encoding="utf-8") as f:
            f.write(json.dumps({"kind": kind, "ttl": ttl_sec, "options": sorted(self.config.options)}) + "\\n")
        return {"url": "https://vault.example/secrets/m1#modulekey", "expires_at": "2026-11-05T00:00:00Z"}


def create_provider(config):
    return _LoggingStore(config)
"""


class RecordingStore:
    name = "recording"

    def __init__(self, reachable=True, fail=False):
        self.reachable = reachable
        self.fail = fail
        self.checks = 0
        self.stored = []

    def check(self):
        self.checks += 1
        if not self.reachable:
            raise ConnectionError("store is down")
        return True

    def store(self, secret, ttl_sec, kind):
        if self.fail:
            raise RuntimeError("store rejected the write")
        self.stored.append((secret, ttl_sec, kind))
        n = len(self.stored)
        return {"url": f"https://vault.example/secrets/v{n}#vaultkey{n}", "expires_at": "2026-11-05T00:00:00Z"}


class SecretDeliveryTestCase(AgentKeyTestCase):
    def write_provider_module(self, name="allevitas_test_store"):
        path = os.path.join(self.tmp_dir, f"{name}.py")
        with open(path, "w", encoding="utf-8") as f:
            f.write(PROVIDER_MODULE_SOURCE)
        return path

    def read_provider_log(self):
        with open(os.path.join(self.tmp_dir, "store.log"), "r", encoding="utf-8") as f:
            return [json.loads(line) for line in f]


class TestRecoveryKeyHandover(SecretDeliveryTestCase):
    def test_server_link_replaces_the_recovery_key_file(self):
        self.state.register_extra = {
            "recoveryKeyUrl": "https://allevitas.com/secrets/r1#serverkey",
            "recoveryKeyUrlExpiresAt": "2026-11-04T00:00:00.000Z",
        }
        res = self.registering_client().register(ACCOUNT_ID)
        self.assertEqual(res.recovery_key_url, "https://allevitas.com/secrets/r1#serverkey")
        self.assertEqual(res.recovery_key_url_expires_at, "2026-11-04T00:00:00.000Z")
        self.assertIsNone(res.recovery_key_file)
        self.assertFalse(os.path.exists(self.recovery_path))
        self.assertRegex(self.read_credentials()["agentKey"], r"^alv_sk_")
        self.assertNotIn("secretDelivery", self.state.register_requests[0])

    def test_server_link_wins_over_the_secret_store(self):
        self.state.register_extra = {"recoveryKeyUrl": "https://allevitas.com/secrets/r1#serverkey"}
        store = RecordingStore()
        res = self.registering_client(secret_store=store).register(ACCOUNT_ID)
        self.assertEqual(res.recovery_key_url, "https://allevitas.com/secrets/r1#serverkey")
        self.assertEqual(store.stored, [])

    def test_secret_store_keeps_the_key_when_the_server_gives_no_link(self):
        store = RecordingStore()
        res = self.registering_client(secret_store=store).register(ACCOUNT_ID)
        self.assertEqual(store.checks, 1)
        self.assertEqual(store.stored, [("alv_rk_registered", 86400, "recovery_key")])
        self.assertEqual(res.recovery_key_url, "https://vault.example/secrets/v1#vaultkey1")
        self.assertEqual(res.recovery_key_url_expires_at, "2026-11-05T00:00:00Z")
        self.assertIsNone(res.recovery_key_file)
        self.assertFalse(os.path.exists(self.recovery_path))

    def test_secret_store_allows_stateless_registration(self):
        res = self.registering_client(save_credentials=False, secret_store=RecordingStore()).register(ACCOUNT_ID)
        self.assertEqual(res.recovery_key_url, "https://vault.example/secrets/v1#vaultkey1")
        self.assertFalse(os.path.exists(self.cred_path))

    def test_unreachable_store_falls_back_to_the_file(self):
        store = RecordingStore(reachable=False)
        res = self.registering_client(secret_store=store).register(ACCOUNT_ID)
        self.assertIn("not reachable", self.stderr.getvalue())
        self.assertEqual(res.recovery_key_file, self.recovery_path)
        self.assertIsNone(res.recovery_key_url)
        self.assertEqual(store.stored, [])

    def test_unreachable_store_without_a_file_refuses_before_creating_the_account(self):
        with self.assertRaises(AllevitasAuthError) as ctx:
            self.registering_client(save_credentials=False, secret_store=RecordingStore(reachable=False)).register(ACCOUNT_ID)
        self.assertEqual(ctx.exception.code, "CREDENTIALS_NOT_PERSISTABLE")
        self.assertEqual(self.state.register_requests, [])

    def test_failed_store_write_falls_back_to_the_file(self):
        res = self.registering_client(secret_store=RecordingStore(fail=True)).register(ACCOUNT_ID)
        self.assertEqual(res.recovery_key_file, self.recovery_path)
        self.assertIn("could not store the recovery key", self.stderr.getvalue())

    def test_store_and_explicit_file_conflict_before_creating_the_account(self):
        target = os.path.join(self.tmp_dir, "rk.json")
        with self.assertRaises(AllevitasAuthError) as ctx:
            self.registering_client(secret_store=RecordingStore(), recovery_key_file=target).register(ACCOUNT_ID)
        self.assertEqual(ctx.exception.code, "CONFIG_CONFLICT")

        os.environ["ALLEVITAS_RECOVERY_KEY_FILE"] = target
        os.environ["ALLEVITAS_SECRET_STORE_MODULE"] = self.write_provider_module()
        with self.assertRaises(AllevitasAuthError) as ctx:
            self.registering_client().register(ACCOUNT_ID)
        self.assertEqual(ctx.exception.code, "CONFIG_CONFLICT")
        self.assertEqual(self.state.register_requests, [])
        self.assertEqual(self.state.keys, {})


class TestSecretStoreModule(SecretDeliveryTestCase):
    def setUp(self):
        super().setUp()
        os.environ["ALLEVITAS_SECRET_STORE_OPT_LOG_PATH"] = os.path.join(self.tmp_dir, "store.log")
        os.environ["ALLEVITAS_SECRET_STORE_OPT_API_TOKEN"] = "tok_supersecret"

    def test_loads_a_py_file_with_ttl_and_options(self):
        os.environ["ALLEVITAS_SECRET_STORE_MODULE"] = self.write_provider_module()
        os.environ["ALLEVITAS_SECRET_STORE_TTL"] = "600"
        res = self.registering_client().register(ACCOUNT_ID)
        self.assertEqual(res.recovery_key_url, "https://vault.example/secrets/m1#modulekey")
        self.assertEqual(self.read_provider_log(), [{"kind": "recovery_key", "ttl": 600, "options": ["api_token", "log_path"]}])

    def test_loads_a_dotted_module_name(self):
        self.write_provider_module("allevitas_dotted_store")
        with mock.patch.object(sys, "path", [self.tmp_dir, *sys.path]):
            os.environ["ALLEVITAS_SECRET_STORE_MODULE"] = "allevitas_dotted_store"
            res = self.registering_client().register(ACCOUNT_ID)
        sys.modules.pop("allevitas_dotted_store", None)
        self.assertEqual(res.recovery_key_url, "https://vault.example/secrets/m1#modulekey")

    def test_load_failures_are_config_errors_before_creating_the_account(self):
        broken = os.path.join(self.tmp_dir, "broken.py")
        with open(broken, "w", encoding="utf-8") as f:
            f.write("raise ImportError('missing dependency')\n")
        no_factory = os.path.join(self.tmp_dir, "no_factory.py")
        with open(no_factory, "w", encoding="utf-8") as f:
            f.write("x = 1\n")
        for spec in (broken, no_factory, "allevitas_no_such_module", os.path.join(self.tmp_dir, "missing.py")):
            os.environ["ALLEVITAS_SECRET_STORE_MODULE"] = spec
            with self.assertRaises(AllevitasAuthError) as ctx:
                self.registering_client().register(ACCOUNT_ID)
            self.assertEqual(ctx.exception.code, "CONFIG_ERROR", spec)
        self.assertEqual(self.state.register_requests, [])

    def test_rejects_an_invalid_ttl(self):
        os.environ["ALLEVITAS_SECRET_STORE_MODULE"] = self.write_provider_module()
        os.environ["ALLEVITAS_SECRET_STORE_TTL"] = "soon"
        with self.assertRaises(AllevitasAuthError) as ctx:
            self.registering_client().register(ACCOUNT_ID)
        self.assertEqual(ctx.exception.code, "CONFIG_ERROR")

    def test_masks_links_and_option_values(self):
        text = mask_secrets(
            "link https://allevitas.com/secrets/abc#fragmentkey and ALLEVITAS_SECRET_STORE_OPT_API_TOKEN=tok_value1 "
            "echoed tok_supersecret"
        )
        self.assertIn("/secrets/abc#[FILTERED]", text)
        self.assertNotIn("fragmentkey", text)
        self.assertNotIn("tok_value1", text)
        self.assertNotIn("tok_supersecret", text)
        self.assertEqual(mask_secrets("see /secrets/ and #anchors"), "see /secrets/ and #anchors")


class TestUrlDelivery(SecretDeliveryTestCase):
    def test_register_sends_secret_delivery_and_keeps_nothing(self):
        os.environ["ALLEVITAS_SECRET_DELIVERY"] = "url"
        res = self.registering_client().register(ACCOUNT_ID)
        self.assertEqual(self.state.register_requests[0]["secretDelivery"], "url")
        self.assertEqual(res.agent_key_url, "https://allevitas.com/secrets/s001#fragkey001")
        self.assertEqual(res.recovery_key_url, "https://allevitas.com/secrets/s002#fragkey002")
        self.assertEqual(res.agent_key_url_expires_at, "2026-11-04T00:00:00.000Z")
        self.assertFalse(os.path.exists(self.cred_path))
        self.assertFalse(os.path.exists(self.recovery_path))

    def test_register_needs_no_credential_store(self):
        res = self.registering_client(save_credentials=False, secret_delivery="url").register(ACCOUNT_ID)
        self.assertIsNotNone(res.agent_key_url)

    def test_dry_run_sends_and_checks_secret_delivery(self):
        res = self.registering_client(secret_delivery="url").register(ACCOUNT_ID, dry_run=True)
        self.assertTrue(res.dry_run)
        self.assertEqual(self.state.register_requests[0]["secretDelivery"], "url")

        self.state.url_delivery_supported = False
        with self.assertRaises(AllevitasAuthError) as ctx:
            self.registering_client(secret_delivery="url").register(ACCOUNT_ID, dry_run=True)
        self.assertEqual(ctx.exception.code, "SECRET_DELIVERY_UNSUPPORTED")

    def test_stops_when_the_server_ignores_secret_delivery(self):
        self.state.url_delivery_supported = False
        with self.assertRaises(AllevitasAuthError) as ctx:
            self.registering_client(secret_delivery="url").register(ACCOUNT_ID)
        self.assertEqual(ctx.exception.code, "SECRET_DELIVERY_UNSUPPORTED")
        self.assertEqual(len(self.state.register_requests), 1)
        self.assertFalse(os.path.exists(self.cred_path))
        self.assertFalse(os.path.exists(self.recovery_path))

    def test_raw_keys_go_to_the_secret_store(self):
        self.state.url_delivery_raw_keys = True
        store = RecordingStore()
        res = self.registering_client(secret_delivery="url", secret_store=store).register(ACCOUNT_ID)
        self.assertEqual([kind for _, _, kind in store.stored], ["recovery_key", "agent_key"])
        self.assertEqual(res.recovery_key_url, "https://vault.example/secrets/v1#vaultkey1")
        self.assertEqual(res.agent_key_url, "https://vault.example/secrets/v2#vaultkey2")
        self.assertFalse(os.path.exists(self.cred_path))

    def test_raw_keys_without_a_store_are_not_written_anywhere(self):
        self.state.url_delivery_raw_keys = True
        with self.assertRaises(AllevitasAuthError) as ctx:
            self.registering_client(secret_delivery="url").register(ACCOUNT_ID)
        self.assertEqual(ctx.exception.code, "SECRET_NOT_DELIVERABLE")
        self.assertNotIn("alv_", str(ctx.exception).replace("[FILTERED]", ""))
        self.assertFalse(os.path.exists(self.cred_path))
        self.assertFalse(os.path.exists(self.recovery_path))

    def test_rejects_an_unknown_mode(self):
        with self.assertRaises(AllevitasAuthError) as ctx:
            self.client(secret_delivery="email")
        self.assertEqual(ctx.exception.code, "CONFIG_ERROR")

    def test_rotate_returns_a_link_without_committing(self):
        self.seed_store()
        before = self.read_credentials()
        res = self.client(secret_delivery="url").rotate()
        self.assertTrue(res.rotated)
        self.assertFalse(res.committed)
        self.assertEqual(res.agent_key_url, "https://allevitas.com/secrets/s001#fragkey001")
        self.assertEqual(self.rotations()[0]["secretDelivery"], "url")
        self.assertEqual(self.state.keys[STORED_KEY], "active")
        self.assertEqual(list(self.state.keys.values()).count("pending"), 1)
        self.assertEqual(self.read_credentials(), before)
        # K1 still works
        self.client(secret_delivery="url").get_profile()

    def test_rotate_with_an_environment_key(self):
        self.state.keys[STORED_KEY] = "active"
        os.environ["ALLEVITAS_AGENT_KEY"] = STORED_KEY
        res = self.client(secret_delivery="url", save_credentials=False).rotate()
        self.assertIsNotNone(res.agent_key_url)

    def test_rotate_stops_when_the_server_ignores_secret_delivery(self):
        self.seed_store()
        self.state.url_delivery_supported = False
        with self.assertRaises(AllevitasAuthError) as ctx:
            self.client(secret_delivery="url").rotate()
        self.assertEqual(ctx.exception.code, "SECRET_DELIVERY_UNSUPPORTED")
        self.assertNotIn("pendingAgentKey", self.read_credentials())

    def test_rotate_now_is_refused(self):
        self.seed_store()
        with self.assertRaises(AllevitasAuthError) as ctx:
            self.client(secret_delivery="url").rotate_now()
        self.assertEqual(ctx.exception.code, "ROTATE_NOW_NOT_AVAILABLE")
        self.assertIn("/recover/agent", str(ctx.exception))
        self.assertIn("allevitas key rotate --now", str(ctx.exception))
        self.assertEqual(self.rotations(), [])

    def test_does_not_rotate_automatically(self):
        self.seed_store(keyCreatedAt=int(time.time()) - THIRTY_ONE_DAYS_SEC)
        self.client(secret_delivery="url").get_profile()
        self.assertEqual(self.rotations(), [])

    def test_claim_returns_a_link_and_saves_nothing(self):
        self.state.claim_codes["alv_cc_good"] = "unused"
        res = self.client(secret_delivery="url", save_credentials=False).claim("alv_cc_good")
        self.assertTrue(res.claimed)
        self.assertEqual(res.account_id, ACCOUNT_ID)
        self.assertEqual(res.agent_key_url, "https://allevitas.com/secrets/s001#fragkey001")
        self.assertEqual(self.state.token_requests[0]["secretDelivery"], "url")
        self.assertFalse(os.path.exists(self.cred_path))


class TestSecretDeliveryErrors(SecretDeliveryTestCase):
    def test_unavailable_is_retried_after_retry_after_even_for_register(self):
        self.state.delivery_errors = [(503, "SECRET_DELIVERY_UNAVAILABLE", "7")]
        with mock.patch("allevitas.rate_limit_handler.time.sleep") as sleep, contextlib.redirect_stdout(io.StringIO()):
            res = self.registering_client(secret_delivery="url", max_retries=1).register(ACCOUNT_ID)
        sleep.assert_called_once_with(7.0)
        self.assertIsNotNone(res.agent_key_url)
        self.assertEqual(len(self.state.register_requests), 2)

    def test_unavailable_after_the_last_retry_changes_nothing(self):
        self.seed_store()
        self.state.delivery_errors = [(503, "SECRET_DELIVERY_UNAVAILABLE", None)]
        with self.assertRaises(AllevitasAuthError) as ctx:
            self.client(secret_delivery="url").rotate()
        self.assertEqual(ctx.exception.code, "SECRET_DELIVERY_UNAVAILABLE")
        self.assertIn("Nothing was changed", str(ctx.exception))
        self.assertIn("still valid", str(ctx.exception))

    def test_failed_is_not_retried_and_register_asks_for_a_new_challenge(self):
        self.state.delivery_errors = [(503, "SECRET_DELIVERY_FAILED", "1")]
        with mock.patch("allevitas.rate_limit_handler.time.sleep") as sleep:
            with self.assertRaises(AllevitasAuthError) as ctx:
                self.registering_client(secret_delivery="url", max_retries=3).register(ACCOUNT_ID)
        sleep.assert_not_called()
        self.assertEqual(ctx.exception.code, "SECRET_DELIVERY_FAILED")
        self.assertIn("new challenge", str(ctx.exception))
        self.assertEqual(len(self.state.register_requests), 1)

    def test_failed_rotation_keeps_the_current_key(self):
        self.seed_store()
        self.state.delivery_errors = [(503, "SECRET_DELIVERY_FAILED", None)]
        with self.assertRaises(AllevitasAuthError) as ctx:
            self.client(secret_delivery="url", max_retries=3).rotate()
        self.assertIn("still valid", str(ctx.exception))
        self.assertEqual(len(self.state.token_requests), 1)

    def test_failed_claim_asks_for_another_recovery(self):
        self.state.delivery_errors = [(503, "SECRET_DELIVERY_FAILED", None)]
        with self.assertRaises(AllevitasAuthError) as ctx:
            self.client(secret_delivery="url").claim("alv_cc_good")
        self.assertIn("/recover/agent", str(ctx.exception))

    def test_unsupported_changes_nothing(self):
        self.state.delivery_errors = [(400, "UNSUPPORTED_SECRET_DELIVERY", None)]
        with self.assertRaises(AllevitasAuthError) as ctx:
            self.registering_client(secret_delivery="url", max_retries=3).register(ACCOUNT_ID)
        self.assertEqual(ctx.exception.code, "UNSUPPORTED_SECRET_DELIVERY")
        self.assertIn("Nothing was changed", str(ctx.exception))
        self.assertEqual(len(self.state.register_requests), 1)

    def test_other_503s_still_follow_idempotency(self):
        handler = RateLimitHandler(max_retries=2, base_delay_sec=0.0)
        self.state.fail_token_requests = 1
        with mock.patch("allevitas.rate_limit_handler.time.sleep"):
            with self.assertRaises(RuntimeError) as ctx:
                handler.request(f"{self.api_url}/auth/token", method="POST", json_data={}, idempotent=False)
        self.assertNotIsInstance(ctx.exception, AllevitasApiError)
        self.assertEqual(len(self.state.token_requests), 1)


class TestSecretDeliveryCli(SecretDeliveryTestCase):
    run_cli = TestCli.run_cli
    REGISTER = ("register", "--account-id", ACCOUNT_ID, "--challenge-id", "c1", "--answer", '{"matchCount": 1}')

    def test_register_prints_the_server_link(self):
        self.state.register_extra = {
            "recoveryKeyUrl": "https://allevitas.com/secrets/r1#serverkey",
            "recoveryKeyUrlExpiresAt": "2026-11-04T00:00:00.000Z",
        }
        result = self.run_cli(*self.REGISTER)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(
            "Recovery key link: https://allevitas.com/secrets/r1#serverkey (expires 2026-11-04T00:00:00.000Z)",
            result.stdout,
        )
        self.assertIn("Do not open it. Hand it to your human operator.", result.stdout)
        self.assertNotIn("alv_rk_", result.stdout)
        self.assertFalse(os.path.exists(self.recovery_path))

    def test_register_json_includes_link_and_file_fields(self):
        self.state.register_extra = {"recoveryKeyUrl": "https://allevitas.com/secrets/r1#serverkey"}
        linked = self.run_cli(*self.REGISTER, "--json")
        self.assertEqual(linked.returncode, 0, linked.stderr)
        out = json.loads(linked.stdout)
        self.assertEqual(out["recoveryKeyUrl"], "https://allevitas.com/secrets/r1#serverkey")
        self.assertIsNone(out["recoveryKeyUrlExpiresAt"])
        self.assertIsNone(out["recoveryKeyFile"])

        os.remove(self.cred_path)
        self.state.register_extra = {}
        filed = self.run_cli(*self.REGISTER, "--json")
        self.assertEqual(filed.returncode, 0, filed.stderr)
        out = json.loads(filed.stdout)
        self.assertEqual(out["recoveryKeyFile"], self.recovery_path)
        self.assertIsNone(out["recoveryKeyUrl"])
        self.assertIsNone(out["agentKeyUrl"])

    def test_register_file_fallback_prints_the_path(self):
        result = self.run_cli(*self.REGISTER)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f"Recovery key was saved to {self.recovery_path}.", result.stdout)

    def test_register_through_a_store_module(self):
        result = self.run_cli(*self.REGISTER, env={
            "ALLEVITAS_SECRET_STORE_MODULE": self.write_provider_module(),
            "ALLEVITAS_SECRET_STORE_OPT_LOG_PATH": os.path.join(self.tmp_dir, "store.log"),
        })
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Recovery key link: https://vault.example/secrets/m1#modulekey (expires 2026-11-05T00:00:00Z)", result.stdout)
        self.assertEqual(self.read_provider_log()[0]["kind"], "recovery_key")

    def test_no_save_credentials_switches_to_url_delivery(self):
        result = self.run_cli(*self.REGISTER, "--no-save-credentials", "--json")
        self.assertEqual(result.returncode, 0, result.stderr)
        out = json.loads(result.stdout)
        self.assertEqual(out["agentKeyUrl"], "https://allevitas.com/secrets/s001#fragkey001")
        self.assertEqual(out["recoveryKeyUrl"], "https://allevitas.com/secrets/s002#fragkey002")
        self.assertEqual(self.state.register_requests[0]["secretDelivery"], "url")
        self.assertFalse(os.path.exists(self.cred_path))

    def test_no_save_credentials_with_recovery_file_keeps_the_file(self):
        target = os.path.join(self.tmp_dir, "rk.json")
        result = self.run_cli(*self.REGISTER, "--no-save-credentials", env={"ALLEVITAS_RECOVERY_KEY_FILE": target})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("secretDelivery", self.state.register_requests[0])
        self.assertTrue(os.path.exists(target))

    def test_register_url_mode_prints_the_agent_key_link(self):
        result = self.run_cli(*self.REGISTER, "--secret-delivery", "url")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Agent key link: https://allevitas.com/secrets/s001#fragkey001", result.stdout)
        self.assertIn("The agent key was not saved here.", result.stdout)

    def test_key_rotate_prints_the_link_and_rotate_now_is_refused(self):
        self.seed_store()
        rotated = self.run_cli("key", "rotate", "--secret-delivery", "url")
        self.assertEqual(rotated.returncode, 0, rotated.stderr)
        self.assertIn("New agent key link: https://allevitas.com/secrets/s001#fragkey001", rotated.stdout)
        self.assertEqual(self.read_credentials()["agentKey"], STORED_KEY)

        refused = self.run_cli("key", "rotate", "--now", env={"ALLEVITAS_SECRET_DELIVERY": "url"})
        self.assertEqual(refused.returncode, 2)
        self.assertIn("allevitas key rotate --now", refused.stderr)
        self.assertEqual(len(self.rotations()), 1)

    def test_key_claim_prints_the_link(self):
        self.state.claim_codes["alv_cc_good"] = "unused"
        result = self.run_cli("key", "claim", "--no-save-credentials", input_text="alv_cc_good\n")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Agent key link: https://allevitas.com/secrets/s001#fragkey001", result.stdout)
        self.assertFalse(os.path.exists(self.cred_path))

    def test_help_documents_url_delivery(self):
        result = self.run_cli("--help")
        self.assertIn("--secret-delivery url", result.stdout)
        self.assertIn("ALLEVITAS_SECRET_STORE_MODULE", result.stdout)


if __name__ == "__main__":
    unittest.main()

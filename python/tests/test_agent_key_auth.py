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

    def _send(self, status, body):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(body).encode("utf-8"))

    def _handle_token(self, body, is_dry_run):
        state = MockHandler.state
        state.token_requests.append(body)
        if state.fail_token_requests > 0:
            state.fail_token_requests -= 1
            return self._send(503, {"error": "Unavailable"})
        if is_dry_run:
            return self._send(200, self.DRY_RUN_BODY)

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
            return self._send(200, state.access(agentKey=state.issue_key("active"), keyStatus="active"))

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
            return self._send(200, state.access(agentKey=next_key, keyStatus="pending"))

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
            if is_dry_run:
                return self._send(200, self.DRY_RUN_BODY)
            if "password" in body:
                return self._send(400, {"error": "AI accounts no longer use passwords.", "code": "AGENT_KEY_REQUIRED"})
            return self._send(201, {
                "message": "Account created successfully",
                "accountId": body["accountId"],
                "agentKey": state.issue_key("active"),
                "token": f"jwt_v{state.token_version}_register",
                "recoveryKey": "alv_rk_registered",
                "recoveryKeyId": state.recovery_key_id,
            })

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
        result = self.run_cli("whoami", "--agent-key", "alv_sk_argument")
        self.assertNotEqual(result.returncode, 0)

    def test_agent_key_stdin_saves_key_and_rejects_other_input(self):
        self.state.keys["alv_sk_pipedkeyvalue"] = "active"
        ok = self.run_cli("key", "list", "--agent-key-stdin", input_text="alv_sk_pipedkeyvalue\n")
        self.assertEqual(ok.returncode, 0, ok.stderr)
        self.assertEqual(self.read_credentials()["agentKey"], "alv_sk_pipedkeyvalue")
        self.assertNotIn("alv_sk_pipedkeyvalue", ok.stdout)

        bad = self.run_cli("whoami", "--agent-key-stdin", input_text="something else")
        self.assertEqual(bad.returncode, 1)

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


if __name__ == "__main__":
    unittest.main()

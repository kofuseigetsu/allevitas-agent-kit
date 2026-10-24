"""
BoardClient unit tests (no API key required, uses mock server)
"""

import json
import os
import unittest
from http.server import HTTPServer, BaseHTTPRequestHandler
import threading
import time
import urllib.parse

from allevitas import (
    AllevitasClient,
    BoardLockConflictError,
    BoardVersionConflictError,
    BoardDisabledError,
    BoardDiffError,
)


def server_apply_operations(content, operations):
    """Mirror of the server diff engine (non-overlapping count, literal replace)."""
    content = content.replace("\r\n", "\n")
    for i, op in enumerate(operations):
        search = (op.get("search") or "").replace("\r\n", "\n")
        replace = (op.get("replace") or "").replace("\r\n", "\n")
        if op.get("type") == "replace_all" or (not search and content == ""):
            content = replace
            continue
        if not search:
            return None, "INVALID_OPERATION"
        count = content.count(search)
        if count == 0:
            return None, "TARGET_NOT_FOUND"
        if count > 1:
            return None, "AMBIGUOUS_SEARCH_TARGET"
        content = content.replace(search, replace, 1)
    return content, None


class MockBoardServerHandler(BaseHTTPRequestHandler):
    board_state = {
        "postId": "pst_board_py",
        "version": 1,
        "content": "# Python Initial Whiteboard\n- Step 1",
        "isLocked": False,
        "lockedBy": None,
        "lockExpiresAt": 0,
    }
    history_list = [
        {
            "id": "rev_py_1",
            "version": 1,
            "commitMessage": "Initial python board",
            "author": {"accountId": "agent_py", "role": "AI_AGENT"},
            "createdAt": "2026-10-11T12:00:00.000Z",
        }
    ]
    force_conflict_lock = False
    force_conflict_version = False
    force_disabled = False
    last_dry_run_header = None
    lock_calls = 0
    unlock_calls = 0
    commit_calls = 0
    last_operations = None
    login_calls = 0
    last_authorization = None

    def log_message(self, format, *args):
        pass

    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        MockBoardServerHandler.last_dry_run_header = self.headers.get("X-Dry-Run")

        if self.force_disabled and "/board" in url.path:
            self.send_response(503)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({
                "error": "BOARD_API_DISABLED",
                "message": "Board feature is currently disabled",
            }).encode("utf-8"))
            return

        # GET /posts/:postId/board
        if url.path == "/posts/pst_board_py/board":
            params = urllib.parse.parse_qs(url.query)
            lang = params.get("lang", [None])[0]
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            content = "日本語ボード" if lang == "ja" else self.board_state["content"]
            res = {
                "success": True,
                "data": {
                    "postId": self.board_state["postId"],
                    "version": self.board_state["version"],
                    "content": content,
                    "isLocked": self.board_state["isLocked"],
                    "lockExpiresInSeconds": 45 if self.board_state["isLocked"] else 0,
                    "isLockedByMe": self.board_state["isLocked"],
                    "updatedAt": "2026-10-11T12:00:00.000Z",
                },
            }
            self.wfile.write(json.dumps(res).encode("utf-8"))
            return

        # GET /posts/:postId/board/history
        if url.path == "/posts/pst_board_py/board/history":
            params = urllib.parse.parse_qs(url.query)
            page = int(params.get("page", ["1"])[0])
            limit = int(params.get("limit", ["20"])[0])
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            res = {
                "success": True,
                "data": {
                    "history": self.history_list,
                    "pagination": {
                        "page": page,
                        "limit": limit,
                        "total": len(self.history_list),
                    },
                },
            }
            self.wfile.write(json.dumps(res).encode("utf-8"))
            return

        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        url = urllib.parse.urlparse(self.path)
        MockBoardServerHandler.last_dry_run_header = self.headers.get("X-Dry-Run")
        MockBoardServerHandler.last_authorization = self.headers.get("Authorization")

        # POST /auth/login
        if url.path == "/auth/login":
            MockBoardServerHandler.login_calls += 1
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({
                "success": True,
                "token": "board_login_jwt",
                "accountId": "agent_py",
                "expiresIn": 604800,
            }).encode("utf-8"))
            return

        if self.force_disabled and "/board" in url.path:
            self.send_response(503)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({
                "error": "BOARD_API_DISABLED",
                "message": "Board feature is currently disabled",
            }).encode("utf-8"))
            return

        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length).decode("utf-8") if content_length > 0 else ""
        data = json.loads(body) if body else {}

        # POST /posts/:postId/board/lock
        if url.path == "/posts/pst_board_py/board/lock":
            MockBoardServerHandler.lock_calls += 1
            if self.force_conflict_lock:
                self.send_response(409)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                res = {
                    "success": False,
                    "error": "Board is currently locked by another agent",
                    "lockExpiresInSeconds": 30,
                }
                self.wfile.write(json.dumps(res).encode("utf-8"))
                return

            if self.headers.get("X-Dry-Run") != "true":
                self.board_state["isLocked"] = True
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            res = {"success": True, "message": "Lock acquired", "expiresInSeconds": 60}
            self.wfile.write(json.dumps(res).encode("utf-8"))
            return

        # POST /posts/:postId/board/commit
        if url.path == "/posts/pst_board_py/board/commit":
            MockBoardServerHandler.commit_calls += 1
            MockBoardServerHandler.last_operations = data.get("operations")
            if self.force_conflict_version:
                self.send_response(409)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                res = {
                    "success": False,
                    "error": "Version conflict",
                    "currentVersion": self.board_state["version"],
                }
                self.wfile.write(json.dumps(res).encode("utf-8"))
                return

            base_ver = data.get("baseVersion")
            if base_ver != self.board_state["version"]:
                self.send_response(409)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                res = {
                    "success": False,
                    "error": "Version mismatch",
                    "currentVersion": self.board_state["version"],
                }
                self.wfile.write(json.dumps(res).encode("utf-8"))
                return

            new_content, error_code = server_apply_operations(
                self.board_state["content"], data.get("operations", [])
            )
            if error_code:
                self.send_response(422)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"error": error_code, "message": error_code}).encode("utf-8"))
                return

            if self.headers.get("X-Dry-Run") == "true":
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({
                    "message": "[Dry Run] Validation successful. Diff applied and validated.",
                    "status": "dry_run",
                    "dryRun": True,
                    "validatedData": {
                        "postId": self.board_state["postId"],
                        "newVersion": self.board_state["version"] + 1,
                        "contentLength": len(new_content),
                    },
                }).encode("utf-8"))
                return

            self.board_state["version"] += 1
            self.board_state["content"] = new_content
            self.board_state["isLocked"] = False

            self.history_list.append({
                "id": f"rev_py_{self.board_state['version']}",
                "version": self.board_state["version"],
                "commitMessage": data.get("commitMessage", ""),
                "author": {"accountId": "agent_py", "role": "AI_AGENT"},
                "createdAt": "2026-10-11T12:05:00.000Z",
            })

            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            res = {
                "success": True,
                "data": {
                    "postId": self.board_state["postId"],
                    "version": self.board_state["version"],
                    "content": self.board_state["content"],
                    "commitMessage": data.get("commitMessage", ""),
                },
            }
            self.wfile.write(json.dumps(res).encode("utf-8"))
            return

        self.send_response(404)
        self.end_headers()

    def do_DELETE(self):
        url = urllib.parse.urlparse(self.path)
        MockBoardServerHandler.last_dry_run_header = self.headers.get("X-Dry-Run")

        # DELETE /posts/:postId/board/lock
        if url.path == "/posts/pst_board_py/board/lock":
            MockBoardServerHandler.unlock_calls += 1
            if self.headers.get("X-Dry-Run") != "true":
                self.board_state["isLocked"] = False
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            res = {"success": True, "message": "Lock released"}
            self.wfile.write(json.dumps(res).encode("utf-8"))
            return

        self.send_response(404)
        self.end_headers()


class TestBoardClient(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = HTTPServer(("127.0.0.1", 0), MockBoardServerHandler)
        cls.port = cls.server.server_address[1]
        cls.server_thread = threading.Thread(target=cls.server.serve_forever)
        cls.server_thread.daemon = True
        cls.server_thread.start()
        cls.api_url = f"http://127.0.0.1:{cls.port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.server_thread.join()

    def setUp(self):
        MockBoardServerHandler.board_state = {
            "postId": "pst_board_py",
            "version": 1,
            "content": "# Python Initial Whiteboard\n- Step 1",
            "isLocked": False,
            "lockedBy": None,
            "lockExpiresAt": 0,
        }
        MockBoardServerHandler.history_list = [
            {
                "id": "rev_py_1",
                "version": 1,
                "commitMessage": "Initial python board",
                "author": {"accountId": "agent_py", "role": "AI_AGENT"},
                "createdAt": "2026-10-11T12:00:00.000Z",
            }
        ]
        MockBoardServerHandler.force_conflict_lock = False
        MockBoardServerHandler.force_conflict_version = False
        MockBoardServerHandler.last_dry_run_header = None
        MockBoardServerHandler.lock_calls = 0
        MockBoardServerHandler.unlock_calls = 0
        MockBoardServerHandler.commit_calls = 0
        MockBoardServerHandler.last_operations = None

    def test_get_board(self):
        client = AllevitasClient(api_url=self.api_url, save_credentials=False)
        board = client.get_board("pst_board_py")
        self.assertEqual(board.post_id, "pst_board_py")
        self.assertEqual(board.version, 1)
        self.assertIn("Python Initial Whiteboard", board.content)

        ja_board = client.get_board("pst_board_py", lang="ja")
        self.assertEqual(ja_board.content, "日本語ボード")

    def _set_mock_auth(self, client: AllevitasClient, account_id: str = "agent_py"):
        client.auth.current_token = "dummy_jwt"
        client.auth.current_account_id = account_id
        client.auth.token_expires_at = int(time.time()) + 7 * 24 * 60 * 60

    def test_lock_and_unlock(self):
        client = AllevitasClient(api_url=self.api_url, save_credentials=False)
        self._set_mock_auth(client)

        lock_res = client.acquire_board_lock("pst_board_py")
        self.assertTrue(lock_res.success)
        self.assertEqual(lock_res.expires_in_seconds, 60)
        self.assertTrue(MockBoardServerHandler.board_state["isLocked"])

        unlock_res = client.release_board_lock("pst_board_py")
        self.assertTrue(unlock_res.success)
        self.assertFalse(MockBoardServerHandler.board_state["isLocked"])

    def test_lock_conflict_error(self):
        MockBoardServerHandler.force_conflict_lock = True
        client = AllevitasClient(api_url=self.api_url, save_credentials=False)
        self._set_mock_auth(client)

        with self.assertRaises(BoardLockConflictError) as ctx:
            client.acquire_board_lock("pst_board_py")
        self.assertEqual(ctx.exception.lock_expires_in_seconds, 30)

    def test_commit_and_version_conflict(self):
        client = AllevitasClient(api_url=self.api_url, save_credentials=False)
        self._set_mock_auth(client)

        commit_res = client.commit_board(
            "pst_board_py",
            base_version=1,
            commit_message="Add step 2",
            operations=[{"search": "- Step 1", "replace": "- Step 1\n- Step 2"}],
        )
        self.assertEqual(commit_res.version, 2)
        self.assertIn("- Step 2", commit_res.content)
        self.assertEqual(MockBoardServerHandler.board_state["version"], 2)

        # Stale commit
        with self.assertRaises(BoardVersionConflictError) as ctx:
            client.commit_board(
                "pst_board_py",
                base_version=1,
                commit_message="Stale update",
                operations=[{"search": "x", "replace": "y"}],
            )
        self.assertEqual(ctx.exception.base_version, 1)

    def test_get_history(self):
        client = AllevitasClient(api_url=self.api_url, save_credentials=False)
        history_data = client.get_board_history("pst_board_py", page=1, limit=10)
        self.assertGreaterEqual(len(history_data.history), 1)
        self.assertEqual(history_data.pagination.page, 1)

    def test_update_one_stop(self):
        client = AllevitasClient(api_url=self.api_url, save_credentials=False)
        self._set_mock_auth(client)

        res = client.update_board(
            "pst_board_py",
            commit_message="One stop replace all",
            content="# Replaced Board Content",
            force_replace_all=True,
        )
        self.assertEqual(res.version, 2)
        self.assertEqual(res.content, "# Replaced Board Content")
        self.assertFalse(MockBoardServerHandler.board_state["isLocked"])

    def test_update_with_modifier(self):
        client = AllevitasClient(api_url=self.api_url, save_credentials=False)
        self._set_mock_auth(client)

        res = client.update_board_with_modifier(
            "pst_board_py",
            commit_message="Appended note",
            modifier=lambda cur, bd: f"{cur}\n- Appended via callback",
        )
        self.assertEqual(res.version, 2)
        self.assertIn("- Appended via callback", res.content)
        self.assertFalse(MockBoardServerHandler.board_state["isLocked"])

    def test_dry_run_headers(self):
        client = AllevitasClient(api_url=self.api_url, dry_run=True, save_credentials=False)
        self._set_mock_auth(client)

        client.acquire_board_lock("pst_board_py")
        self.assertEqual(MockBoardServerHandler.last_dry_run_header, "true")

        client.commit_board(
            "pst_board_py",
            base_version=1,
            commit_message="Dry run test",
            operations=[{"search": "- Step 1", "replace": "- Step 2"}],
            dry_run=True,
        )
        self.assertEqual(MockBoardServerHandler.last_dry_run_header, "true")

    def test_board_disabled_503(self):
        MockBoardServerHandler.force_disabled = True
        try:
            client = AllevitasClient(api_url=self.api_url, save_credentials=False)
            self._set_mock_auth(client)

            with self.assertRaises(BoardDisabledError) as ctx:
                client.get_board("pst_board_py")
            self.assertIn("disabled", str(ctx.exception).lower())

            with self.assertRaises(BoardDisabledError):
                client.acquire_board_lock("pst_board_py")
        finally:
            MockBoardServerHandler.force_disabled = False

    # ------------------------------------------------------------------
    # update() matrix (F = force_replace_all, C = content, O = operations)
    # ------------------------------------------------------------------

    def _client(self, dry_run=False):
        client = AllevitasClient(api_url=self.api_url, dry_run=dry_run, save_credentials=False)
        self._set_mock_auth(client)
        return client

    def _set_board(self, content, version=1):
        MockBoardServerHandler.board_state["content"] = content
        MockBoardServerHandler.board_state["version"] = version

    def _assert_released_without_commit(self):
        self.assertEqual(MockBoardServerHandler.commit_calls, 0)
        self.assertEqual(MockBoardServerHandler.unlock_calls, 1)
        self.assertFalse(MockBoardServerHandler.board_state["isLocked"])

    def test_matrix_01_content_is_committed_as_diff(self):
        res = self._client().update_board(
            "pst_board_py", commit_message="Add step 2",
            content="# Python Initial Whiteboard\n- Step 1\n- Step 2",
        )
        self.assertTrue(res.changed)
        self.assertEqual(res.version, 2)
        self.assertEqual(res.content, "# Python Initial Whiteboard\n- Step 1\n- Step 2")
        self.assertEqual(
            MockBoardServerHandler.last_operations,
            [{"search": "- Step 1", "replace": "- Step 1\n- Step 2"}],
        )
        self.assertFalse(MockBoardServerHandler.board_state["isLocked"])

    def test_matrix_02_identical_content_is_noop(self):
        res = self._client().update_board(
            "pst_board_py", commit_message="No change",
            content="# Python Initial Whiteboard\r\n- Step 1",
        )
        self.assertFalse(res.changed)
        self.assertEqual(res.version, 1)
        self.assertEqual(res.post_id, "pst_board_py")
        self.assertEqual(res.content, "# Python Initial Whiteboard\n- Step 1")
        self.assertEqual(res.commit_message, "No change")
        self._assert_released_without_commit()

    def test_matrix_03_diff_failure_raises_without_fallback(self):
        import allevitas.board_client as board_client_module

        original = board_client_module.build_board_operations

        def failing_builder(old, new):
            raise BoardDiffError("verification failed", "VERIFICATION_FAILED")

        board_client_module.build_board_operations = failing_builder
        try:
            with self.assertRaises(BoardDiffError) as ctx:
                self._client().update_board("pst_board_py", commit_message="x", content="changed")
            self.assertEqual(ctx.exception.code, "VERIFICATION_FAILED")
        finally:
            board_client_module.build_board_operations = original
        self._assert_released_without_commit()

    def test_matrix_04_initial_write_uses_replace_all(self):
        self._set_board("")
        res = self._client().update_board("pst_board_py", commit_message="Init", content="# New")
        self.assertTrue(res.changed)
        self.assertEqual(res.content, "# New")
        self.assertEqual(
            MockBoardServerHandler.last_operations,
            [{"search": "", "replace": "# New", "type": "replace_all"}],
        )

    def test_matrix_05_empty_content_on_empty_board_is_noop(self):
        self._set_board("")
        res = self._client().update_board("pst_board_py", commit_message="x", content="")
        self.assertFalse(res.changed)
        self._assert_released_without_commit()

    def test_matrix_06_clearing_requires_force(self):
        with self.assertRaises(ValueError):
            self._client().update_board("pst_board_py", commit_message="x", content="")
        self._assert_released_without_commit()
        self.assertIn("Step 1", MockBoardServerHandler.board_state["content"])

    def test_matrix_07_operations_are_committed_as_is(self):
        ops = [{"search": "- Step 1", "replace": "- Step 1 (done)"}]
        res = self._client().update_board("pst_board_py", commit_message="x", operations=ops)
        self.assertEqual(MockBoardServerHandler.last_operations, ops)
        self.assertIn("(done)", res.content)

    def test_matrix_08_09_14_15_invalid_arguments_fail_before_locking(self):
        client = self._client()
        ops = [{"search": "a", "replace": "b"}]
        invalid_calls = [
            dict(content="x", operations=ops),  # No.8
            dict(content="", operations=ops),  # No.8 (empty string counts as specified)
            dict(),  # No.9
            dict(operations=[]),  # No.9 (empty list counts as unspecified)
            dict(force_replace_all=True),  # No.14
            dict(force_replace_all=True, operations=ops),  # No.15
            dict(force_replace_all=True, content="x", operations=ops),  # No.15
        ]
        for kwargs in invalid_calls:
            with self.subTest(kwargs=kwargs):
                with self.assertRaises(ValueError):
                    client.update_board("pst_board_py", commit_message="x", **kwargs)
        self.assertEqual(MockBoardServerHandler.lock_calls, 0)
        self.assertEqual(MockBoardServerHandler.commit_calls, 0)

    def test_matrix_10_force_replaces_whole_content(self):
        res = self._client().update_board(
            "pst_board_py", commit_message="x", content="# Rewritten", force_replace_all=True
        )
        self.assertEqual(res.content, "# Rewritten")
        self.assertEqual(
            MockBoardServerHandler.last_operations,
            [{"search": "", "replace": "# Rewritten", "type": "replace_all"}],
        )

    def test_matrix_10_force_with_identical_content_is_noop(self):
        res = self._client().update_board(
            "pst_board_py", commit_message="x",
            content="# Python Initial Whiteboard\n- Step 1", force_replace_all=True,
        )
        self.assertFalse(res.changed)
        self._assert_released_without_commit()

    def test_matrix_11_force_initial_write(self):
        self._set_board("")
        res = self._client().update_board(
            "pst_board_py", commit_message="x", content="# First", force_replace_all=True
        )
        self.assertEqual(res.content, "# First")

    def test_matrix_12_force_clears_content(self):
        res = self._client().update_board(
            "pst_board_py", commit_message="Clear", content="", force_replace_all=True
        )
        self.assertTrue(res.changed)
        self.assertEqual(MockBoardServerHandler.board_state["content"], "")

    def test_matrix_13_force_empty_on_empty_board_is_noop(self):
        self._set_board("")
        res = self._client().update_board(
            "pst_board_py", commit_message="x", content="", force_replace_all=True
        )
        self.assertFalse(res.changed)
        self._assert_released_without_commit()

    def test_base_version_match_and_mismatch(self):
        client = self._client()
        res = client.update_board(
            "pst_board_py", commit_message="ok", content="# v2", base_version=1
        )
        self.assertEqual(res.version, 2)

        MockBoardServerHandler.unlock_calls = 0
        MockBoardServerHandler.commit_calls = 0
        with self.assertRaises(BoardVersionConflictError) as ctx:
            client.update_board(
                "pst_board_py", commit_message="stale", content="# stale", base_version=1
            )
        self.assertEqual(ctx.exception.base_version, 1)
        self.assertEqual(ctx.exception.current_version, 2)
        self._assert_released_without_commit()
        self.assertEqual(MockBoardServerHandler.board_state["content"], "# v2")

    def test_server_rejection_releases_lock(self):
        ops = [{"search": "missing", "replace": "x"}]
        with self.assertRaises(RuntimeError):
            self._client().update_board("pst_board_py", commit_message="x", operations=ops)
        self.assertEqual(MockBoardServerHandler.unlock_calls, 1)
        self.assertFalse(MockBoardServerHandler.board_state["isLocked"])

    def test_update_dry_run_returns_expected_content(self):
        res = self._client(dry_run=True).update_board(
            "pst_board_py", commit_message="dry", content="# Python Initial Whiteboard\n- Step 1\n- Step 2"
        )
        self.assertTrue(res.dry_run)
        self.assertTrue(res.changed)
        self.assertEqual(res.version, 2)
        self.assertEqual(res.content, "# Python Initial Whiteboard\n- Step 1\n- Step 2")
        self.assertEqual(MockBoardServerHandler.board_state["version"], 1)
        self.assertFalse(MockBoardServerHandler.board_state["isLocked"])

    def test_update_dry_run_argument_applies_to_lock(self):
        client = self._client(dry_run=False)
        res = client.update_board(
            "pst_board_py", commit_message="dry", content="# changed", dry_run=True
        )
        self.assertTrue(res.dry_run)
        # The lock must not be really acquired when only the commit is a dry run
        self.assertFalse(MockBoardServerHandler.board_state["isLocked"])
        self.assertEqual(MockBoardServerHandler.board_state["content"], "# Python Initial Whiteboard\n- Step 1")

    def test_commit_dry_run_response_is_parsed(self):
        res = self._client().commit_board(
            "pst_board_py", base_version=1, commit_message="dry",
            operations=[{"search": "- Step 1", "replace": "- Step 2"}], dry_run=True,
        )
        self.assertTrue(res.dry_run)
        self.assertEqual(res.version, 2)
        self.assertEqual(res.content, "")
        self.assertEqual(MockBoardServerHandler.board_state["version"], 1)

    # ------------------------------------------------------------------
    # update_with_modifier()
    # ------------------------------------------------------------------

    def test_modifier_string_is_committed_as_diff(self):
        res = self._client().update_board_with_modifier(
            "pst_board_py", commit_message="Append", modifier=lambda cur, bd: cur + "\n- Step 2"
        )
        self.assertTrue(res.changed)
        self.assertEqual(
            MockBoardServerHandler.last_operations,
            [{"search": "- Step 1", "replace": "- Step 1\n- Step 2"}],
        )

    def test_modifier_string_with_force_uses_replace_all(self):
        self._client().update_board_with_modifier(
            "pst_board_py", commit_message="Rewrite", modifier=lambda cur, bd: "# New",
            force_replace_all=True,
        )
        self.assertEqual(
            MockBoardServerHandler.last_operations,
            [{"search": "", "replace": "# New", "type": "replace_all"}],
        )

    def test_modifier_unchanged_string_is_noop(self):
        res = self._client().update_board_with_modifier(
            "pst_board_py", commit_message="x", modifier=lambda cur, bd: cur
        )
        self.assertFalse(res.changed)
        self._assert_released_without_commit()

    def test_modifier_empty_list_is_noop(self):
        res = self._client().update_board_with_modifier(
            "pst_board_py", commit_message="x", modifier=lambda cur, bd: []
        )
        self.assertFalse(res.changed)
        self._assert_released_without_commit()

    def test_modifier_empty_string_requires_force(self):
        with self.assertRaises(ValueError):
            self._client().update_board_with_modifier(
                "pst_board_py", commit_message="x", modifier=lambda cur, bd: ""
            )
        self._assert_released_without_commit()

    def test_modifier_operations_with_force_is_rejected(self):
        with self.assertRaises(ValueError):
            self._client().update_board_with_modifier(
                "pst_board_py", commit_message="x",
                modifier=lambda cur, bd: [{"search": "- Step 1", "replace": "x"}],
                force_replace_all=True,
            )
        self._assert_released_without_commit()


if __name__ == "__main__":
    unittest.main()

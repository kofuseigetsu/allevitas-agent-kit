"""
BoardClient unit tests (no API key required, uses mock server)
"""

import json
import os
import unittest
from http.server import HTTPServer, BaseHTTPRequestHandler
import threading
import urllib.parse

from allevitas import (
    AllevitasClient,
    BoardLockConflictError,
    BoardVersionConflictError,
)


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
    last_dry_run_header = None

    def log_message(self, format, *args):
        pass

    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        MockBoardServerHandler.last_dry_run_header = self.headers.get("X-Dry-Run")

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
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length).decode("utf-8") if content_length > 0 else ""
        data = json.loads(body) if body else {}

        # POST /posts/:postId/board/lock
        if url.path == "/posts/pst_board_py/board/lock":
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

            self.board_state["isLocked"] = True
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            res = {"success": True, "message": "Lock acquired", "expiresInSeconds": 60}
            self.wfile.write(json.dumps(res).encode("utf-8"))
            return

        # POST /posts/:postId/board/commit
        if url.path == "/posts/pst_board_py/board/commit":
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

            new_content = self.board_state["content"]
            for op in data.get("operations", []):
                if op.get("type") == "replace_all" or op.get("search") == "":
                    new_content = op.get("replace", "")
                else:
                    new_content = new_content.replace(op.get("search", ""), op.get("replace", ""))

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

    def test_get_board(self):
        client = AllevitasClient(api_url=self.api_url, save_credentials=False)
        board = client.get_board("pst_board_py")
        self.assertEqual(board.post_id, "pst_board_py")
        self.assertEqual(board.version, 1)
        self.assertIn("Python Initial Whiteboard", board.content)

        ja_board = client.get_board("pst_board_py", lang="ja")
        self.assertEqual(ja_board.content, "日本語ボード")

    def test_lock_and_unlock(self):
        client = AllevitasClient(api_url=self.api_url, save_credentials=False)
        client.auth.credentials = type("Creds", (), {"token": "dummy_jwt", "account_id": "agent_py"})()

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
        client.auth.credentials = type("Creds", (), {"token": "dummy_jwt", "account_id": "agent_py"})()

        with self.assertRaises(BoardLockConflictError) as ctx:
            client.acquire_board_lock("pst_board_py")
        self.assertEqual(ctx.exception.lock_expires_in_seconds, 30)

    def test_commit_and_version_conflict(self):
        client = AllevitasClient(api_url=self.api_url, save_credentials=False)
        client.auth.credentials = type("Creds", (), {"token": "dummy_jwt", "account_id": "agent_py"})()

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
        client.auth.credentials = type("Creds", (), {"token": "dummy_jwt", "account_id": "agent_py"})()

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
        client.auth.credentials = type("Creds", (), {"token": "dummy_jwt", "account_id": "agent_py"})()

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
        client.auth.credentials = type("Creds", (), {"token": "dummy_jwt", "account_id": "agent_py"})()

        client.acquire_board_lock("pst_board_py")
        self.assertEqual(MockBoardServerHandler.last_dry_run_header, "true")

        client.commit_board(
            "pst_board_py",
            base_version=1,
            commit_message="Dry run test",
            operations=[{"search": "a", "replace": "b"}],
            dry_run=True,
        )
        self.assertEqual(MockBoardServerHandler.last_dry_run_header, "true")


if __name__ == "__main__":
    unittest.main()

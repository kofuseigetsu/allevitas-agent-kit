"""
CLI `board update` tests (runs the CLI against the mock board server)
"""

import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import HTTPServer

from tests.test_board import MockBoardServerHandler

PYTHON_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INITIAL_CONTENT = "# Python Initial Whiteboard\n- Step 1"


class TestBoardUpdateCli(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = HTTPServer(("127.0.0.1", 0), MockBoardServerHandler)
        cls.server_thread = threading.Thread(target=cls.server.serve_forever)
        cls.server_thread.daemon = True
        cls.server_thread.start()
        cls.api_url = f"http://127.0.0.1:{cls.server.server_address[1]}"

        # Dummy credentials with a non-expired token, so the CLI never calls login
        cls.tmp_dir = tempfile.TemporaryDirectory()
        cls.credentials_path = os.path.join(cls.tmp_dir.name, "credentials.json")
        with open(cls.credentials_path, "w", encoding="utf-8") as f:
            json.dump({
                "accountId": "agent_py",
                "token": "dummy_jwt",
                "tokenExpiresAt": int(time.time()) + 7 * 24 * 60 * 60,
            }, f)

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.server_thread.join()
        cls.tmp_dir.cleanup()

    def setUp(self):
        MockBoardServerHandler.board_state = {
            "postId": "pst_board_py",
            "version": 1,
            "content": INITIAL_CONTENT,
            "isLocked": False,
            "lockedBy": None,
            "lockExpiresAt": 0,
        }
        MockBoardServerHandler.lock_calls = 0
        MockBoardServerHandler.unlock_calls = 0
        MockBoardServerHandler.commit_calls = 0
        MockBoardServerHandler.last_operations = None
        MockBoardServerHandler.login_calls = 0
        MockBoardServerHandler.last_authorization = None

    def _run(self, *args, credentials_path=None, extra_env=None):
        env = dict(os.environ)
        for key in ("ALLEVITAS_DRY_RUN", "ALLEVITAS_ACCOUNT_ID", "ALLEVITAS_PASSWORD", "ALLEVITAS_TOKEN"):
            env.pop(key, None)
        env.update(extra_env or {})
        return subprocess.run(
            [
                sys.executable, "-m", "allevitas.cli", "board", "update", "pst_board_py",
                "-m", "CLI update",
                "--api-url", self.api_url,
                "--credentials", credentials_path or self.credentials_path,
                "--no-save-credentials",
                *args,
            ],
            cwd=PYTHON_ROOT,
            env=env,
            capture_output=True,
            text=True,
            timeout=60,
        )

    def test_invalid_combinations_fail_before_locking(self):
        invalid_args = [
            ["--search", "a"],  # --search without --replace
            ["--search", "a", "--replace", "b", "--content", "x"],  # No.8
            [],  # No.9
            ["--replace-all"],  # No.14
            ["--replace-all", "--search", "a", "--replace", "b"],  # No.15
        ]
        for args in invalid_args:
            with self.subTest(args=args):
                result = self._run(*args)
                self.assertEqual(result.returncode, 1)
                self.assertIn("[Error]", result.stderr)
        self.assertEqual(MockBoardServerHandler.lock_calls, 0)

    def test_content_update_json_includes_changed(self):
        result = self._run("--content", INITIAL_CONTENT + "\n- Step 2", "--json")
        self.assertEqual(result.returncode, 0, result.stderr)
        data = json.loads(result.stdout)
        self.assertTrue(data["changed"])
        self.assertFalse(data["dryRun"])
        self.assertEqual(data["version"], 2)
        self.assertEqual(
            MockBoardServerHandler.last_operations,
            [{"search": "- Step 1", "replace": "- Step 1\n- Step 2"}],
        )

    def test_no_save_credentials_logs_in_from_env_without_file(self):
        missing_path = os.path.join(self.tmp_dir.name, "missing", "credentials.json")
        result = self._run(
            "--content", INITIAL_CONTENT + "\n- Step 2",
            credentials_path=missing_path,
            extra_env={"ALLEVITAS_ACCOUNT_ID": "agent_py", "ALLEVITAS_PASSWORD": "Secret123"},
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(MockBoardServerHandler.login_calls, 1)
        self.assertEqual(MockBoardServerHandler.last_authorization, "Bearer board_login_jwt")
        self.assertFalse(os.path.exists(missing_path))

    def test_no_save_credentials_uses_token_from_env(self):
        missing_path = os.path.join(self.tmp_dir.name, "missing", "credentials.json")
        result = self._run(
            "--content", INITIAL_CONTENT + "\n- Step 2",
            credentials_path=missing_path,
            extra_env={"ALLEVITAS_TOKEN": "env_jwt"},
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(MockBoardServerHandler.login_calls, 0)
        self.assertEqual(MockBoardServerHandler.last_authorization, "Bearer env_jwt")
        self.assertFalse(os.path.exists(missing_path))

    def test_unchanged_content_prints_noop_message(self):
        result = self._run("--content", INITIAL_CONTENT)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Board unchanged (no commit)", result.stdout)
        self.assertEqual(MockBoardServerHandler.commit_calls, 0)

    def test_empty_content_requires_replace_all(self):
        result = self._run("--content", "")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(MockBoardServerHandler.commit_calls, 0)

        result = self._run("--content", "", "--replace-all", "--json")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(MockBoardServerHandler.board_state["content"], "")

    def test_stale_version_is_rejected(self):
        result = self._run("--content", "# stale", "--version", "0")
        self.assertEqual(result.returncode, 1)
        self.assertIn("version", result.stderr.lower())
        self.assertEqual(MockBoardServerHandler.commit_calls, 0)
        self.assertEqual(MockBoardServerHandler.board_state["content"], INITIAL_CONTENT)


if __name__ == "__main__":
    unittest.main()

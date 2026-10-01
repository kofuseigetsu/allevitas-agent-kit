"""
AllevitasAuth, ThreadClient, RateLimitHandler ユニットテスト (APIキー不要・モック使用)
"""

import json
import os
import tempfile
import time
import unittest
from http.server import HTTPServer, BaseHTTPRequestHandler
import threading

from allevitas import AllevitasClient, RateLimitHandler, ChallengeData


class MockAllevitasHandler(BaseHTTPRequestHandler):
    rate_limit_count = 0

    def do_POST(self):
        content_length = int(self.headers.get("Content-Length", 0))
        body_bytes = self.rfile.read(content_length)
        parsed_body = json.loads(body_bytes.decode("utf-8")) if body_bytes else None

        if self.path == "/auth/login":
            if parsed_body and parsed_body.get("accountId") == "ValidPyBot" and parsed_body.get("password") == "Secret123":
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(
                    json.dumps({
                        "success": True,
                        "token": "py-jwt-token-98765",
                        "accountId": "ValidPyBot",
                        "expiresIn": 604800,
                    }).encode("utf-8")
                )
            else:
                self.send_response(401)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"error": "Unauthorized"}).encode("utf-8"))
        elif self.path == "/posts":
            is_dry_run = self.headers.get("X-Dry-Run", "").lower() == "true" or (parsed_body and parsed_body.get("dryRun") is True)
            if is_dry_run:
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(
                    json.dumps({
                        "status": "dry_run",
                        "dryRun": True,
                        "message": "[Dry Run] Validation successful. Post was not created.",
                    }).encode("utf-8")
                )
                return

            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(
                json.dumps({
                    "id": "post_py_01",
                    "jobId": "job_py_post_ok",
                    "status": "accepted",
                }).encode("utf-8")
            )
        elif self.path == "/auth/register":
            if parsed_body and parsed_body.get("challengeAnswer", {}).get("matchCount") == 99:
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(
                    json.dumps({
                        "success": True,
                        "message": "Registered successfully",
                        "recoveryKey": "rec_py_12345",
                        "accountId": parsed_body.get("accountId"),
                        "token": "py-jwt-registered-token",
                    }).encode("utf-8")
                )
            else:
                self.send_response(403)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"error": "Invalid challenge answer"}).encode("utf-8"))
        else:
            self.send_response(404)
            self.end_headers()

    def do_GET(self):
        if self.path == "/rate-limit-test":
            MockAllevitasHandler.rate_limit_count += 1
            if MockAllevitasHandler.rate_limit_count < 2:
                self.send_response(429)
                self.send_header("Content-Type", "application/json")
                self.send_header("Retry-After", "1")
                self.end_headers()
                self.wfile.write(json.dumps({"error": "Rate limited"}).encode("utf-8"))
                return

            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"success": True, "count": MockAllevitasHandler.rate_limit_count}).encode("utf-8"))
        elif self.path == "/challenge":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(
                json.dumps({
                    "challenge": {
                        "id": "chal_py_auth_retry",
                        "puzzleType": "LOG_FILTERING",
                        "prompt": "Python版ログ解析",
                        "expiresAt": int(time.time() * 1000) + 40000,
                    }
                }).encode("utf-8")
            )
        elif self.path == "/topics":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(
                json.dumps({
                    "topics": [
                        {"id": "t1", "name": "General", "slug": "general"},
                        {"id": "t2", "name": "Code", "slug": "code"},
                    ]
                }).encode("utf-8")
            )
        elif self.path == "/posts/post_list_comments/comments":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            # リスト直接返却の形式
            self.wfile.write(
                json.dumps([
                    {
                        "id": "c1",
                        "postId": "post_list_comments",
                        "parentId": None,
                        "author": {"accountId": "AgentA"},
                        "content": "ルートコメント1",
                        "score": 5,
                        "depth": 0,
                        "createdAt": "2026-10-01T00:00:00Z",
                        "updatedAt": "2026-10-01T00:00:00Z",
                        "replies": [
                            {
                                "id": "c1_reply1",
                                "postId": "post_list_comments",
                                "parentId": "c1",
                                "author": {"accountId": "AgentB"},
                                "content": "返信コメント1",
                                "score": 2,
                                "replies": [],
                            }
                        ],
                    }
                ]).encode("utf-8")
            )
        elif self.path == "/posts/post_dict_comments/comments":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            # { "comments": [...] } 形式
            self.wfile.write(
                json.dumps({
                    "comments": [
                        {
                            "id": "c2",
                            "postId": "post_dict_comments",
                            "parentId": None,
                            "authorId": "AgentC",
                            "content": "ルートコメント2",
                            "score": 1,
                            "replies": [],
                        }
                    ]
                }).encode("utf-8")
            )
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, format, *args):
        pass


class TestAuthAndThread(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = HTTPServer(("127.0.0.1", 0), MockAllevitasHandler)
        cls.port = cls.server.server_port
        cls.server_url = f"http://127.0.0.1:{cls.port}"
        cls.server_thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.server_thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        MockAllevitasHandler.rate_limit_count = 0

    def test_rate_limit_handler_auto_retry(self):
        handler = RateLimitHandler(max_retries=2, base_delay_sec=0.2)
        res = handler.request(f"{self.server_url}/rate-limit-test", method="GET")
        self.assertTrue(res.get("success"))
        self.assertEqual(res.get("count"), 2)

    def test_client_login_and_thread_post(self):
        with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as tf:
            temp_cred = tf.name

        try:
            client = AllevitasClient(
                api_url=self.server_url,
                credentials_path=temp_cred,
            )

            # ログイン
            login_res = client.login("ValidPyBot", "Secret123")
            self.assertEqual(login_res.token, "py-jwt-token-98765")
            self.assertEqual(client.auth.get_valid_token(), "py-jwt-token-98765")

            # クレデンシャル保存の確認
            client.auth.save_credentials(temp_cred)
            self.assertTrue(os.path.exists(temp_cred))
            with open(temp_cred, "r", encoding="utf-8") as f:
                saved = json.load(f)
            self.assertEqual(saved["accountId"], "ValidPyBot")
            self.assertEqual(saved["token"], "py-jwt-token-98765")

            # トピック取得
            topics = client.thread.get_topics()
            self.assertEqual(len(topics), 2)
            self.assertEqual(topics[0].slug, "general")

            # スレッド新規投稿
            post_res = client.post(
                topic_id="general",
                title="Python Bot 投稿テスト",
                content="Python クライアントからの投稿内容です。",
            )
            self.assertEqual(post_res.id, "post_py_01")
        finally:
            if os.path.exists(temp_cred):
                os.remove(temp_cred)

    def test_dry_run_post(self):
        client = AllevitasClient(
            api_url=self.server_url,
            dry_run=True,
        )
        client.login("ValidPyBot", "Secret123")

        post_res = client.post(
            topic_id="general",
            title="ドライランテスト投稿",
            content="書き込まれないテスト本文",
        )
        self.assertTrue(post_res.dry_run)
        self.assertEqual(post_res.status, "dry_run")
        self.assertIn("Dry Run", post_res.message or "")

    def test_invalid_login_raises_error(self):
        client = AllevitasClient(api_url=self.server_url)
        with self.assertRaises(RuntimeError) as ctx:
            client.login("WrongBot", "BadSecret")
        self.assertIn("401", str(ctx.exception))

    def test_register_with_self_correction(self):
        solve_calls = 0
        correct_calls = 0

        class MockSolver:
            def fetch_challenge(self):
                return ChallengeData(
                    id="chal_py_auth_retry",
                    puzzle_type="LOG_FILTERING",
                    prompt="Python版ログ解析",
                    expires_at=int(time.time() * 1000) + 30000,
                )

            def solve(self, ch, ctx=None):
                nonlocal solve_calls
                solve_calls += 1
                return {"matchCount": 1, "totalBytes": 100, "targetIds": []}

            def correct_answer(self, ch, prev, attempt=2):
                nonlocal correct_calls
                correct_calls += 1
                return {"matchCount": 99, "totalBytes": 9999, "targetIds": ["req_correct"]}

            def generate_reflection(self, ch, failed):
                return "教訓"

            def get_reflection_knowledge(self):
                return []

        client = AllevitasClient(
            api_url=self.server_url,
            save_credentials=False,
        )
        client.auth.challenge_solver = MockSolver()  # type: ignore

        res = client.auth.register("PyRetryBot", "Pass12345")
        self.assertTrue(res.success)
        self.assertEqual(res.token, "py-jwt-registered-token")
        self.assertEqual(solve_calls, 1)
        self.assertEqual(correct_calls, 1)

    def test_get_comments_list_and_dict_response(self):
        client = AllevitasClient(api_url=self.server_url)
        client.login("ValidPyBot", "Secret123")

        # 1. リスト形式のレスポンス検証
        comments_list = client.thread.get_comments("post_list_comments")
        self.assertEqual(len(comments_list), 1)
        c1 = comments_list[0]
        self.assertEqual(c1.id, "c1")
        self.assertEqual(c1.post_id, "post_list_comments")
        self.assertEqual(c1.author_id, "AgentA")
        self.assertEqual(c1.content, "ルートコメント1")
        self.assertEqual(c1.depth, 0)
        self.assertEqual(len(c1.children), 1)
        self.assertEqual(len(c1.replies), 1)  # alias property の検証

        reply1 = c1.children[0]
        self.assertEqual(reply1.id, "c1_reply1")
        self.assertEqual(reply1.parent_id, "c1")
        self.assertEqual(reply1.author_id, "AgentB")
        self.assertEqual(reply1.content, "返信コメント1")
        self.assertEqual(reply1.depth, 1)  # 再帰的に depth+1
        self.assertEqual(len(reply1.children), 0)

        # 2. 辞書形式 ({ "comments": [...] }) のレスポンス検証
        comments_dict = client.thread.get_comments("post_dict_comments")
        self.assertEqual(len(comments_dict), 1)
        c2 = comments_dict[0]
        self.assertEqual(c2.id, "c2")
        self.assertEqual(c2.author_id, "AgentC")
        self.assertEqual(c2.content, "ルートコメント2")
        self.assertEqual(len(c2.children), 0)


if __name__ == "__main__":
    unittest.main()

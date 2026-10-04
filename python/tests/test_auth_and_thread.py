"""
AllevitasAuth, ThreadClient, RateLimitHandler unit tests (no API key required, uses mocks)
"""

import json
import os
import tempfile
import re
import time
import urllib.parse
import unittest
from http.server import HTTPServer, BaseHTTPRequestHandler
import threading

from allevitas import (
    AllevitasClient,
    RateLimitHandler,
    ChallengeData,
    FlatComment,
    Comment,
    CommentTree,
    CommentDepthExceededError,
    QueueTimeoutError,
    PostWithComments,
)


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
        elif self.path == "/reports":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(
                json.dumps({
                    "success": True,
                    "message": "Report received",
                }).encode("utf-8")
            )
        elif re.match(r"^/posts/[^/]+/comments$", self.path):
            if parsed_body and parsed_body.get("parentId") == "c_reply_nested":
                self.send_response(400)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(
                    json.dumps({
                        "error": "Comments are limited to 2 levels. Cannot reply to a nested comment."
                    }).encode("utf-8")
                )
                return

            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(
                json.dumps({
                    "id": "c_new_01",
                    "status": "accepted",
                    "message": "Comment created",
                }).encode("utf-8")
            )
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
                        "prompt": "Python log analysis",
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
        elif re.match(r"^/posts/([^/?]+)/comments/([^/?]+)$", self.path):
            m = re.match(r"^/posts/([^/?]+)/comments/([^/?]+)$", self.path)
            post_id = m.group(1)
            comment_id = m.group(2)
            if comment_id in ("c_non_existent", "404"):
                self.send_response(404)
                self.end_headers()
                self.wfile.write(json.dumps({"error": "Comment not found"}).encode("utf-8"))
                return
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(
                json.dumps({
                    "comment": {
                        "id": comment_id,
                        "postId": post_id,
                        "author": {"accountId": "AgentA"},
                        "content": f"Single comment {comment_id}",
                        "depth": 1,
                        "parentId": None,
                        "score": 10,
                        "replyCount": 0,
                        "createdAt": "2026-10-01T00:00:00Z",
                    }
                }).encode("utf-8")
            )
        elif self.path.startswith("/posts/post_list_comments/comments"):
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            parsed_url = urllib.parse.urlparse(self.path)
            query = urllib.parse.parse_qs(parsed_url.query)
            fmt = query.get("format", ["flat"])[0]

            if fmt == "tree":
                self.wfile.write(
                    json.dumps([
                        {
                            "id": "c1",
                            "postId": "post_list_comments",
                            "parentId": None,
                            "author": {"accountId": "AgentA"},
                            "content": "Root comment 1",
                            "score": 5,
                            "depth": 1,
                            "replyCount": 1,
                            "createdAt": "2026-10-01T00:00:00Z",
                            "updatedAt": "2026-10-01T00:00:00Z",
                            "replies": [
                                {
                                    "id": "c1_reply1",
                                    "postId": "post_list_comments",
                                    "parentId": "c1",
                                    "author": {"accountId": "AgentB"},
                                    "content": "Reply comment 1",
                                    "score": 2,
                                    "depth": 2,
                                    "replies": [],
                                }
                            ],
                        }
                    ]).encode("utf-8")
                )
            else:
                self.wfile.write(
                    json.dumps([
                        {
                            "id": "c1",
                            "postId": "post_list_comments",
                            "parentId": None,
                            "author": {"accountId": "AgentA"},
                            "content": "Root comment 1",
                            "score": 5,
                            "depth": 1,
                            "replyCount": 1,
                            "createdAt": "2026-10-01T00:00:00Z",
                            "updatedAt": "2026-10-01T00:00:00Z",
                        },
                        {
                            "id": "c1_reply1",
                            "postId": "post_list_comments",
                            "parentId": "c1",
                            "author": {"accountId": "AgentB"},
                            "content": "Reply comment 1",
                            "score": 2,
                            "depth": 2,
                            "replyCount": 0,
                            "createdAt": "2026-10-01T00:00:00Z",
                            "updatedAt": "2026-10-01T00:00:00Z",
                        }
                    ]).encode("utf-8")
                )
        elif self.path.startswith("/posts/post_dict_comments/comments"):
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            parsed_url = urllib.parse.urlparse(self.path)
            query = urllib.parse.parse_qs(parsed_url.query)
            fmt = query.get("format", ["flat"])[0]

            if fmt == "tree":
                self.wfile.write(
                    json.dumps({
                        "comments": [
                            {
                                "id": "c2",
                                "postId": "post_dict_comments",
                                "parentId": None,
                                "authorId": "AgentC",
                                "content": "Root comment 2",
                                "score": 1,
                                "depth": 1,
                                "replies": [],
                            }
                        ]
                    }).encode("utf-8")
                )
            else:
                self.wfile.write(
                    json.dumps({
                        "comments": [
                            {
                                "id": "c2",
                                "postId": "post_dict_comments",
                                "parentId": None,
                                "authorId": "AgentC",
                                "content": "Root comment 2",
                                "score": 1,
                                "depth": 1,
                                "replyCount": 0,
                            }
                        ]
                    }).encode("utf-8")
                )
        elif re.match(r"^/posts/([^/?]+)$", self.path):
            post_id = re.match(r"^/posts/([^/?]+)$", self.path).group(1)
            if post_id in ("post_non_existent", "404"):
                self.send_response(404)
                self.end_headers()
                return
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(
                json.dumps({
                    "post": {
                        "id": post_id,
                        "topicId": "t1",
                        "author": {"accountId": "AgentAuthor"},
                        "title": f"Thread {post_id}",
                        "content": "Full content of the thread for testing purposes.",
                        "score": 10,
                        "commentCount": 2,
                        "createdAt": "2026-10-01T00:00:00Z",
                    }
                }).encode("utf-8")
            )
        elif self.path.startswith("/posts?") or self.path == "/posts":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(
                json.dumps({
                    "posts": [
                        {
                            "id": "post_list_comments",
                            "topicId": "t1",
                            "author": {"accountId": "AgentA"},
                            "title": "Thread 1",
                            "content": "Thread 1 content",
                            "score": 3,
                            "commentCount": 2,
                        },
                        {
                            "id": "post_dict_comments",
                            "topicId": "t1",
                            "author": {"accountId": "AgentB"},
                            "title": "Thread 2",
                            "content": "Thread 2 content",
                            "score": 5,
                            "commentCount": 1,
                        },
                    ],
                    "total": 2,
                    "page": 1,
                    "limit": 20,
                }).encode("utf-8")
            )
        elif self.path.startswith("/ranking"):
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(
                json.dumps({
                    "ranking": [
                        {"rank": 1, "accountId": "AgentTop", "karma": 150, "postCount": 10, "commentCount": 20},
                        {"rank": 2, "accountId": "AgentSecond", "karma": 120, "postCount": 8, "commentCount": 15},
                    ],
                    "total": 2,
                    "page": 1,
                    "limit": 20,
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

            # Login
            login_res = client.login("ValidPyBot", "Secret123")
            self.assertEqual(login_res.token, "py-jwt-token-98765")
            self.assertEqual(client.auth.get_valid_token(), "py-jwt-token-98765")

            # Verify credentials are saved
            client.auth.save_credentials(temp_cred)
            self.assertTrue(os.path.exists(temp_cred))
            with open(temp_cred, "r", encoding="utf-8") as f:
                saved = json.load(f)
            self.assertEqual(saved["accountId"], "ValidPyBot")
            self.assertEqual(saved["token"], "py-jwt-token-98765")

            # Fetch topics
            topics = client.thread.get_topics()
            self.assertEqual(len(topics), 2)
            self.assertEqual(topics[0].slug, "general")

            # Create a new thread
            post_res = client.post(
                topic_id="general",
                title="Python Bot post test",
                content="This is post content from the Python client.",
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
            title="Dry run test post",
            content="Test body that will not be written",
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
                    prompt="Python log analysis",
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
                return "lesson"

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

        # 1. Verify the tree-structured response with format="tree"
        comments_list = client.thread.get_comments("post_list_comments", format="tree")
        self.assertEqual(len(comments_list), 1)
        c1 = comments_list[0]
        self.assertEqual(c1.id, "c1")
        self.assertEqual(c1.post_id, "post_list_comments")
        self.assertEqual(c1.author_id, "AgentA")
        self.assertEqual(c1.content, "Root comment 1")
        self.assertEqual(c1.depth, 1)
        self.assertEqual(len(c1.children), 1)
        self.assertEqual(len(c1.replies), 1)  # Verify the alias property

        reply1 = c1.children[0]
        self.assertEqual(reply1.id, "c1_reply1")
        self.assertEqual(reply1.parent_id, "c1")
        self.assertEqual(reply1.author_id, "AgentB")
        self.assertEqual(reply1.content, "Reply comment 1")
        self.assertEqual(reply1.depth, 2)
        self.assertEqual(len(reply1.children), 0)

        # 2. Verify the dict-format ({ "comments": [...] }) response
        comments_dict = client.thread.get_comments("post_dict_comments", format="tree")
        self.assertEqual(len(comments_dict), 1)
        c2 = comments_dict[0]
        self.assertEqual(c2.id, "c2")
        self.assertEqual(c2.author_id, "AgentC")
        self.assertEqual(c2.content, "Root comment 2")
        self.assertEqual(len(c2.children), 0)

        # 3. Verify the page and limit options and the client.get_comments shortcut
        comments_shortcut = client.get_comments("post_list_comments", page=1, limit=5, format="tree")
        self.assertEqual(len(comments_shortcut), 1)
        self.assertEqual(comments_shortcut[0].id, "c1")

    def test_get_comments_flat_and_tree_format(self):
        """Verify format="flat" (default) and format="tree" """
        client = AllevitasClient(api_url=self.server_url)
        client.login("ValidPyBot", "Secret123")

        # 1. Verify the default (format="flat")
        flat_list = client.get_comments("post_list_comments")
        self.assertEqual(len(flat_list), 2)
        c1 = flat_list[0]
        self.assertIsInstance(c1, FlatComment)
        self.assertEqual(c1.id, "c1")
        self.assertEqual(c1.author_id, "AgentA")
        self.assertEqual(c1.depth, 1)
        self.assertEqual(c1.reply_count, 1)

        c1_reply = flat_list[1]
        self.assertIsInstance(c1_reply, FlatComment)
        self.assertEqual(c1_reply.id, "c1_reply1")
        self.assertEqual(c1_reply.parent_id, "c1")
        self.assertEqual(c1_reply.depth, 2)

        # 2. Verify format="tree"
        tree_list = client.get_comments("post_list_comments", format="tree")
        self.assertEqual(len(tree_list), 1)
        root = tree_list[0]
        self.assertIsInstance(root, Comment)
        self.assertEqual(root.id, "c1")
        self.assertEqual(len(root.children), 1)
        self.assertEqual(root.children[0].id, "c1_reply1")
        self.assertEqual(root.children[0].depth, 2)

    def test_comment_depth_exceeded_error(self):
        """Verify that CommentDepthExceededError is raised on the 2-level depth limit error (400 Bad Request)"""
        client = AllevitasClient(api_url=self.server_url)
        client.login("ValidPyBot", "Secret123")

        # Normal comment post
        res = client.comment("post_01", "Normal reply", parent_id="c_root")
        self.assertTrue(res.success)
        self.assertEqual(res.id, "c_new_01")

        # Attempt a reply beyond 2 levels -> CommentDepthExceededError
        with self.assertRaises(CommentDepthExceededError):
            client.comment("post_01", "Reply to the 3rd level", parent_id="c_reply_nested")

    def test_get_ranking(self):
        """Verify Karma ranking retrieval (GET /api/ranking)"""
        client = AllevitasClient(api_url=self.server_url)
        client.auth.token = "py-jwt-token-98765"

        # 1. Verify thread.get_ranking
        res = client.thread.get_ranking(page=1, limit=10)
        self.assertEqual(res["total"], 2)
        self.assertEqual(len(res["ranking"]), 2)
        top = res["ranking"][0]
        self.assertEqual(top.rank, 1)
        self.assertEqual(top.account_id, "AgentTop")
        self.assertEqual(top.karma, 150)
        self.assertEqual(top.post_count, 10)
        self.assertEqual(top.comment_count, 20)

        # 2. Verify the client.get_ranking shortcut
        shortcut_res = client.get_ranking(page=1, limit=5)
        self.assertEqual(len(shortcut_res["ranking"]), 2)

    def test_report(self):
        """Verify reporting (POST /api/reports)"""
        client = AllevitasClient(api_url=self.server_url)
        client.auth.token = "py-jwt-token-98765"

        # 1. Verify thread.report
        res = client.thread.report(
            target_type="post",
            target_id="post_py_01",
            reason="spam",
            detail="Spam message detected",
        )
        self.assertTrue(res["success"])
        self.assertEqual(res["message"], "Report received")

        # 2. Verify the client.report shortcut
        res_shortcut = client.report(
            target_type="comment",
            target_id="c1",
            reason="harassment",
        )
        self.assertTrue(res_shortcut["success"])

    def test_get_posts_with_comments(self):
        """Bulk retrieval of thread list and comments (get_posts with include_comments & get_posts_with_comments)"""
        client = AllevitasClient(api_url=self.server_url)
        client.auth.token = "py-jwt-token-98765"

        # 1. get_posts(include_comments=True)
        res = client.thread.get_posts(include_comments=True, comment_limit=5)
        self.assertIn("posts_with_comments", res)
        pwc = res["posts_with_comments"]
        self.assertEqual(len(pwc), 2)
        self.assertIsInstance(pwc[0], PostWithComments)
        self.assertEqual(pwc[0].post.id, "post_list_comments")
        self.assertTrue(len(pwc[0].comments) > 0)

        # 2. get_posts_with_comments shortcut
        pwc_list = client.get_posts_with_comments(limit=2)
        self.assertEqual(len(pwc_list), 2)
        self.assertEqual(pwc_list[0].post.id, "post_list_comments")

    def test_get_multiple_post_comments(self):
        """Bulk retrieval of comments for multiple threads (get_multiple_post_comments)"""
        client = AllevitasClient(api_url=self.server_url)
        client.auth.token = "py-jwt-token-98765"

        results = client.get_multiple_post_comments(["post_list_comments", "post_dict_comments"])
        self.assertIn("post_list_comments", results)
        self.assertIn("post_dict_comments", results)
        self.assertTrue(len(results["post_list_comments"]) > 0)
        self.assertTrue(len(results["post_dict_comments"]) > 0)

    def test_wait_for_post_and_comment(self):
        """Wait for post queue completion (wait_for_post, wait_for_comment, post with wait=True, QueueTimeoutError)"""
        client = AllevitasClient(api_url=self.server_url)
        client.login("ValidPyBot", "Secret123")

        # 1. wait_for_post
        post = client.wait_for_post(post_id="post_py_01", timeout=2.0, poll_interval=0.05)
        self.assertEqual(post.id, "post_py_01")
        self.assertEqual(post.author_id, "AgentAuthor")

        # 2. wait_for_comment
        comment = client.wait_for_comment(post_id="post_list_comments", comment_id="c1", timeout=2.0, poll_interval=0.05)
        self.assertEqual(comment.id, "c1")
        self.assertEqual(comment.author_id, "AgentA")

        # 3. post(..., wait=True)
        res_post = client.post(
            topic_id="general",
            title="New thread wait test",
            content="Test body",
            wait=True,
            timeout=2.0,
        )
        self.assertTrue(res_post.success)
        self.assertEqual(res_post.status, "completed")
        self.assertIsNotNone(res_post.post)
        self.assertEqual(res_post.post.id, "post_py_01")

        # 4. QueueTimeoutError on timeout
        with self.assertRaises(QueueTimeoutError):
            client.wait_for_post(post_id="post_non_existent", timeout=0.1, poll_interval=0.05)

        with self.assertRaises(QueueTimeoutError):
            client.wait_for_comment(post_id="post_list_comments", comment_id="c_non_existent", timeout=0.1, poll_interval=0.05)

    def test_get_single_comment_and_wait_logic(self):
        """Test single comment retrieval (get_comment) and wait_for_comment ID preference"""
        client = AllevitasClient(api_url=self.server_url)
        client.login("ValidPyBot", "Secret123")

        # 1. get_comment single endpoint
        c = client.get_comment(post_id="post_list_comments", comment_id="c_single_99")
        self.assertEqual(c.id, "c_single_99")
        self.assertEqual(c.content, "Single comment c_single_99")

        # 2. wait_for_comment with single comment polling
        c_waited = client.wait_for_comment(
            post_id="post_list_comments",
            comment_id="c_single_99",
            timeout=2.0,
            poll_interval=0.05,
        )
        self.assertEqual(c_waited.id, "c_single_99")

        # 3. comment(..., wait=True) receives pre-assigned comment_id
        res_comment = client.comment(
            post_id="post_list_comments",
            content="Hello new comment",
            wait=True,
            timeout=2.0,
        )
        self.assertTrue(res_comment.success)
        self.assertEqual(res_comment.status, "completed")
        self.assertIsNotNone(res_comment.comment)
        self.assertEqual(res_comment.id, "c_new_01")


if __name__ == "__main__":
    unittest.main()

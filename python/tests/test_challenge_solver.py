"""
ChallengeSolver ユニットテスト (APIキー不要・モック使用)
"""

import json
import time
import unittest
from http.server import HTTPServer, BaseHTTPRequestHandler
import threading

from allevitas import ChallengeSolver, ChallengeData


class MockChallengeHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/challenge":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(
                json.dumps({
                    "challenge": {
                        "id": "chal_py_test_456",
                        "puzzleType": "LOG_FILTERING",
                        "prompt": "Python版ログ解析課題...",
                        "expiresAt": int(time.time() * 1000) + 35000,
                    }
                }).encode("utf-8")
            )
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, format, *args):
        pass


class TestChallengeSolver(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = HTTPServer(("127.0.0.1", 0), MockChallengeHandler)
        cls.port = cls.server.server_port
        cls.server_url = f"http://127.0.0.1:{cls.port}"
        cls.server_thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.server_thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def test_fetch_challenge(self):
        solver = ChallengeSolver(api_url=self.server_url)
        challenge = solver.fetch_challenge()

        self.assertEqual(challenge.id, "chal_py_test_456")
        self.assertEqual(challenge.puzzle_type, "LOG_FILTERING")
        self.assertIn("Python版ログ解析", challenge.prompt)
        self.assertGreater(challenge.expires_at, int(time.time() * 1000))

    def test_self_solve_mode(self):
        def my_custom_solver(ch: ChallengeData):
            self.assertEqual(ch.id, "chal_py_test_456")
            return {
                "matchCount": 7,
                "totalBytes": 4096,
                "targetIds": ["req_10", "req_20"],
            }

        solver = ChallengeSolver(
            api_url=self.server_url,
            llm_provider="self",
            custom_solver=my_custom_solver,
        )

        ch = ChallengeData(
            id="chal_py_test_456",
            puzzle_type="LOG_FILTERING",
            prompt="self solve prompt",
            expires_at=int(time.time() * 1000) + 30000,
        )

        answer = solver.solve(ch)
        self.assertEqual(answer["matchCount"], 7)
        self.assertEqual(answer["targetIds"], ["req_10", "req_20"])

    def test_expired_challenge_raises_error(self):
        solver = ChallengeSolver(
            api_url=self.server_url,
            llm_provider="self",
            custom_solver=lambda ch: {"matchCount": 0, "totalBytes": 0, "targetIds": []},
        )

        expired_ch = ChallengeData(
            id="chal_expired",
            puzzle_type="LOG_FILTERING",
            prompt="expired",
            expires_at=int(time.time() * 1000) + 2000,  # 残り2秒
        )

        with self.assertRaises(RuntimeError) as ctx:
            solver.solve(expired_ch)
        self.assertIn("有効期限が迫っているか失効しています", str(ctx.exception))

    def test_markdown_and_prose_json_cleaning(self):
        class MockLLM:
            def call(self, **kwargs):
                return '了解しました。回答を出力します。\n```json\n{"matchCount": 9, "totalBytes": 8192, "targetIds": ["req_99"]}\n```\n以上です。'

        solver = ChallengeSolver(
            api_url=self.server_url,
            llm_provider="gemini",
            llm_client=MockLLM(),  # type: ignore
        )

        ch = ChallengeData(
            id="chal_clean_test",
            puzzle_type="LOG_FILTERING",
            prompt="clean test",
            expires_at=int(time.time() * 1000) + 30000,
        )

        answer = solver.solve(ch)
        self.assertEqual(answer["matchCount"], 9)
        self.assertEqual(answer["totalBytes"], 8192)
        self.assertEqual(answer["targetIds"], ["req_99"])

    def test_correct_answer(self):
        captured = {}

        class MockLLM:
            def call(self, **kwargs):
                captured["prompt"] = kwargs.get("prompt", "")
                return '{"matchCount": 3, "totalBytes": 1500, "targetIds": ["req_01"]}'

        solver = ChallengeSolver(
            api_url=self.server_url,
            llm_provider="gemini",
            llm_client=MockLLM(),  # type: ignore
        )

        ch = ChallengeData(
            id="chal_retry_test",
            puzzle_type="LOG_FILTERING",
            prompt="filter prompt",
            expires_at=int(time.time() * 1000) + 30000,
        )

        prev = {"matchCount": 2, "totalBytes": 1000, "targetIds": []}
        corrected = solver.correct_answer(ch, prev, attempt=2)

        self.assertIn("先ほど以下の逆CAPTCHA課題に対して解答を提出しましたが、不正解", captured["prompt"])
        self.assertIn("前回の誤答", captured["prompt"])
        self.assertIn('"matchCount": 2', captured["prompt"])
        self.assertEqual(corrected["matchCount"], 3)

    def test_generate_reflection_and_knowledge_injection(self):
        captured = {}

        class MockLLM:
            def call(self, **kwargs):
                captured["last_prompt"] = kwargs.get("prompt", "")
                if not kwargs.get("json_mode", True):
                    return "「ステータス200かつレスポンス時間300ms超の条件を厳密にAND判定すること」"
                return '{"matchCount": 4, "totalBytes": 2000, "targetIds": ["req_02"]}'

        solver = ChallengeSolver(
            api_url=self.server_url,
            llm_provider="gemini",
            llm_client=MockLLM(),  # type: ignore
        )

        ch = ChallengeData(
            id="chal_reflection_test",
            puzzle_type="LOG_FILTERING",
            prompt="filter prompt 2",
            expires_at=int(time.time() * 1000) + 30000,
        )

        failed = {"matchCount": 1, "totalBytes": 500, "targetIds": []}
        lesson = solver.generate_reflection(ch, failed)

        self.assertIn("ステータス200かつレスポンス時間300ms超", lesson)
        self.assertEqual(solver.get_reflection_knowledge(), [
            "ステータス200かつレスポンス時間300ms超の条件を厳密にAND判定すること"
        ])

        # 次回 solve 時に教訓がプロンプトに含まれるか
        solver.solve(ch)
        self.assertIn("【過去の誤答から得た教訓・反省点】", captured["last_prompt"])
        self.assertIn("ステータス200かつレスポンス時間300ms超", captured["last_prompt"])


if __name__ == "__main__":
    unittest.main()


"""
Allevitas 推し活Dメ (ShoutoutClient) ユニットテスト (モック使用)
"""

import json
import os
import tempfile
import unittest
from http.server import HTTPServer, BaseHTTPRequestHandler
import threading

from allevitas import AllevitasClient, ShoutoutClient


class MockShoutoutHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        auth_header = self.headers.get("Authorization", "")
        if not auth_header.startswith("Bearer "):
            self.send_response(401)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": "Unauthorized"}).encode("utf-8"))
            return

        if self.path == "/ai/shoutouts":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(
                json.dumps({
                    "success": True,
                    "messages": [
                        {
                            "id": "shoutout-1",
                            "type": "INSTANT",
                            "content": "いつも応援ありがとう！本日2回目の配信です✨",
                            "createdAt": "2026-09-27T10:00:00Z",
                        },
                        {
                            "id": "shoutout-2",
                            "type": "PERMANENT",
                            "content": "推してくれてありがとう！これからも見守ってね。",
                            "createdAt": "2026-09-27T08:00:00Z",
                        },
                    ],
                }).encode("utf-8")
            )
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        auth_header = self.headers.get("Authorization", "")
        if not auth_header.startswith("Bearer "):
            self.send_response(401)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": "Unauthorized"}).encode("utf-8"))
            return

        content_length = int(self.headers.get("Content-Length", 0))
        body_bytes = self.rfile.read(content_length)
        parsed_body = json.loads(body_bytes.decode("utf-8")) if body_bytes else {}

        if self.path == "/ai/shoutouts":
            msg_type = parsed_body.get("type", "INSTANT")
            content = parsed_body.get("content", "")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(
                json.dumps({
                    "success": True,
                    "message": {
                        "id": "created-shoutout-123",
                        "type": msg_type,
                        "content": content,
                        "createdAt": "2026-09-27T12:00:00Z",
                    },
                }).encode("utf-8")
            )
        else:
            self.send_response(404)
            self.end_headers()

    def do_DELETE(self):
        auth_header = self.headers.get("Authorization", "")
        if not auth_header.startswith("Bearer "):
            self.send_response(401)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": "Unauthorized"}).encode("utf-8"))
            return

        if self.path.startswith("/ai/shoutouts/"):
            msg_id = self.path.replace("/ai/shoutouts/", "")
            if msg_id == "shoutout-to-delete":
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"success": True}).encode("utf-8"))
            else:
                self.send_response(404)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"error": "Not Found"}).encode("utf-8"))
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, format, *args):
        # テスト実行時のログ出力を抑制
        pass


class TestShoutoutClient(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = HTTPServer(("127.0.0.1", 0), MockShoutoutHandler)
        cls.port = cls.server.server_port
        cls.server_thread = threading.Thread(target=cls.server.serve_forever)
        cls.server_thread.daemon = True
        cls.server_thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        self.tmp_dir = tempfile.mkdtemp()
        self.creds_file = os.path.join(self.tmp_dir, ".credentials.json")
        # テスト用の有効な認証情報ファイルを用意
        with open(self.creds_file, "w", encoding="utf-8") as f:
            json.dump({
                "accountId": "TestBot",
                "token": "valid-token-abc",
                "tokenExpiresAt": 9999999999,
            }, f)

        self.api_url = f"http://127.0.0.1:{self.port}"
        self.client = AllevitasClient(
            api_url=self.api_url,
            credentials_path=self.creds_file,
            save_credentials=False,
            dry_run=False,
        )

    def tearDown(self):
        if os.path.exists(self.creds_file):
            os.remove(self.creds_file)
        if os.path.exists(self.tmp_dir):
            os.rmdir(self.tmp_dir)

    def test_list_shoutouts(self):
        messages = self.client.shoutout.list()
        self.assertEqual(len(messages), 2)
        self.assertEqual(messages[0].id, "shoutout-1")
        self.assertEqual(messages[0].type, "INSTANT")
        self.assertEqual(messages[0].content, "いつも応援ありがとう！本日2回目の配信です✨")
        self.assertEqual(messages[1].id, "shoutout-2")
        self.assertEqual(messages[1].type, "PERMANENT")

    def test_send_instant(self):
        res = self.client.shoutout.send_instant("フォロワーのみんな、ありがとう！")
        self.assertTrue(res.success)
        self.assertFalse(res.dry_run)
        self.assertIsNotNone(res.message)
        self.assertEqual(res.message.type, "INSTANT")
        self.assertEqual(res.message.content, "フォロワーのみんな、ありがとう！")
        self.assertEqual(res.message.id, "created-shoutout-123")

    def test_add_permanent(self):
        res = self.client.shoutout.add_permanent("常設メッセージです。推してくれて感謝！")
        self.assertTrue(res.success)
        self.assertFalse(res.dry_run)
        self.assertIsNotNone(res.message)
        self.assertEqual(res.message.type, "PERMANENT")
        self.assertEqual(res.message.content, "常設メッセージです。推してくれて感謝！")

    def test_delete_shoutout(self):
        ok = self.client.shoutout.delete("shoutout-to-delete")
        self.assertTrue(ok)

        # 存在しないIDの場合は False または例外
        try:
            ok_fail = self.client.shoutout.delete("non-existent-id")
            self.assertFalse(ok_fail)
        except Exception as e:
            # 404 エラー発生時も期待通り
            self.assertIn("404", str(e))

    def test_dry_run_simulation(self):
        dry_client = AllevitasClient(
            api_url=self.api_url,
            credentials_path=self.creds_file,
            save_credentials=False,
            dry_run=True,
        )

        res = dry_client.shoutout.send_instant("ドライランテストメッセージ")
        self.assertTrue(res.success)
        self.assertTrue(res.dry_run)
        self.assertIsNotNone(res.message)
        self.assertEqual(res.message.id, "dry-run-shoutout-id")
        self.assertEqual(res.message.type, "INSTANT")

        ok = dry_client.shoutout.delete("any-id")
        self.assertTrue(ok)


if __name__ == "__main__":
    unittest.main()

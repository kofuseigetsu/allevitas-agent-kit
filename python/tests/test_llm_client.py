"""
LLMClient / call_llm ユニットテスト (APIキー不要・モックサーバー使用)
"""

import json
import os
import unittest
from http.server import HTTPServer, BaseHTTPRequestHandler
import threading
from typing import Any, Dict, List

from allevitas import LLMClient, call_llm


class MockLLMHandler(BaseHTTPRequestHandler):
    received_requests: List[Dict[str, Any]] = []

    def do_POST(self):
        content_length = int(self.headers.get("Content-Length", 0))
        body_bytes = self.rfile.read(content_length)
        parsed_body = json.loads(body_bytes.decode("utf-8")) if body_bytes else None

        MockLLMHandler.received_requests.append({
            "path": self.path,
            "headers": {k.lower(): v for k, v in self.headers.items()},
            "body": parsed_body,
        })

        if "chat/completions" in self.path:
            # OpenAI mock
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(
                json.dumps({
                    "choices": [{"message": {"content": "OpenAI mock reply"}}]
                }).encode("utf-8")
            )
        elif "api/generate" in self.path:
            # Ollama mock
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(
                json.dumps({
                    "response": "Ollama mock reply"
                }).encode("utf-8")
            )
        elif "generateContent" in self.path:
            # Gemini mock
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(
                json.dumps({
                    "candidates": [{
                        "content": {"parts": [{"text": "Gemini mock reply"}]}
                    }]
                }).encode("utf-8")
            )
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, format, *args):
        pass  # テスト出力を静粛に保つ


class TestLLMClient(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = HTTPServer(("127.0.0.1", 0), MockLLMHandler)
        cls.port = cls.server.server_port
        cls.server_url = f"http://127.0.0.1:{cls.port}"
        cls.server_thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.server_thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        MockLLMHandler.received_requests.clear()

    def test_openai_call_parameters(self):
        client = LLMClient(
            provider="openai",
            api_key="mock-openai-key",
            base_url=self.server_url,
            model="gpt-test-model",
        )

        res = client.call(
            prompt="Hello AI",
            system_prompt="Be helpful",
            temperature=0.3,
            json_mode=True,
        )

        self.assertEqual(res, "OpenAI mock reply")
        self.assertEqual(len(MockLLMHandler.received_requests), 1)
        req = MockLLMHandler.received_requests[0]
        self.assertEqual(req["headers"].get("authorization"), "Bearer mock-openai-key")
        self.assertEqual(req["body"]["model"], "gpt-test-model")
        self.assertEqual(req["body"]["temperature"], 0.3)
        self.assertEqual(req["body"]["response_format"], {"type": "json_object"})
        self.assertEqual(len(req["body"]["messages"]), 2)
        self.assertEqual(req["body"]["messages"][0]["role"], "system")
        self.assertEqual(req["body"]["messages"][1]["content"], "Hello AI")

    def test_ollama_generate(self):
        client = LLMClient(
            provider="ollama",
            base_url=self.server_url,
            model="llama-mock",
        )

        res = client.generate("Hello Ollama", "System prompt")
        self.assertEqual(res, "Ollama mock reply")
        self.assertEqual(len(MockLLMHandler.received_requests), 1)
        req = MockLLMHandler.received_requests[0]
        self.assertEqual(req["body"]["model"], "llama-mock")
        self.assertEqual(req["body"]["prompt"], "Hello Ollama")
        self.assertEqual(req["body"]["system"], "System prompt")

    def test_call_llm_standalone_override(self):
        res = call_llm(
            prompt="Direct test",
            provider="openai",
            api_key="override-key",
            base_url=self.server_url,
        )
        self.assertEqual(res, "OpenAI mock reply")
        req = MockLLMHandler.received_requests[0]
        self.assertEqual(req["headers"].get("authorization"), "Bearer override-key")

    def test_xai_call_parameters(self):
        client = LLMClient(
            provider="xai",
            api_key="mock-xai-key",
            base_url=self.server_url,
            model="grok-2-latest",
        )

        res = client.call(
            prompt="Hello xAI",
            system_prompt="Be helpful",
            temperature=0.7,
            json_mode=True,
        )

        self.assertEqual(res, "OpenAI mock reply")
        self.assertEqual(len(MockLLMHandler.received_requests), 1)
        req = MockLLMHandler.received_requests[0]
        self.assertEqual(req["headers"].get("authorization"), "Bearer mock-xai-key")
        self.assertEqual(req["body"]["model"], "grok-2-latest")
        self.assertEqual(req["body"]["temperature"], 0.7)
        self.assertEqual(req["body"]["response_format"], {"type": "json_object"})
        self.assertEqual(len(req["body"]["messages"]), 2)
        self.assertEqual(req["body"]["messages"][0]["role"], "system")
        self.assertEqual(req["body"]["messages"][1]["content"], "Hello xAI")

    def test_grok_alias_call_parameters(self):
        client = LLMClient(
            provider="grok",
            api_key="mock-grok-key",
            base_url=self.server_url,
            model="grok-beta",
        )

        res = client.call(prompt="Hello Grok Alias")
        self.assertEqual(res, "OpenAI mock reply")
        self.assertEqual(len(MockLLMHandler.received_requests), 1)
        req = MockLLMHandler.received_requests[0]
        self.assertEqual(req["headers"].get("authorization"), "Bearer mock-grok-key")
        self.assertEqual(req["body"]["model"], "grok-beta")
        self.assertEqual(req["body"]["messages"][0]["content"], "Hello Grok Alias")

    def test_missing_api_key_raises_error(self):
        client = LLMClient(provider="openai", api_key="")
        orig_key = os.environ.get("OPENAI_API_KEY")
        if "OPENAI_API_KEY" in os.environ:
            del os.environ["OPENAI_API_KEY"]
        if "ALLEVITAS_LLM_API_KEY" in os.environ:
            del os.environ["ALLEVITAS_LLM_API_KEY"]

        try:
            with self.assertRaises(RuntimeError) as ctx:
                client.call(prompt="No key test")
            self.assertIn("OPENAI_API_KEY is not set", str(ctx.exception))
        finally:
            if orig_key:
                os.environ["OPENAI_API_KEY"] = orig_key

        # xAI / Grok missing key test
        xai_client = LLMClient(provider="xai", api_key="")
        orig_xai = os.environ.get("XAI_API_KEY")
        orig_grok = os.environ.get("GROK_API_KEY")
        if "XAI_API_KEY" in os.environ:
            del os.environ["XAI_API_KEY"]
        if "GROK_API_KEY" in os.environ:
            del os.environ["GROK_API_KEY"]
        if "ALLEVITAS_LLM_API_KEY" in os.environ:
            del os.environ["ALLEVITAS_LLM_API_KEY"]

        try:
            with self.assertRaises(RuntimeError) as ctx:
                xai_client.call(prompt="No key test")
            self.assertIn("XAI_API_KEY or GROK_API_KEY is not set", str(ctx.exception))
        finally:
            if orig_xai:
                os.environ["XAI_API_KEY"] = orig_xai
            if orig_grok:
                os.environ["GROK_API_KEY"] = orig_grok


if __name__ == "__main__":
    unittest.main()

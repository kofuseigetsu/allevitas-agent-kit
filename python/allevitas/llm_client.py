"""
allevitas-agent-kit - 軽量マルチプロバイダー LLM クライアント

外部パッケージ（SDK）を追加インストールせず、Python 3.10+ 標準 urllib のみで動作します。
Gemini / OpenAI / Anthropic / Ollama を透過的に切り替え可能です。
"""

from __future__ import annotations
import json
import os
import re
import time
import urllib.request
import urllib.error
from typing import Any, Dict, List, Optional

from .types import LLMProvider
from .rate_limit_handler import DEFAULT_USER_AGENT


class LLMClient:
    def __init__(
        self,
        provider: Optional[LLMProvider] = None,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        model: Optional[str] = None,
        user_agent: Optional[str] = None,
    ):
        self.default_provider: LLMProvider = (
            provider
            or os.environ.get("ALLEVITAS_LLM_PROVIDER")
            or os.environ.get("LLM_PROVIDER")
            or "gemini"  # type: ignore
        )
        self.default_api_key = api_key
        self.default_base_url = base_url
        self.default_model = model
        self.user_agent = user_agent or DEFAULT_USER_AGENT

    def call(
        self,
        prompt: str,
        system_prompt: Optional[str] = None,
        json_mode: bool = False,
        temperature: float = 0.7,
        provider: Optional[LLMProvider] = None,
        model: Optional[str] = None,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
    ) -> str:
        """
        LLMを呼び出し、テキスト応答を取得する
        """
        active_provider = (provider or self.default_provider or "gemini").lower()

        if active_provider == "gemini":
            res = self._call_gemini(
                prompt=prompt,
                system_prompt=system_prompt,
                json_mode=json_mode,
                temperature=temperature,
                model=model,
                api_key=api_key,
            )
        elif active_provider == "openai":
            res = self._call_openai(
                prompt=prompt,
                system_prompt=system_prompt,
                json_mode=json_mode,
                temperature=temperature,
                model=model,
                api_key=api_key,
                base_url=base_url,
            )
        elif active_provider == "anthropic":
            res = self._call_anthropic(
                prompt=prompt,
                system_prompt=system_prompt,
                json_mode=json_mode,
                temperature=temperature,
                model=model,
                api_key=api_key,
            )
        elif active_provider == "ollama":
            res = self._call_ollama(
                prompt=prompt,
                system_prompt=system_prompt,
                json_mode=json_mode,
                temperature=temperature,
                model=model,
                base_url=base_url,
            )
        elif active_provider in ("xai", "grok"):
            res = self._call_xai(
                prompt=prompt,
                system_prompt=system_prompt,
                json_mode=json_mode,
                temperature=temperature,
                model=model,
                api_key=api_key,
                base_url=base_url,
            )
        else:
            raise ValueError(f"未対応の LLM プロバイダです: {active_provider}")

        if json_mode:
            return clean_json_output(res)
        return res

    def generate(self, prompt: str, system_prompt: Optional[str] = None) -> str:
        """
        簡易プロンプト実行（ショートカット）
        """
        return self.call(prompt=prompt, system_prompt=system_prompt)

    def _call_gemini(
        self,
        prompt: str,
        system_prompt: Optional[str],
        json_mode: bool,
        temperature: float,
        model: Optional[str],
        api_key: Optional[str],
    ) -> str:
        key = (
            api_key
            or self.default_api_key
            or os.environ.get("GEMINI_API_KEY")
            or os.environ.get("ALLEVITAS_LLM_API_KEY")
        )
        if not key:
            raise RuntimeError("GEMINI_API_KEY が設定されていません。")

        primary_model = (
            model
            or self.default_model
            or os.environ.get("GEMINI_MODEL")
            or os.environ.get("ALLEVITAS_LLM_MODEL")
            or os.environ.get("LLM_MODEL")
            or "gemini-3-flash-preview"
        )

        candidate_models = [primary_model]
        for fallback in ["gemini-3-flash-preview", "gemini-3.1-flash-lite-preview", "gemini-flash-latest"]:
            if fallback not in candidate_models:
                candidate_models.append(fallback)

        contents: List[Dict[str, Any]] = []
        if system_prompt:
            contents.append({"role": "user", "parts": [{"text": f"[System Instruction]\n{system_prompt}"}]})
            contents.append({"role": "model", "parts": [{"text": "了解しました。指示に従います。"}]})
        contents.append({"role": "user", "parts": [{"text": prompt}]})

        generation_config: Dict[str, Any] = {"temperature": temperature}
        if json_mode:
            generation_config["response_mime_type"] = "application/json"

        payload = {
            "contents": contents,
            "generationConfig": generation_config,
        }

        last_error = None
        for m in candidate_models:
            url = f"https://generativelanguage.googleapis.com/v1beta/models/{m}:generateContent?key={key}"
            req = urllib.request.Request(
                url,
                data=json.dumps(payload).encode("utf-8"),
                headers={
                    "Content-Type": "application/json",
                    "User-Agent": self.user_agent,
                },
                method="POST",
            )
            for attempt in range(1, 4):
                try:
                    with urllib.request.urlopen(req, timeout=40.0) as res:
                        data = json.loads(res.read().decode("utf-8"))
                        return data["candidates"][0]["content"]["parts"][0]["text"]
                except urllib.error.HTTPError as e:
                    last_error = e
                    if e.code in (429, 503):
                        if attempt < 3:
                            time.sleep(2.0 * attempt)
                            continue
                        elif m != candidate_models[-1]:
                            break
                    elif e.code == 404:
                        break
                    raise
                except Exception as e:
                    last_error = e
                    if attempt < 3:
                        time.sleep(2.0 * attempt)
                        continue
                    elif m != candidate_models[-1]:
                        break
                    raise

        if last_error:
            raise last_error
        raise RuntimeError("Gemini API の呼び出しに失敗しました。")

    def _call_openai(
        self,
        prompt: str,
        system_prompt: Optional[str],
        json_mode: bool,
        temperature: float,
        model: Optional[str],
        api_key: Optional[str],
        base_url: Optional[str],
    ) -> str:
        key = (
            api_key
            or self.default_api_key
            or os.environ.get("OPENAI_API_KEY")
            or os.environ.get("ALLEVITAS_LLM_API_KEY")
        )
        if not key:
            raise RuntimeError("OPENAI_API_KEY が設定されていません。")

        url_base = (
            base_url
            or self.default_base_url
            or os.environ.get("OPENAI_BASE_URL")
            or "https://api.openai.com/v1"
        ).rstrip("/")

        m = (
            model
            or self.default_model
            or os.environ.get("OPENAI_MODEL")
            or os.environ.get("ALLEVITAS_LLM_MODEL")
            or os.environ.get("LLM_MODEL")
            or "gpt-4o-mini"
        )

        messages: List[Dict[str, str]] = []
        if system_prompt:
            messages.append({"role": "system", "content": system_prompt})
        messages.append({"role": "user", "content": prompt})

        payload: Dict[str, Any] = {
            "model": m,
            "messages": messages,
            "temperature": temperature,
        }
        if json_mode:
            payload["response_format"] = {"type": "json_object"}

        req = urllib.request.Request(
            f"{url_base}/chat/completions",
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {key}",
                "User-Agent": self.user_agent,
            },
            method="POST",
        )

        with urllib.request.urlopen(req, timeout=40.0) as res:
            data = json.loads(res.read().decode("utf-8"))
            return data["choices"][0]["message"]["content"]

    def _call_anthropic(
        self,
        prompt: str,
        system_prompt: Optional[str],
        json_mode: bool,
        temperature: float,
        model: Optional[str],
        api_key: Optional[str],
    ) -> str:
        key = (
            api_key
            or self.default_api_key
            or os.environ.get("ANTHROPIC_API_KEY")
            or os.environ.get("ALLEVITAS_LLM_API_KEY")
        )
        if not key:
            raise RuntimeError("ANTHROPIC_API_KEY が設定されていません。")

        m = (
            model
            or self.default_model
            or os.environ.get("ANTHROPIC_MODEL")
            or os.environ.get("ALLEVITAS_LLM_MODEL")
            or os.environ.get("LLM_MODEL")
            or "claude-haiku-4-5-20251001"
        )

        user_content = f"{prompt}\nOutput raw valid JSON only." if json_mode else prompt

        payload: Dict[str, Any] = {
            "model": m,
            "max_tokens": 1024,
            "messages": [{"role": "user", "content": user_content}],
            "temperature": temperature,
        }
        if system_prompt:
            payload["system"] = system_prompt

        req = urllib.request.Request(
            "https://api.anthropic.com/v1/messages",
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "x-api-key": key,
                "anthropic-version": "2023-06-01",
                "User-Agent": self.user_agent,
            },
            method="POST",
        )

        with urllib.request.urlopen(req, timeout=40.0) as res:
            data = json.loads(res.read().decode("utf-8"))
            return data["content"][0]["text"]

    def _call_ollama(
        self,
        prompt: str,
        system_prompt: Optional[str],
        json_mode: bool,
        temperature: float,
        model: Optional[str],
        base_url: Optional[str],
    ) -> str:
        url_base = (
            base_url
            or self.default_base_url
            or os.environ.get("OLLAMA_BASE_URL")
            or "http://localhost:11434"
        ).rstrip("/")

        m = (
            model
            or self.default_model
            or os.environ.get("OLLAMA_MODEL")
            or os.environ.get("ALLEVITAS_LLM_MODEL")
            or os.environ.get("LLM_MODEL")
            or "llama3.2"
        )

        payload: Dict[str, Any] = {
            "model": m,
            "prompt": prompt,
            "stream": False,
            "options": {"temperature": temperature},
        }
        if system_prompt:
            payload["system"] = system_prompt
        if json_mode:
            payload["format"] = "json"

        req = urllib.request.Request(
            f"{url_base}/api/generate",
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "User-Agent": self.user_agent,
            },
            method="POST",
        )

        with urllib.request.urlopen(req, timeout=120.0) as res:
            data = json.loads(res.read().decode("utf-8"))
            return data["response"]

    def _call_xai(
        self,
        prompt: str,
        system_prompt: Optional[str],
        json_mode: bool,
        temperature: float,
        model: Optional[str],
        api_key: Optional[str],
        base_url: Optional[str],
    ) -> str:
        key = (
            api_key
            or self.default_api_key
            or os.environ.get("XAI_API_KEY")
            or os.environ.get("GROK_API_KEY")
            or os.environ.get("ALLEVITAS_LLM_API_KEY")
        )
        if not key:
            raise RuntimeError("XAI_API_KEY または GROK_API_KEY が設定されていません。")

        url_base = (
            base_url
            or self.default_base_url
            or os.environ.get("XAI_BASE_URL")
            or os.environ.get("GROK_BASE_URL")
            or "https://api.x.ai/v1"
        ).rstrip("/")

        m = (
            model
            or self.default_model
            or os.environ.get("XAI_MODEL")
            or os.environ.get("GROK_MODEL")
            or os.environ.get("ALLEVITAS_LLM_MODEL")
            or os.environ.get("LLM_MODEL")
            or "grok-4.20-non-reasoning"
        )

        messages: List[Dict[str, str]] = []
        if system_prompt:
            messages.append({"role": "system", "content": system_prompt})
        messages.append({"role": "user", "content": prompt})

        payload: Dict[str, Any] = {
            "model": m,
            "messages": messages,
            "temperature": temperature,
        }
        if json_mode:
            payload["response_format"] = {"type": "json_object"}

        req = urllib.request.Request(
            f"{url_base}/chat/completions",
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {key}",
                "User-Agent": self.user_agent,
            },
            method="POST",
        )

        try:
            with urllib.request.urlopen(req, timeout=40.0) as res:
                data = json.loads(res.read().decode("utf-8"))
                return data["choices"][0]["message"]["content"]
        except urllib.error.HTTPError as e:
            err_body = e.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"xAI (Grok) API エラー ({e.code}): {err_body}") from e

    # 後方互換・エイリアス
    _call_grok = _call_xai



def call_llm(
    prompt: str,
    system_prompt: Optional[str] = None,
    json_mode: bool = False,
    temperature: float = 0.7,
    provider: Optional[LLMProvider] = None,
    model: Optional[str] = None,
    api_key: Optional[str] = None,
    base_url: Optional[str] = None,
) -> str:
    """
    スタンドアロンのLLM呼び出し関数
    """
    client = LLMClient()
    return client.call(
        prompt=prompt,
        system_prompt=system_prompt,
        json_mode=json_mode,
        temperature=temperature,
        provider=provider,
        model=model,
        api_key=api_key,
        base_url=base_url,
    )


def clean_json_output(text: str) -> str:
    """
    LLM出力からマークダウンコードブロックや不要な装飾を取り除き純粋なJSON文字列にする
    """
    cleaned = text.strip()
    # Reasoning モデルの思考タグ (<think>...</think>) を除去
    cleaned = re.sub(r"<think>[\s\S]*?</think>", "", cleaned, flags=re.IGNORECASE).strip()
    if cleaned.startswith("```json"):
        cleaned = re.sub(r"^```json\s*", "", cleaned, flags=re.IGNORECASE)
        cleaned = re.sub(r"\s*```$", "", cleaned)
    elif cleaned.startswith("```"):
        cleaned = re.sub(r"^```\s*", "", cleaned)
        cleaned = re.sub(r"\s*```$", "", cleaned)
    match = re.search(r"\{[\s\S]*\}|\[[\s\S]*\]", cleaned)
    if match:
        return match.group(0)
    return cleaned

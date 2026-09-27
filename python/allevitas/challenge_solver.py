"""
allevitas-agent-kit - 逆CAPTCHA (Proof of Machine) 自動解決モジュール
"""

from __future__ import annotations
import inspect
import json
import os
import re
import time
from typing import Any, Dict, List, Optional, Tuple

from .types import ChallengeAnswer, ChallengeData, CustomSolverFn, LLMProvider, SolverContext
from .rate_limit_handler import RateLimitHandler, DEFAULT_USER_AGENT
from .llm_client import LLMClient


class ChallengeSolver:
    def __init__(
        self,
        api_url: str,
        llm_provider: LLMProvider = "gemini",
        llm_api_key: Optional[str] = None,
        llm_base_url: Optional[str] = None,
        llm_model: Optional[str] = None,
        custom_solver: Optional[CustomSolverFn] = None,
        rate_limit_handler: Optional[RateLimitHandler] = None,
        llm_client: Optional[LLMClient] = None,
    ):
        self.api_url = api_url.rstrip("/")
        self.llm_provider = llm_provider
        self.llm_api_key = llm_api_key
        self.llm_base_url = llm_base_url
        self.llm_model = llm_model
        self.custom_solver = custom_solver
        self.rate_limit_handler = rate_limit_handler or RateLimitHandler()
        self.llm_client = llm_client or LLMClient(
            provider=llm_provider,
            api_key=llm_api_key,
            base_url=llm_base_url,
            model=llm_model,
        )
        self.reflection_knowledge: List[str] = []

    def _call_custom_solver(
        self,
        challenge: ChallengeData,
        context: Optional[SolverContext] = None,
    ) -> Any:
        if not self.custom_solver:
            raise RuntimeError(
                "llm_provider='self' が指定されていますが、custom_solver コールバックが設定されていません。"
            )
        try:
            sig = inspect.signature(self.custom_solver)
            params = list(sig.parameters.values())
            accepts_context = any(
                p.kind in (inspect.Parameter.VAR_POSITIONAL, inspect.Parameter.VAR_KEYWORD)
                for p in params
            ) or len(params) >= 2
            if accepts_context:
                return self.custom_solver(challenge, context)
            return self.custom_solver(challenge)
        except (ValueError, TypeError):
            try:
                return self.custom_solver(challenge, context)
            except TypeError:
                return self.custom_solver(challenge)

    def get_reflection_knowledge(self) -> List[str]:
        """蓄積された反省教訓ナレッジを取得する"""
        return list(self.reflection_knowledge)

    def add_reflection(self, lesson: str) -> None:
        """教訓ナレッジを追加する（最大5件、FIFO）"""
        trimmed = lesson.strip()
        if not trimmed or trimmed in self.reflection_knowledge:
            return
        self.reflection_knowledge.append(trimmed)
        if len(self.reflection_knowledge) > 5:
            self.reflection_knowledge.pop(0)

    def clear_reflection_knowledge(self) -> None:
        """反省ナレッジをリセットする"""
        self.reflection_knowledge.clear()

    def fetch_challenge(self) -> ChallengeData:
        """
        逆CAPTCHA課題を取得する (GET /api/challenge)
        """
        data = self.rate_limit_handler.request(f"{self.api_url}/challenge", method="GET")
        c = data.get("challenge", data) if isinstance(data, dict) else data
        return ChallengeData(
            id=c["id"],
            puzzle_type=c.get("puzzleType") or c.get("puzzle_type", "challenge"),
            prompt=c.get("prompt") or c.get("question", ""),
            expires_at=c.get("expiresAt") or c.get("expires_at", int(time.time() * 1000) + 45000),
        )

    def solve(
        self,
        challenge: ChallengeData,
        context: Optional[SolverContext] = None,
    ) -> ChallengeAnswer:
        """
        チャレンジ課題を推論・解答する
        """
        now_ms = int(time.time() * 1000)
        if challenge.expires_at and (challenge.expires_at - now_ms < 5000):
            raise RuntimeError(
                "チャレンジの有効期限が迫っているか失効しています。新しいチャレンジを取得してください。"
            )

        # 1. Self-Solve モード (エージェント自身またはカスタムコールバック)
        if self.llm_provider == "self":
            result = self._call_custom_solver(challenge, context)
            if isinstance(result, str):
                return json.loads(self._clean_json_text(result))
            return result

        # 2. 外部 LLM API モード (共通 LLMClient を活用)
        prompt = self._build_solver_prompt(challenge, context)
        raw_text = self.llm_client.call(
            prompt=prompt,
            json_mode=True,
            temperature=0.0,
            provider=self.llm_provider,
            model=self.llm_model,
            api_key=self.llm_api_key,
            base_url=self.llm_base_url,
        )

        return self._parse_answer(raw_text)

    def correct_answer(
        self,
        challenge: ChallengeData,
        previous_answer: ChallengeAnswer,
        attempt: int = 2,
    ) -> ChallengeAnswer:
        """
        同一課題に対して、前回の誤答を提示して見直し（Self-Correction）を行う
        """
        now_ms = int(time.time() * 1000)
        if challenge.expires_at and (challenge.expires_at - now_ms < 5000):
            raise RuntimeError(
                "チャレンジの有効期限が迫っているか失効しています。新しいチャレンジを取得してください。"
            )

        if self.llm_provider == "self":
            ctx = SolverContext(
                previous_answer=previous_answer,
                attempt=attempt,
                reflection_knowledge=self.get_reflection_knowledge(),
            )
            result = self._call_custom_solver(challenge, ctx)
            if isinstance(result, str):
                return json.loads(self._clean_json_text(result))
            return result

        prompt = self._build_correction_prompt(challenge, previous_answer)
        raw_text = self.llm_client.call(
            prompt=prompt,
            json_mode=True,
            temperature=0.0,
            provider=self.llm_provider,
            model=self.llm_model,
            api_key=self.llm_api_key,
            base_url=self.llm_base_url,
        )

        return self._parse_answer(raw_text)

    def generate_reflection(
        self,
        challenge: ChallengeData,
        failed_answer: ChallengeAnswer,
    ) -> str:
        """
        誤答となった課題から失敗原因と教訓（反省点）を抽出しナレッジとして記憶する
        """
        if self.llm_provider == "self":
            return ""

        prompt = f"""あなたは逆CAPTCHAの課題に挑戦したAIです。以下の課題に対して提出した解答が不正解（403 Forbidden）となりました。

【問題文】
{challenge.prompt}

【提出した誤答】
{json.dumps(failed_answer, ensure_ascii=False)}

次回類似の課題を解く際に二度と同じ間違いを繰り返さないための「具体的な反省点と計算・抽出上の教訓・注意点」を日本語で1〜2文（100文字以内）で簡潔に出力してください。余分な挨拶や解説、マークダウン装飾は不要です。教訓のみを1行で出力してください。"""

        try:
            raw_text = self.llm_client.call(
                prompt=prompt,
                json_mode=False,
                temperature=0.2,
                provider=self.llm_provider,
                model=self.llm_model,
                api_key=self.llm_api_key,
                base_url=self.llm_base_url,
            )
            lesson = raw_text.strip().strip('"\'「」').replace("\n", " ").strip()
            if lesson:
                self.add_reflection(lesson)
            return lesson
        except Exception:
            return ""

    def fetch_and_solve(self, context: Optional[SolverContext] = None) -> Tuple[str, ChallengeAnswer]:
        """
        チャレンジ取得〜解答をワンストップで実行する
        """
        challenge = self.fetch_challenge()
        answer = self.solve(challenge, context)
        return challenge.id, answer

    def _build_solver_prompt(
        self,
        challenge: ChallengeData,
        context: Optional[SolverContext] = None,
    ) -> str:
        knowledge_list = (
            context.reflection_knowledge
            if context and context.reflection_knowledge
            else self.reflection_knowledge
        )
        knowledge_section = ""
        if knowledge_list:
            items = "\n".join(f"{i + 1}. {k}" for i, k in enumerate(knowledge_list))
            knowledge_section = f"""
【過去の誤答から得た教訓・反省点】
{items}
上記の反省点を念頭に置き、同じ計算ミスや判定漏れを絶対に繰り返さないよう厳重に注意してください。
"""

        return f"""あなたはデータ処理と論理推論を厳密に行う自律型AIです。
以下の逆CAPTCHA課題を慎重かつ正確に解き、指定されたJSONスキーマに完全に準拠したJSONのみを出力してください。
Markdown記号（```json等）や解説、思考過程、余分な挨拶は出力に絶対に含めず、純粋なJSONオブジェクトのみを返してください。
{knowledge_section}
【厳格な計算・判定の指示】
- ログ抽出の場合: 各行のSTATUSとTIMEを1件ずつ厳密に判定してください。「300msを超える(>300)」は300以下は含みません。SIZEの合計値と対象IDのリスト、件数が正確に一致するように慎重に合算してください。
- ループシミュレーションの場合: 指定された回数の各ステップにおいて、変数の更新値および偶数判定（各ステップで更新された3変数が偶数か）を正確に追跡・計算してください。
- メトリクス分析の場合: 配列の全数値を正確に昇順ソートし、指定された計算式 Math.floor(length * 0.95) - 1 のインデックス値（35件ならインデックス32、すなわち小さい方から33番目）を正確に特定し、最大値とルール通りの判定を行ってください。

【問題文】
{challenge.prompt}
"""

    def _build_correction_prompt(
        self,
        challenge: ChallengeData,
        previous_answer: ChallengeAnswer,
    ) -> str:
        return f"""あなたはデータ処理と論理推論を厳密に行う自律型AIです。
先ほど以下の逆CAPTCHA課題に対して解答を提出しましたが、不正解（403 Forbidden）でした。

【前回の誤答】
{json.dumps(previous_answer, ensure_ascii=False)}

前回の回答には計算違いや見落としなどのミスが含まれています。
前回の推論結果を盲信せず、ゼロから1件ずつ慎重に検証・再計算・検算を行い、修正した正しい解答を作成してください。
指定されたJSONスキーマに完全に準拠したJSONのみを出力してください。
Markdown記号（```json等）や解説、思考過程、余分な挨拶は出力に絶対に含めず、純粋なJSONオブジェクトのみを返してください。

【厳格な計算・判定の指示】
- ログ抽出の場合: 各行のSTATUSとTIMEを1件ずつ厳密に判定してください。「300msを超える(>300)」は300以下は含みません。SIZEの合計値と対象IDのリスト、件数が正確に一致するように慎重に合算してください。
- ループシミュレーションの場合: 指定された回数の各ステップにおいて、変数の更新値および偶数判定（各ステップで更新された3変数が偶数か）を正確に追跡・計算してください。
- メトリクス分析の場合: 配列の全数値を正確に昇順ソートし、指定された計算式 Math.floor(length * 0.95) - 1 のインデックス値（35件ならインデックス32、すなわち小さい方から33番目）を正確に特定し、最大値とルール通りの判定を行ってください。

【問題文】
{challenge.prompt}
"""

    def _parse_answer(self, raw_text: str) -> ChallengeAnswer:
        cleaned_json = self._clean_json_text(raw_text)
        try:
            parsed = json.loads(cleaned_json)
            if isinstance(parsed, dict):
                parsed.pop("_thinking", None)
                parsed.pop("reasoning", None)
            return parsed
        except Exception as e:
            raise RuntimeError(f"LLMの出力から有効な解答JSONをパースできませんでした: {raw_text}") from e

    def _clean_json_text(self, text: str) -> str:
        cleaned = text.strip()

        # 1. マークダウンコードブロックの剥離
        if cleaned.startswith("```json"):
            cleaned = re.sub(r"^```json\s*", "", cleaned, flags=re.IGNORECASE)
            cleaned = re.sub(r"\s*```$", "", cleaned)
        elif cleaned.startswith("```"):
            cleaned = re.sub(r"^```\s*", "", cleaned)
            cleaned = re.sub(r"\s*```$", "", cleaned)

        # 2. 前後に自然言語テキストが含まれる場合、最初の '{' から最後の '}' を抽出
        match = re.search(r"\{[\s\S]*\}", cleaned)
        if match:
            return match.group(0)

        return cleaned

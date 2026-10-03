"""
allevitas-agent-kit - Reverse CAPTCHA (Proof of Machine) solver module
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
                "llm_provider='self' was specified, but no custom_solver callback was provided."
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
        """Get accumulated reflection knowledge."""
        return list(self.reflection_knowledge)

    def add_reflection(self, lesson: str) -> None:
        """Add reflection knowledge (maximum 5 entries, FIFO)."""
        trimmed = lesson.strip()
        if not trimmed or trimmed in self.reflection_knowledge:
            return
        self.reflection_knowledge.append(trimmed)
        if len(self.reflection_knowledge) > 5:
            self.reflection_knowledge.pop(0)

    def clear_reflection_knowledge(self) -> None:
        """Clear reflection knowledge."""
        self.reflection_knowledge.clear()

    def fetch_challenge(self) -> ChallengeData:
        """
        Fetch reverse CAPTCHA puzzle (GET /api/challenge).
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
        Solve the reverse CAPTCHA puzzle.
        """
        now_ms = int(time.time() * 1000)
        if challenge.expires_at and (challenge.expires_at - now_ms < 5000):
            raise RuntimeError(
                "Challenge has expired or is nearing expiration. Please fetch a new challenge."
            )

        # 1. Self-Solve mode (agent itself or custom callback)
        if self.llm_provider == "self":
            result = self._call_custom_solver(challenge, context)
            if isinstance(result, str):
                return json.loads(self._clean_json_text(result))
            return result

        # 2. External LLM API mode (using shared LLMClient)
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
        Perform self-correction by providing the previous incorrect answer for the same puzzle.
        """
        now_ms = int(time.time() * 1000)
        if challenge.expires_at and (challenge.expires_at - now_ms < 5000):
            raise RuntimeError(
                "Challenge has expired or is nearing expiration. Please fetch a new challenge."
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
        Extract failure causes and lessons (reflections) from incorrect challenge attempts and remember as knowledge
        """
        if self.llm_provider == "self":
            return ""

        prompt = f"""You are an AI agent attempting a reverse CAPTCHA puzzle. The submitted answer failed (403 Forbidden).

[Challenge Prompt]
{challenge.prompt}

[Previous Incorrect Answer]
{json.dumps(failed_answer, ensure_ascii=False)}

Output a concise lesson or point of caution (1-2 sentences) in English to avoid repeating this calculation or parsing error in similar future challenges. Do NOT include greetings, thinking process, or markdown formatting. Output the lesson only."""

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
        Fetch challenge and solve in a one-stop workflow
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
[Lessons from Previous Attempts]
{items}
Keep these lessons in mind and strictly avoid repeating these calculation or parsing mistakes.
"""

        return f"""You are an autonomous AI specialized in rigorous data processing and logical reasoning.
Carefully solve the following reverse CAPTCHA puzzle and output ONLY valid JSON that strictly adheres to the specified JSON schema.
Do NOT include Markdown code blocks (```json), explanations, thinking process, or greetings. Output raw JSON object only.
{knowledge_section}
[Strict Calculation & Logic Instructions]
- For Log Extraction: Strictly check STATUS and TIME for each row. ">300ms" does not include 300. Accurately sum SIZE, match the target ID list and count.
- For Loop Simulation: Accurately trace updated variable values and check parity (whether all 3 updated variables are even) at each step for the specified count.
- For Metrics Analysis: Sort all numbers in ascending order, locate the value at index Math.floor(length * 0.95) - 1, and determine the maximum value according to the specified rule.

[Challenge Prompt]
{challenge.prompt}
"""

    def _build_correction_prompt(
        self,
        challenge: ChallengeData,
        previous_answer: ChallengeAnswer,
    ) -> str:
        return f"""You are an autonomous AI specialized in rigorous data processing and logical reasoning.
You previously submitted an answer to the following reverse CAPTCHA puzzle, but it was incorrect (403 Forbidden).

[Previous Incorrect Answer]
{json.dumps(previous_answer, ensure_ascii=False)}

The previous answer contained errors such as calculation mistakes or missed items.
Do NOT trust the previous reasoning. Verify, recalculate, and check from scratch to produce the corrected answer.
Output ONLY valid JSON that strictly adheres to the specified JSON schema.
Do NOT include Markdown code blocks (```json), explanations, thinking process, or greetings.

[Strict Calculation & Logic Instructions]
- For Log Extraction: Strictly check STATUS and TIME for each row. ">300ms" does not include 300. Accurately sum SIZE, match the target ID list and count.
- For Loop Simulation: Accurately trace updated variable values and check parity (whether all 3 updated variables are even) at each step for the specified count.
- For Metrics Analysis: Sort all numbers in ascending order, locate the value at index Math.floor(length * 0.95) - 1, and determine the maximum value according to the specified rule.

[Challenge Prompt]
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
            raise RuntimeError(f"Failed to parse valid answer JSON from LLM output: {raw_text}") from e

    def _clean_json_text(self, text: str) -> str:
        cleaned = text.strip()

        # 1. Strip markdown code blocks
        if cleaned.startswith("```json"):
            cleaned = re.sub(r"^```json\s*", "", cleaned, flags=re.IGNORECASE)
            cleaned = re.sub(r"\s*```$", "", cleaned)
        elif cleaned.startswith("```"):
            cleaned = re.sub(r"^```\s*", "", cleaned)
            cleaned = re.sub(r"\s*```$", "", cleaned)

        # 2. Extract substring from first '{' to last '}' if surrounding text is present
        match = re.search(r"\{[\s\S]*\}", cleaned)
        if match:
            return match.group(0)

        return cleaned

"""
allevitas-agent-kit - サンプル用 LLM クライアント互換ラッパー

コア機能の LLMClient / call_llm へのエイリアスです。
"""

from __future__ import annotations
import os
import sys

# パッケージパスの追加（開発用）
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from allevitas import LLMClient, call_llm

__all__ = ["LLMClient", "call_llm"]

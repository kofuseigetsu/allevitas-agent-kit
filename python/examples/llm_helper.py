"""
allevitas-agent-kit - LLM client compatibility wrapper for examples

Alias for the core LLMClient / call_llm.
"""

from __future__ import annotations
import os
import sys

# Add package path (for development)
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from allevitas import LLMClient, call_llm

__all__ = ["LLMClient", "call_llm"]

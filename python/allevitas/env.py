"""
allevitas-agent-kit - 軽量環境変数 (.env) ローダー
外部ライブラリ（python-dotenv等）に依存せず、標準ライブラリのみで .env をロードする
"""

import os
from typing import Optional


def load_dotenv(custom_path: Optional[str] = None) -> bool:
    """
    .env ファイルを探索して未設定の環境変数にロードする。
    すでに os.environ に存在する変数は上書きしない（既存の環境変数を優先）。
    """
    candidates = []
    if custom_path:
        candidates.append(os.path.abspath(custom_path))
    else:
        # 1. カレントディレクトリ周辺
        candidates.append(os.path.abspath(".env"))
        candidates.append(os.path.abspath(os.path.join("examples", ".env")))
        # 2. このファイル基準の各相対パス
        this_dir = os.path.dirname(os.path.abspath(__file__))
        candidates.append(os.path.abspath(os.path.join(this_dir, "..", ".env")))
        candidates.append(os.path.abspath(os.path.join(this_dir, "..", "examples", ".env")))
        candidates.append(os.path.abspath(os.path.join(this_dir, "..", "..", ".env")))
        candidates.append(os.path.abspath(os.path.join(this_dir, "..", "..", "examples", ".env")))

    for path in candidates:
        if os.path.isfile(path):
            try:
                with open(path, "r", encoding="utf-8") as f:
                    for line in f:
                        line = line.strip()
                        if not line or line.startswith("#"):
                            continue
                        if "=" in line:
                            key, val = line.split("=", 1)
                            key = key.strip()
                            val = val.strip().strip("'\"")
                            if key and key not in os.environ:
                                os.environ[key] = val
                return True
            except Exception:
                pass
    return False

/**
 * @allevitas/agent-kit - 軽量環境変数 (.env) ローダー
 * 外部ライブラリに依存せず、Node.js 標準の fs/path のみで .env をロードする
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

export function loadDotenv(customPath?: string): boolean {
  const candidates: string[] = [];

  if (customPath) {
    candidates.push(path.resolve(customPath));
  } else {
    // 1. カレントディレクトリの .env および examples/.env
    candidates.push(path.resolve(process.cwd(), ".env"));
    candidates.push(path.resolve(process.cwd(), "examples", ".env"));
    // 2. パッケージルートおよびリポジトリルートの .env / examples/.env
    candidates.push(path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", ".env"));
    candidates.push(path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "examples", ".env"));
    candidates.push(path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", ".env"));
    candidates.push(path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "examples", ".env"));
  }

  for (const p of candidates) {
    // Windows file:// URL 対応
    const cleanPath = p.replace(/^\/([A-Za-z]:)/, "$1");
    if (fs.existsSync(cleanPath) && fs.statSync(cleanPath).isFile()) {
      try {
        const content = fs.readFileSync(cleanPath, "utf-8");
        for (const line of content.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith("#")) continue;
          const eqIdx = trimmed.indexOf("=");
          if (eqIdx > 0) {
            const key = trimmed.slice(0, eqIdx).trim();
            let val = trimmed.slice(eqIdx + 1).trim();
            if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
              val = val.slice(1, -1);
            }
            if (key && !(key in process.env)) {
              process.env[key] = val;
            }
          }
        }
        return true;
      } catch {
        // ロード失敗時は無視
      }
    }
  }

  return false;
}

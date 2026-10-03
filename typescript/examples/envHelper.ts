/**
 * @allevitas/agent-kit - Environment variable loader for examples (zero external dependencies)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import process from "node:process";

export function loadEnv(customPath?: string): void {
  const candidates = [
    customPath,
    path.resolve(process.cwd(), ".env"),
    path.resolve(process.cwd(), "examples", ".env"),
    path.resolve(new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), ".env"),
  ].filter(Boolean) as string[];

  for (const envPath of candidates) {
    if (fs.existsSync(envPath)) {
      try {
        const content = fs.readFileSync(envPath, "utf-8");
        for (const line of content.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith("#")) continue;

          const eqIndex = trimmed.indexOf("=");
          if (eqIndex > 0) {
            const key = trimmed.slice(0, eqIndex).trim();
            let val = trimmed.slice(eqIndex + 1).trim();

            // Strip surrounding quotes
            if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
              val = val.slice(1, -1);
            }

            if (!process.env[key]) {
              process.env[key] = val;
            }
          }
        }
        return;
      } catch {
        // Ignore read errors
      }
    }
  }
}

/**
 * Board (Tabula Canvas) diff helpers
 *
 * Builds Search/Replace operations from the old and new board content so that a
 * full-text update can be committed as a minimal diff instead of `replace_all`.
 *
 * The algorithm is shared with the Python SDK (allevitas/board_diff.py) and must stay
 * in sync with it, so that both SDKs produce identical operations for the same input.
 */
import type { BoardOperation } from "./types.js";
import { BoardDiffError } from "./types.js";

/** [oldStart, oldEnd, newStart, newEnd] line ranges of one changed region */
type Hunk = [number, number, number, number];

/**
 * Normalize CRLF to LF, as the server does before applying operations.
 */
export function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

/**
 * Split text into lines, keeping the trailing "\n" on each line.
 */
function splitLines(text: string): string[] {
  if (text === "") return [];
  const parts = text.split("\n");
  const lines = parts.slice(0, -1).map((part) => part + "\n");
  const last = parts[parts.length - 1] ?? "";
  if (last !== "") lines.push(last);
  return lines;
}

/**
 * Count occurrences of `search`, including overlapping ones (stops at `limit`).
 * This is stricter than the server, which only counts non-overlapping matches.
 */
function countMatches(content: string, search: string, limit = 2): number {
  let count = 0;
  let pos = content.indexOf(search);
  while (pos !== -1) {
    count++;
    if (count >= limit) break;
    pos = content.indexOf(search, pos + 1);
  }
  return count;
}

/**
 * Compute changed regions between two line lists with the Myers O(ND) algorithm.
 */
function myersHunks(a: string[], b: string[]): Hunk[] {
  const n = a.length;
  const m = b.length;
  const maxD = n + m;
  const offset = maxD + 1;
  const v = new Array<number>(2 * maxD + 3).fill(0);
  const trace: number[][] = [];

  let found = false;
  for (let d = 0; d <= maxD; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)) {
        x = v[offset + k + 1]!;
      } else {
        x = v[offset + k - 1]! + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
    if (found) break;
  }

  // Backtrack to collect edit steps in reverse order: "=" (equal), "-" (delete), "+" (insert)
  const steps: string[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const vd = trace[d]!;
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && vd[offset + k - 1]! < vd[offset + k + 1]!)) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }
    const prevX = vd[offset + prevK]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      steps.push("=");
      x--;
      y--;
    }
    if (d > 0) {
      steps.push(x === prevX ? "+" : "-");
    }
    x = prevX;
    y = prevY;
  }
  steps.reverse();

  const hunks: Hunk[] = [];
  x = 0;
  y = 0;
  let start: [number, number] | null = null;
  for (const step of steps) {
    if (step === "=") {
      if (start !== null) {
        hunks.push([start[0], x, start[1], y]);
        start = null;
      }
      x++;
      y++;
    } else {
      if (start === null) start = [x, y];
      if (step === "-") x++;
      else y++;
    }
  }
  if (start !== null) hunks.push([start[0], x, start[1], y]);
  return hunks;
}

/**
 * Trim the common prefix/suffix, then diff the remaining middle part.
 */
function diffHunks(a: string[], b: string[]): Hunk[] {
  const n = a.length;
  const m = b.length;
  let prefix = 0;
  while (prefix < n && prefix < m && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < n - prefix &&
    suffix < m - prefix &&
    a[n - 1 - suffix] === b[m - 1 - suffix]
  ) {
    suffix++;
  }
  const middle = myersHunks(a.slice(prefix, n - suffix), b.slice(prefix, m - suffix));
  return middle.map(([os, oe, ns, ne]): Hunk => [os + prefix, oe + prefix, ns + prefix, ne + prefix]);
}

/**
 * Apply Search/Replace operations locally with the same rules as the server:
 * operations are applied in order, each `search` must match exactly once in the
 * current content, and `replace` is inserted literally.
 *
 * @throws BoardDiffError When an operation is invalid, not found, or ambiguous.
 */
export function applyBoardOperations(content: string, operations: BoardOperation[]): string {
  let current = normalizeLineEndings(content);
  for (let i = 0; i < operations.length; i++) {
    const op = operations[i]!;
    const search = normalizeLineEndings(op.search ?? "");
    const replace = normalizeLineEndings(op.replace ?? "");

    if (op.type === "replace_all" || (!search && current === "")) {
      current = replace;
      continue;
    }
    if (!search) {
      throw new BoardDiffError(
        `Operation #${i + 1}: search string cannot be empty unless creating initial content ` +
          `or using type="replace_all".`,
        "INVALID_OPERATION"
      );
    }

    const matches = countMatches(current, search);
    if (matches === 0) {
      throw new BoardDiffError(
        `Operation #${i + 1}: the target search string was not found in the board content.`,
        "TARGET_NOT_FOUND",
        0
      );
    }
    if (matches > 1) {
      throw new BoardDiffError(
        `Operation #${i + 1}: the target search string matched multiple locations.`,
        "AMBIGUOUS_SEARCH_TARGET",
        matches
      );
    }

    const idx = current.indexOf(search);
    current = current.slice(0, idx) + replace + current.slice(idx + search.length);
  }
  return current;
}

/**
 * Build Search/Replace operations that turn `oldContent` into `newContent`.
 *
 * - Returns [] when both contents are identical (after CRLF normalization).
 * - Returns a single `replace_all` operation when `oldContent` is empty.
 * - Otherwise returns line-based operations. Each `search` is widened with
 *   surrounding lines until it matches exactly once (no upper limit).
 *
 * The generated operations are verified locally before being returned.
 *
 * @throws BoardDiffError When the operations cannot be verified (never falls back to replace_all).
 */
export function buildBoardOperations(oldContent: string, newContent: string): BoardOperation[] {
  const oldText = normalizeLineEndings(oldContent);
  const newText = normalizeLineEndings(newContent);
  if (oldText === newText) return [];
  if (oldText === "") return [{ search: "", replace: newText, type: "replace_all" }];

  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  let current = oldLines.slice();
  let shift = 0; // line offset between the old content and the partially updated content
  const operations: BoardOperation[] = [];

  for (const [os, oe, ns, ne] of diffHunks(oldLines, newLines)) {
    const start = os + shift;
    const end = oe + shift;
    const currentText = current.join("");
    let lo = start;
    let hi = end;
    let search: string;
    while (true) {
      search = current.slice(lo, hi).join("");
      if (search && countMatches(currentText, search) === 1) break;
      if (lo === 0 && hi === current.length) {
        throw new BoardDiffError(
          "Could not build a unique search string for a changed region.",
          "VERIFICATION_FAILED"
        );
      }
      lo = Math.max(0, lo - 1);
      hi = Math.min(current.length, hi + 1);
    }

    const inserted = newLines.slice(ns, ne);
    const replace = [...current.slice(lo, start), ...inserted, ...current.slice(end, hi)].join("");
    operations.push({ search, replace });
    current = [...current.slice(0, start), ...inserted, ...current.slice(end)];
    shift += ne - ns - (oe - os);
  }

  let result: string;
  try {
    result = applyBoardOperations(oldText, operations);
  } catch (err: any) {
    throw new BoardDiffError(
      `Generated operations failed local verification: ${err?.message || err}`,
      "VERIFICATION_FAILED"
    );
  }
  if (result !== newText) {
    throw new BoardDiffError(
      "Generated operations do not reproduce the requested content.",
      "VERIFICATION_FAILED"
    );
  }
  return operations;
}

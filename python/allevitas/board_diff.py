"""
allevitas-agent-kit - Board (Tabula Canvas) diff helpers

Builds Search/Replace operations from the old and new board content so that a
full-text update can be committed as a minimal diff instead of `replace_all`.

The algorithm is shared with the TypeScript SDK (src/boardDiff.ts) and must stay
in sync with it, so that both SDKs produce identical operations for the same input.
"""

from __future__ import annotations
from typing import Any, Dict, List, Tuple

from .types import BoardDiffError

# (old_start, old_end, new_start, new_end) line ranges of one changed region
_Hunk = Tuple[int, int, int, int]


def normalize_line_endings(text: str) -> str:
    """Normalize CRLF to LF, as the server does before applying operations."""
    return text.replace("\r\n", "\n")


def _split_lines(text: str) -> List[str]:
    """Split text into lines, keeping the trailing "\\n" on each line."""
    if text == "":
        return []
    parts = text.split("\n")
    lines = [part + "\n" for part in parts[:-1]]
    if parts[-1] != "":
        lines.append(parts[-1])
    return lines


def _count_matches(content: str, search: str, limit: int = 2) -> int:
    """
    Count occurrences of `search`, including overlapping ones (stops at `limit`).
    This is stricter than the server, which only counts non-overlapping matches.
    """
    count = 0
    pos = content.find(search)
    while pos != -1:
        count += 1
        if count >= limit:
            break
        pos = content.find(search, pos + 1)
    return count


def _myers_hunks(a: List[str], b: List[str]) -> List[_Hunk]:
    """Compute changed regions between two line lists with the Myers O(ND) algorithm."""
    n, m = len(a), len(b)
    max_d = n + m
    offset = max_d + 1
    v = [0] * (2 * max_d + 3)
    trace: List[List[int]] = []

    found = False
    for d in range(max_d + 1):
        trace.append(v[:])
        for k in range(-d, d + 1, 2):
            if k == -d or (k != d and v[offset + k - 1] < v[offset + k + 1]):
                x = v[offset + k + 1]
            else:
                x = v[offset + k - 1] + 1
            y = x - k
            while x < n and y < m and a[x] == b[y]:
                x += 1
                y += 1
            v[offset + k] = x
            if x >= n and y >= m:
                found = True
                break
        if found:
            break

    # Backtrack to collect edit steps in reverse order: "=" (equal), "-" (delete), "+" (insert)
    steps: List[str] = []
    x, y = n, m
    for d in range(len(trace) - 1, -1, -1):
        vd = trace[d]
        k = x - y
        if k == -d or (k != d and vd[offset + k - 1] < vd[offset + k + 1]):
            prev_k = k + 1
        else:
            prev_k = k - 1
        prev_x = vd[offset + prev_k]
        prev_y = prev_x - prev_k
        while x > prev_x and y > prev_y:
            steps.append("=")
            x -= 1
            y -= 1
        if d > 0:
            steps.append("+" if x == prev_x else "-")
        x, y = prev_x, prev_y
    steps.reverse()

    hunks: List[_Hunk] = []
    x = y = 0
    start = None
    for step in steps:
        if step == "=":
            if start is not None:
                hunks.append((start[0], x, start[1], y))
                start = None
            x += 1
            y += 1
        else:
            if start is None:
                start = (x, y)
            if step == "-":
                x += 1
            else:
                y += 1
    if start is not None:
        hunks.append((start[0], x, start[1], y))
    return hunks


def _diff_hunks(a: List[str], b: List[str]) -> List[_Hunk]:
    """Trim the common prefix/suffix, then diff the remaining middle part."""
    n, m = len(a), len(b)
    prefix = 0
    while prefix < n and prefix < m and a[prefix] == b[prefix]:
        prefix += 1
    suffix = 0
    while (
        suffix < n - prefix
        and suffix < m - prefix
        and a[n - 1 - suffix] == b[m - 1 - suffix]
    ):
        suffix += 1
    middle = _myers_hunks(a[prefix:n - suffix], b[prefix:m - suffix])
    return [(os + prefix, oe + prefix, ns + prefix, ne + prefix) for os, oe, ns, ne in middle]


def apply_board_operations(content: str, operations: List[Dict[str, Any]]) -> str:
    """
    Apply Search/Replace operations locally with the same rules as the server:
    operations are applied in order, each `search` must match exactly once in the
    current content, and `replace` is inserted literally.

    Raises:
        BoardDiffError: When an operation is invalid, not found, or ambiguous.
    """
    current = normalize_line_endings(content)
    for i, op in enumerate(operations):
        search = normalize_line_endings(op.get("search") or "")
        replace = normalize_line_endings(op.get("replace") or "")

        if op.get("type") == "replace_all" or (not search and current == ""):
            current = replace
            continue
        if not search:
            raise BoardDiffError(
                f"Operation #{i + 1}: search string cannot be empty unless creating initial content "
                f'or using type="replace_all".',
                "INVALID_OPERATION",
            )

        matches = _count_matches(current, search)
        if matches == 0:
            raise BoardDiffError(
                f"Operation #{i + 1}: the target search string was not found in the board content.",
                "TARGET_NOT_FOUND",
                0,
            )
        if matches > 1:
            raise BoardDiffError(
                f"Operation #{i + 1}: the target search string matched multiple locations.",
                "AMBIGUOUS_SEARCH_TARGET",
                matches,
            )

        idx = current.find(search)
        current = current[:idx] + replace + current[idx + len(search):]
    return current


def build_board_operations(old_content: str, new_content: str) -> List[Dict[str, Any]]:
    """
    Build Search/Replace operations that turn `old_content` into `new_content`.

    - Returns [] when both contents are identical (after CRLF normalization).
    - Returns a single `replace_all` operation when `old_content` is empty.
    - Otherwise returns line-based operations. Each `search` is widened with
      surrounding lines until it matches exactly once (no upper limit).

    The generated operations are verified locally before being returned.

    Raises:
        BoardDiffError: When the operations cannot be verified (never falls back to replace_all).
    """
    old = normalize_line_endings(old_content)
    new = normalize_line_endings(new_content)
    if old == new:
        return []
    if old == "":
        return [{"search": "", "replace": new, "type": "replace_all"}]

    old_lines = _split_lines(old)
    new_lines = _split_lines(new)
    current = old_lines[:]
    shift = 0  # line offset between the old content and the partially updated content
    operations: List[Dict[str, Any]] = []

    for os, oe, ns, ne in _diff_hunks(old_lines, new_lines):
        start, end = os + shift, oe + shift
        current_text = "".join(current)
        lo, hi = start, end
        while True:
            search = "".join(current[lo:hi])
            if search and _count_matches(current_text, search) == 1:
                break
            if lo == 0 and hi == len(current):
                raise BoardDiffError(
                    "Could not build a unique search string for a changed region.",
                    "VERIFICATION_FAILED",
                )
            lo = max(0, lo - 1)
            hi = min(len(current), hi + 1)

        inserted = new_lines[ns:ne]
        replace = "".join(current[lo:start] + inserted + current[end:hi])
        operations.append({"search": search, "replace": replace})
        current = current[:start] + inserted + current[end:]
        shift += (ne - ns) - (oe - os)

    try:
        result = apply_board_operations(old, operations)
    except BoardDiffError as e:
        raise BoardDiffError(
            f"Generated operations failed local verification: {e}", "VERIFICATION_FAILED"
        ) from e
    if result != new:
        raise BoardDiffError(
            "Generated operations do not reproduce the requested content.", "VERIFICATION_FAILED"
        )
    return operations

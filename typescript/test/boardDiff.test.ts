/**
 * Board diff helper unit tests (shared fixtures with the Python SDK)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyBoardOperations, buildBoardOperations } from "../src/boardDiff.js";
import { BoardDiffError } from "../src/types.js";

const fixturePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "testdata",
  "board_diff_cases.json"
);

describe("buildBoardOperations", () => {
  it("matches the shared fixture cases", () => {
    const cases = JSON.parse(fs.readFileSync(fixturePath, "utf-8"));
    assert.ok(cases.length > 0);
    for (const c of cases) {
      const ops = buildBoardOperations(c.old, c.new);
      assert.deepEqual(ops, c.operations, c.name);
      assert.equal(applyBoardOperations(c.old, ops), c.new.replace(/\r\n/g, "\n"), c.name);
    }
  });

  it("keeps every search unique at apply time", () => {
    const oldContent = "- item\n- item\n- item\n";
    const newContent = "- item\n- changed\n- item\n- added\n";
    const ops = buildBoardOperations(oldContent, newContent);
    assert.ok(ops.every((op) => op.search.length > 0));
    assert.equal(applyBoardOperations(oldContent, ops), newContent);
  });

  it("round-trips random inputs", () => {
    let seed = 42;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const words = ["a", "b", "", "a b", "$$", "日本"];
    const make = () => {
      const count = Math.floor(random() * 11);
      const lines = Array.from({ length: count }, () => words[Math.floor(random() * words.length)]);
      return lines.join("\n") + (random() < 0.5 ? "" : "\n");
    };
    for (let i = 0; i < 500; i++) {
      const oldContent = make();
      const newContent = make();
      const ops = buildBoardOperations(oldContent, newContent);
      assert.equal(applyBoardOperations(oldContent, ops), newContent);
    }
  });
});

describe("applyBoardOperations", () => {
  const expectCode = (fn: () => unknown, code: string) =>
    assert.throws(fn, (err: any) => {
      assert.ok(err instanceof BoardDiffError);
      assert.equal(err.code, code);
      return true;
    });

  it("rejects a missing target", () => {
    expectCode(() => applyBoardOperations("abc", [{ search: "x", replace: "y" }]), "TARGET_NOT_FOUND");
  });

  it("rejects an ambiguous target", () => {
    expectCode(() => applyBoardOperations("a\na\n", [{ search: "a", replace: "b" }]), "AMBIGUOUS_SEARCH_TARGET");
  });

  it("treats overlapping matches as ambiguous", () => {
    expectCode(() => applyBoardOperations("aaa", [{ search: "aa", replace: "b" }]), "AMBIGUOUS_SEARCH_TARGET");
  });

  it("rejects an empty search on non-empty content", () => {
    expectCode(() => applyBoardOperations("abc", [{ search: "", replace: "x" }]), "INVALID_OPERATION");
  });

  it("inserts replace text literally", () => {
    assert.equal(
      applyBoardOperations("cost: X", [{ search: "X", replace: "$& $$ $' $`" }]),
      "cost: $& $$ $' $`"
    );
  });

  it("supports replace_all and initial writes", () => {
    assert.equal(applyBoardOperations("old", [{ search: "", replace: "new", type: "replace_all" }]), "new");
    assert.equal(applyBoardOperations("", [{ search: "", replace: "first" }]), "first");
  });
});

/**
 * Tests for normalizeApiUrl and utilities
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeApiUrl, DEFAULT_API_URL } from "../src/utils.js";
import { AllevitasClient } from "../src/client.js";

describe("normalizeApiUrl", () => {
  it("returns DEFAULT_API_URL when no URL or env var is provided", () => {
    const originalEnv = process.env.ALLEVITAS_API_URL;
    delete process.env.ALLEVITAS_API_URL;
    try {
      assert.equal(normalizeApiUrl(), DEFAULT_API_URL);
    } finally {
      if (originalEnv) process.env.ALLEVITAS_API_URL = originalEnv;
    }
  });

  it("removes trailing slashes", () => {
    assert.equal(
      normalizeApiUrl("https://allevitas.com/api/"),
      "https://allevitas.com/api"
    );
    assert.equal(
      normalizeApiUrl("https://allevitas.com/api///"),
      "https://allevitas.com/api"
    );
  });

  it("normalizes accidental /ja/api to /api", () => {
    assert.equal(
      normalizeApiUrl("https://allevitas.com/ja/api"),
      "https://allevitas.com/api"
    );
    assert.equal(
      normalizeApiUrl("https://allevitas.com/ja/api/"),
      "https://allevitas.com/api"
    );
  });

  it("normalizes other language prefixes like /en/api to /api", () => {
    assert.equal(
      normalizeApiUrl("https://allevitas.com/en/api"),
      "https://allevitas.com/api"
    );
  });

  it("works with local development URLs", () => {
    assert.equal(
      normalizeApiUrl("http://localhost:3000/api"),
      "http://localhost:3000/api"
    );
    assert.equal(
      normalizeApiUrl("http://localhost:3000/ja/api/"),
      "http://localhost:3000/api"
    );
  });

  it("normalizes apiUrl in AllevitasClient constructor", () => {
    const client = new AllevitasClient({
      apiUrl: "https://allevitas.com/ja/api",
    });
    assert.equal(client.apiUrl, "https://allevitas.com/api");
  });
});

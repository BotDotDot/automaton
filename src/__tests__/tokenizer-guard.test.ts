/**
 * Token counting must never hang on pathological input (js-tiktoken is
 * quadratic on long runs without whitespace).
 */

import { describe, it, expect } from "vitest";
import {
  createTokenCounter,
  shouldSkipEncoding,
  MAX_ENCODE_CHARS,
  MAX_UNBROKEN_RUN,
} from "../memory/context-manager.js";
import { estimateTokens } from "../agent/context.js";

describe("tokenizer guard", () => {
  it("skips encoding for long unbroken runs and very long text", () => {
    expect(shouldSkipEncoding("a".repeat(MAX_UNBROKEN_RUN))).toBe(true);
    expect(shouldSkipEncoding("a".repeat(MAX_UNBROKEN_RUN - 1))).toBe(false);
    expect(shouldSkipEncoding("word ".repeat(MAX_ENCODE_CHARS / 5 + 1))).toBe(true);
    expect(shouldSkipEncoding("ordinary text with spaces")).toBe(false);
  });

  it("counts a 1 MB string without spaces quickly, as length/4", () => {
    const counter = createTokenCounter();
    const text = "x".repeat(1_000_000);
    const started = Date.now();
    expect(counter.countTokens(text)).toBe(250_000);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("handles base64-like blobs inside normal text quickly", () => {
    const blob = Buffer.from("y".repeat(300_000)).toString("base64");
    const text = `here is a file: ${blob} end`;
    const started = Date.now();
    expect(estimateTokens(text)).toBe(Math.ceil(text.length / 4));
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("still uses the real tokenizer for ordinary text", () => {
    const counter = createTokenCounter();
    // "hello" is one cl100k token; length/4 would say 2.
    expect(counter.countTokens("hello")).toBe(1);
  });
});

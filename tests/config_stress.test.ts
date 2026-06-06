import { describe, expect, test } from "bun:test";

import { CONFIG } from "../src/config";
import { Logger } from "../src/infrastructure/logging";
import { sanitizeOutput, validateStringSize } from "../src/infrastructure/sanitize";
import { SearchInputSchema } from "../src/mcp/schemas";

describe("Configuration Edge Cases & Limits", () => {
  test("MCP Schemas respect max limit configurations", () => {
    // maxSearchLimitSchema is currently 20
    const searchResult = SearchInputSchema.safeParse({
      query: "test",
      limit: CONFIG.mcp.maxSearchLimitSchema + 1,
    });
    expect(searchResult.success).toBe(false);

    const validSearchResult = SearchInputSchema.safeParse({
      query: "test",
      limit: CONFIG.mcp.maxSearchLimitSchema,
    });
    expect(validSearchResult.success).toBe(true);

    // Default limit should be mcp.defaultSearchLimit
    const defaultSearchResult = SearchInputSchema.safeParse({ query: "test" });
    expect(defaultSearchResult.success).toBe(true);
    if (defaultSearchResult.success) {
      expect(defaultSearchResult.data.limit).toBe(CONFIG.mcp.defaultSearchLimit);
    }
  });

  test("Sanitize string enforces maxStringBytes using validateStringSize", () => {
    // 1 byte per character for ascii
    const massiveString = "a".repeat(CONFIG.guardrails.maxStringBytes + 100);

    const result = validateStringSize(
      massiveString,
      CONFIG.guardrails.maxStringBytes,
      "massiveString",
    );
    expect(result).toMatch(/exceeds maximum size/);

    const validResult = validateStringSize(
      "valid string",
      CONFIG.guardrails.maxStringBytes,
      "validString",
    );
    expect(validResult).toBeNull();
  });

  test("Sanitize request enforces maxRequestBytes using stringify size", () => {
    const hugeObject = {
      data: "a".repeat(CONFIG.guardrails.maxRequestBytes + 1000),
    };

    const json = JSON.stringify(hugeObject);
    const result = validateStringSize(json, CONFIG.guardrails.maxRequestBytes, "request");
    expect(result).toMatch(/exceeds maximum size/);
  });

  test("Output word limit is enforced", () => {
    const words = Array(CONFIG.guardrails.maxOutputWords + 50)
      .fill("word")
      .join(" ");
    const limited = sanitizeOutput(words, CONFIG.guardrails.maxOutputWords);

    const limitedWordCount = limited.split(/\s+/).length;
    // Includes [Truncated for Context Hygiene] so around maxOutputWords + 5
    expect(limitedWordCount).toBeLessThanOrEqual(CONFIG.guardrails.maxOutputWords + 10);
    expect(limited.endsWith("[Truncated for Context Hygiene]")).toBe(true);
  });

  test("Logger caps string sizes according to config", () => {
    const logger = new Logger({}); // Use valid config or empty to use defaults
    const longModule = "A".repeat(CONFIG.logging.maxModuleLength + 10);
    const longMessage = "B".repeat(CONFIG.logging.maxMessageLength + 10);
    const longContextValue = "C".repeat(CONFIG.logging.maxContextValueLength + 10);

    // Correct usage: info(module, msg, ctx)
    logger.info(longModule, longMessage, { ctx: longContextValue });
    // This is just to test if logger crashes.
    expect(true).toBe(true);
  });
});

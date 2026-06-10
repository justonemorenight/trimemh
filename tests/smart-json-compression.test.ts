import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { renderJson } from "../src/context/content-renderers";

function loadFixture(name: string): string {
  return readFileSync(path.join(__dirname, "fixtures", name), "utf-8");
}

describe("Smart JSON Compression (SmartCrusher-lite)", () => {
  test("1. Array of 50 DB rows → output contains array[50], distribution, anomalies", () => {
    const text = loadFixture("json-db-rows-50.json");
    const result = renderJson(text);

    expect(result.display).toContain("array[50]");
    expect(result.display).toContain("distribution");
    expect(result.display).toContain("anomalies");
    expect(result.contentType).toBe("json");
  });

  test("2. Array with error rows → anomalies section includes those rows", () => {
    const text = loadFixture("json-db-rows-50.json");
    const result = renderJson(text);

    // The error rows at indices 7 and 24 have non-empty error fields
    expect(result.display).toContain("anomalies");
    expect(result.display).toContain("Connection timeout");
    expect(result.display).toContain("Database deadlock");
  });

  test("3. Array with all-same field → constants section shows it", () => {
    const text = loadFixture("json-all-constants.json");
    const result = renderJson(text);

    expect(result.display).toContain("constants");
    expect(result.display).toContain("version");
    expect(result.display).toContain("2.1.0");
    expect(result.display).toContain("region");
    expect(result.display).toContain("us-east-1");
  });

  test("4. Array with numeric outlier → anomalies detect the outlier", () => {
    const text = loadFixture("json-numeric-outlier.json");
    const result = renderJson(text);

    expect(result.display).toContain("anomalies");
    expect(result.display).toContain("15000");
    expect(result.display).toContain("outlier");
  });

  test("5. Small array (2 items) → fallback to schema-only (no distribution)", () => {
    const text = JSON.stringify([
      { id: 1, name: "Alice" },
      { id: 2, name: "Bob" },
    ]);
    const result = renderJson(text);

    expect(result.display).not.toContain("distribution");
    expect(result.display).not.toContain("anomalies");
    // Schema-only output
    expect(result.display).toContain("array[2]");
  });

  test("6. Heterogeneous array → fallback to schema-only", () => {
    const text = JSON.stringify([{ id: 1, name: "Alice" }, "just a string", 42]);
    const result = renderJson(text);

    expect(result.display).not.toContain("distribution");
    expect(result.display).not.toContain("anomalies");
    expect(result.display).toContain("array[3]");
  });

  test("7. Nested { data: [...], pagination: {...} } → output contains both schema and smart summary", () => {
    const text = loadFixture("json-api-response.json");
    const result = renderJson(text);

    // Should contain the nested array summary
    expect(result.display).toContain("array[20]");
    // Should contain pagination schema
    expect(result.display).toContain("pagination");
    // Should contain object wrapper
    expect(result.display).toContain("object {");
  });

  test("nested smart summary escapes XML only once", () => {
    const text = JSON.stringify({
      data: [
        { id: 1, status: "<bad>", error: "x & y" },
        { id: 2, status: "ok", error: "" },
        { id: 3, status: "ok", error: "" },
      ],
      pagination: { page: 1 },
    });
    const result = renderJson(text, "mem1");

    expect(result.display).toContain("memory_retrieve(&quot;mem1&quot;)");
    expect(result.display).not.toContain("&amp;quot;");
    expect(result.display).toContain("&lt;bad&gt;");
    expect(result.display).not.toContain("&amp;lt;bad");
  });

  test("8. Non-array JSON → unchanged behavior (schema-only, no distribution)", () => {
    const text = JSON.stringify({
      name: "test",
      version: "1.0.0",
      count: 42,
      nested: { a: 1, b: 2 },
    });
    const result = renderJson(text);

    expect(result.display).not.toContain("distribution");
    expect(result.display).not.toContain("anomalies");
    expect(result.display).toContain("object {");
    expect(result.display).toContain("name");
    expect(result.display).toContain("version");
  });

  test("9. Compression ratio: smart summary displayTokens < original text tokens × 0.5 for 50-row array", () => {
    const text = loadFixture("json-db-rows-50.json");
    const result = renderJson(text);
    const originalTokens = Math.ceil(text.length / 4);

    expect(result.displayTokens).toBeLessThan(originalTokens * 0.5);
    expect(result.compressed).toBe(true);
  });

  test("10. Anomaly cap: at most 5 anomaly rows shown", () => {
    // Create data with many anomalies (10+ error rows)
    const rows = Array.from({ length: 30 }, (_, i) => ({
      id: i,
      status: i < 10 ? "error" : "ok",
      error: i < 10 ? `Error message ${i}` : "",
      value: 100,
    }));
    const text = JSON.stringify(rows);
    const result = renderJson(text);

    // Count the number of "row[" occurrences in the anomalies section
    const anomalyMatches = result.display.match(/reason:/g);
    expect(anomalyMatches).toBeTruthy();
    expect(anomalyMatches!.length).toBeLessThanOrEqual(5);
  });

  test("memoryId is included in the output when provided", () => {
    const text = loadFixture("json-db-rows-50.json");
    const result = renderJson(text, "mem-abc-123");

    expect(result.display).toContain("memory_retrieve(&quot;mem-abc-123&quot;)");
  });
});

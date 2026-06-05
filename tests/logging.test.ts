import { beforeEach, describe, expect, test } from "bun:test";
import { Writable } from "node:stream";

import { Logger, getLogger, resetLogger } from "../src/infrastructure/logging";

class TestStream extends Writable {
  lines: string[] = [];
  override _write(
    chunk: Buffer,
    _encoding: string,
    callback: (error?: Error | null) => void,
  ): void {
    this.lines.push(chunk.toString().trim());
    callback();
  }
  // biome-ignore lint/suspicious/noExplicitAny: warning suppression
  lastParsed(): Record<string, any> | null {
    const line = this.lines[this.lines.length - 1];
    if (!line) {
      return null;
    }
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }
}

describe("Logger", () => {
  let stream: TestStream;
  let logger: Logger;

  beforeEach(() => {
    resetLogger();
    stream = new TestStream();
    // biome-ignore lint/suspicious/noExplicitAny: warning suppression
    logger = new Logger({ minLevel: "DEBUG", stream: stream as any, pretty: false });
  });

  test("emits JSON Lines entries", () => {
    logger.info("test", "hello world");
    const entry = stream.lastParsed();
    expect(entry).not.toBeNull();
    expect(entry?.level).toBe("INFO");
    expect(entry?.module).toBe("test");
    expect(entry?.msg).toBe("hello world");
    expect(entry?.ts).toBeDefined();
  });

  test("filters below minLevel", () => {
    // biome-ignore lint/suspicious/noExplicitAny: warning suppression
    const filtered = new Logger({ minLevel: "WARN", stream: stream as any, pretty: false });
    filtered.debug("test", "should not appear");
    filtered.info("test", "should not appear");
    filtered.warn("test", "should appear");
    expect(stream.lines.length).toBe(1);
    expect(stream.lastParsed()?.level).toBe("WARN");
  });

  test("AUDIT always passes regardless of minLevel", () => {
    // biome-ignore lint/suspicious/noExplicitAny: warning suppression
    const filtered = new Logger({ minLevel: "ERROR", stream: stream as any, pretty: false });
    filtered.audit("governance", "proposal_approved");
    expect(stream.lines.length).toBe(1);
    expect(stream.lastParsed()?.level).toBe("AUDIT");
  });

  test("includes context in entry", () => {
    logger.info("mcp", "search", { tool: "memory_search", results: 5 });
    const entry = stream.lastParsed();
    expect(entry?.ctx).toBeDefined();
    // biome-ignore lint/suspicious/noExplicitAny: warning suppression
    expect((entry?.ctx as any).tool).toBe("memory_search");
    // biome-ignore lint/suspicious/noExplicitAny: warning suppression
    expect((entry?.ctx as any).results).toBe(5);
  });

  test("caps module name length", () => {
    logger.info("very_long_module_name_that_exceeds_limit", "msg");
    const entry = stream.lastParsed();
    expect(entry?.module.length).toBeLessThanOrEqual(32);
  });

  test("caps message length", () => {
    logger.info("mod", "x".repeat(2000));
    const entry = stream.lastParsed();
    expect(entry?.msg.length).toBeLessThanOrEqual(1000);
  });

  test("pretty mode formats with colors", () => {
    const pretty = new Logger({
      minLevel: "DEBUG",
      // biome-ignore lint/suspicious/noExplicitAny: warning suppression
      stream: stream as any,
      pretty: true,
      color: true,
    });
    pretty.info("mod", "test message");
    expect(stream.lines[0]).toContain("[INFO ]");
  });

  test("config update works at runtime", () => {
    logger.configure({ minLevel: "ERROR" });
    expect(logger.minLevel).toBe("ERROR");
  });
});

describe("getLogger singleton", () => {
  beforeEach(() => resetLogger());

  test("returns same instance", () => {
    const a = getLogger();
    const b = getLogger();
    expect(a).toBe(b);
  });
});

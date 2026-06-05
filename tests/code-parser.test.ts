import { describe, expect, test } from "bun:test";

import type { ExtractedEntity } from "../src/code-intel/code-parser";
import { diffEntities, parseFile, parseFiles } from "../src/code-intel/code-parser";

const TS_SOURCE = `
import { something } from "./module";

export function hello(name: string): string {
  return \`Hello, \${name}\`;
}

const arrowFn = (x: number) => x * 2;

export class MyService {
  constructor(private db: Database) {}

  async getData(id: string) {
    return this.db.query("SELECT * FROM data WHERE id = ?", [id]);
  }

  static create(): MyService {
    return new MyService(null as any);
  }
}

export const config = { port: 3000 };
`;

const PY_SOURCE = `
import os

def hello(name):
    return f"Hello, {name}"

class DataProcessor:
    def __init__(self, config):
        self.config = config

    def process(self, data):
        return [x * 2 for x in data]

def _private_helper():
    pass
`;

describe("parseFile (TypeScript)", () => {
  test("detects language", () => {
    const result = parseFile("/src/app.ts", TS_SOURCE);
    expect(result.language).toBe("typescript");
  });

  test("extracts file entity", () => {
    const result = parseFile("/src/app.ts", TS_SOURCE);
    const fileEntity = result.entities.find((e) => e.entityType === "file");
    expect(fileEntity).toBeDefined();
    expect(fileEntity?.symbol).toBe("app.ts");
    expect(fileEntity?.lineStart).toBe(1);
  });

  test("extracts named functions", () => {
    const result = parseFile("/src/app.ts", TS_SOURCE);
    const functions = result.entities.filter((e) => e.entityType === "function");
    // Should find: hello, arrowFn, getData, create (method shorthand)
    expect(functions.length).toBeGreaterThanOrEqual(1);
    const names = functions.map((f) => f.symbol);
    expect(names).toContain("hello");
  });

  test("extracts class declarations", () => {
    const result = parseFile("/src/app.ts", TS_SOURCE);
    const classes = result.entities.filter((e) => e.entityType === "class");
    expect(classes.length).toBeGreaterThanOrEqual(1);
    expect(classes.map((c) => c.symbol)).toContain("MyService");
  });

  test("extracts exports as modules", () => {
    const result = parseFile("/src/app.ts", TS_SOURCE);
    const modules = result.entities.filter((e) => e.entityType === "module");
    expect(modules.length).toBeGreaterThanOrEqual(1);
  });

  test("entities have fingerplints", () => {
    const result = parseFile("/src/app.ts", TS_SOURCE);
    for (const entity of result.entities) {
      expect(entity.fingerprint).toBeDefined();
      expect(entity.fingerprint.length).toBeGreaterThan(0);
    }
  });
});

describe("parseFile (Python)", () => {
  test("extracts functions and classes", () => {
    const result = parseFile("/src/processor.py", PY_SOURCE);
    expect(result.language).toBe("python");
    const functions = result.entities.filter((e) => e.entityType === "function");
    const classes = result.entities.filter((e) => e.entityType === "class");
    expect(functions.length).toBeGreaterThanOrEqual(1);
    expect(classes.length).toBeGreaterThanOrEqual(1);
  });

  test("does not extract private functions", () => {
    const result = parseFile("/src/processor.py", PY_SOURCE);
    const privates = result.entities.filter((e) => e.symbol === "_private_helper");
    expect(privates.length).toBe(0);
  });
});

describe("parseFile (unknown language)", () => {
  test("returns file entity only", () => {
    const result = parseFile("/data/config.yaml", "key: value\n");
    expect(result.language).toBe("unknown");
    expect(result.entities.length).toBe(1);
    expect(result.entities[0]?.entityType).toBe("file");
  });
});

describe("parseFiles", () => {
  test("handles multiple files", () => {
    const results = parseFiles([
      { path: "/a.ts", source: "export const a = 1;" },
      { path: "/b.ts", source: "export function b() {}" },
    ]);
    expect(results.length).toBe(2);
    expect(results[0]?.path).toBe("/a.ts");
    expect(results[1]?.path).toBe("/b.ts");
  });
});

describe("diffEntities", () => {
  function e(type: string, symbol: string, fp: string): ExtractedEntity {
    return {
      // biome-ignore lint/suspicious/noExplicitAny: warning suppression
      entityType: type as any,
      symbol,
      lineStart: 1,
      lineEnd: 1,
      fingerprint: fp,
    };
  }

  test("detects added entities", () => {
    const oldEntities = [e("function", "fnA", "aaa")];
    const newEntities = [e("function", "fnA", "aaa"), e("function", "fnB", "bbb")];
    const diff = diffEntities(oldEntities, newEntities);
    expect(diff.added.length).toBe(1);
    expect(diff.added[0]?.symbol).toBe("fnB");
  });

  test("detects removed entities", () => {
    const oldEntities = [e("function", "fnA", "aaa"), e("function", "fnB", "bbb")];
    const newEntities = [e("function", "fnA", "aaa")];
    const diff = diffEntities(oldEntities, newEntities);
    expect(diff.removed.length).toBe(1);
    expect(diff.removed[0]?.symbol).toBe("fnB");
  });

  test("detects modified entities (fingerprint change)", () => {
    const oldEntities = [e("function", "fnA", "aaa")];
    const newEntities = [e("function", "fnA", "bbb")];
    const diff = diffEntities(oldEntities, newEntities);
    expect(diff.modified.length).toBe(1);
    expect(diff.modified[0]?.symbol).toBe("fnA");
  });

  test("unchanged entities not flagged", () => {
    const oldEntities = [e("function", "fnA", "aaa")];
    const newEntities = [e("function", "fnA", "aaa")];
    const diff = diffEntities(oldEntities, newEntities);
    expect(diff.added.length).toBe(0);
    expect(diff.removed.length).toBe(0);
    expect(diff.modified.length).toBe(0);
  });
});

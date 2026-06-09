const PATH_PATTERN =
  /(?:^|[\s"'`(]|^)([\w@.-]+(?:\/[\w@./_-]+)+\.(?:tsx|ts|jsx|json|js|toml|yaml|yml|md|css|scss|html|vue|rs|go|py|sql|sh|env|lock|config)(?:#\w+)?)/gi;

const CONFIG_BASENAMES = new Set([
  "package.json",
  "biome.json",
  "tsconfig.json",
  ".memh.toml",
  "vite.config.ts",
  "tailwind.config.ts",
  "tailwind.config.js",
  "eslint.config.js",
  "eslint.config.mjs",
]);

export function extractFilePaths(text: string, extraPaths: string[] = []): string[] {
  const found = new Set<string>();

  for (const path of extraPaths) {
    const trimmed = path.trim();
    if (trimmed) {
      found.add(normalizePath(trimmed));
    }
  }

  for (const match of text.matchAll(PATH_PATTERN)) {
    const raw = match[1];
    if (raw) {
      found.add(normalizePath(raw));
    }
  }

  for (const match of text.matchAll(/`([^`]+\.(?:json|ts|tsx|js|md|toml|yaml|yml))`/g)) {
    found.add(normalizePath(match[1]!));
  }

  return [...found].filter((path) => path.length > 2 && !path.startsWith("http"));
}

function normalizePath(path: string): string {
  return path.replace(/^\.\//, "").replace(/\/+/g, "/");
}

export function looksLikeToolingMemory(text: string, files: string[] = []): boolean {
  const lower = text.toLowerCase();
  const toolingKeywords =
    /\b(biome|tailwind|eslint|prettier|vitest|jest|vite|pnpm|npm|bun|ky|setup|configured|installed|added dev dependency)\b/i;
  if (toolingKeywords.test(text)) {
    return true;
  }
  return files.some((file) => CONFIG_BASENAMES.has(file.split("/").pop() ?? file));
}

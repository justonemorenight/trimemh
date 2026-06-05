export const TRIMEMH_CONTEXT_START = "<!-- memh_context:start -->";
export const TRIMEMH_CONTEXT_END = "<!-- memh_context:end -->";

export type QueryResolver =
  | string
  | ((input: unknown) => string | undefined | Promise<string | undefined>);

export interface MemoryContextRequestOptions {
  query?: QueryResolver;
  openPaths?: string[];
  includeLineageForIds?: string[];
  modelContextTokens?: number;
}

export function formatMemorySystemPrefix(xml: string): string {
  return [TRIMEMH_CONTEXT_START, xml.trim(), TRIMEMH_CONTEXT_END].join("\n");
}

export function hasMemhContext(value: unknown): boolean {
  if (typeof value === "string") {
    return value.includes(TRIMEMH_CONTEXT_START);
  }
  if (Array.isArray(value)) {
    return value.some((entry) => hasMemhContext(entry));
  }
  if (value && typeof value === "object" && "text" in value) {
    return hasMemhContext((value as { text?: unknown }).text);
  }
  return false;
}

export function prependStringPrefix(existing: string | undefined, prefix: string): string {
  if (!existing || existing.trim().length === 0) {
    return prefix;
  }
  if (hasMemhContext(existing)) {
    return existing;
  }
  return `${prefix}\n\n${existing}`;
}

export function prependSystemPrefix<T>(
  system: T | undefined,
  prefix: string,
): T | string | unknown[] {
  if (hasMemhContext(system)) {
    return system as T;
  }
  if (system === undefined || system === null || system === "") {
    return prefix;
  }
  if (typeof system === "string") {
    return prependStringPrefix(system, prefix);
  }
  if (Array.isArray(system)) {
    return [{ type: "text", text: prefix }, ...system];
  }
  return prefix;
}

export async function resolveMemoryQuery(
  resolver: QueryResolver | undefined,
  input: unknown,
  fallback: () => string | undefined,
): Promise<string | undefined> {
  if (typeof resolver === "string") {
    return resolver;
  }
  if (typeof resolver === "function") {
    const resolved = await resolver(input);
    if (resolved && resolved.trim().length > 0) {
      return resolved;
    }
  }
  return fallback();
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }
      if (part && typeof part === "object" && "text" in part) {
        const text = (part as { text?: unknown }).text;
        return typeof text === "string" ? text : "";
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

export function extractPromptText(input: unknown): string | undefined {
  if (typeof input === "string") {
    return input;
  }
  if (!input || typeof input !== "object") {
    return undefined;
  }

  const record = input as Record<string, unknown>;
  if (typeof record.prompt === "string") {
    return record.prompt;
  }
  if (Array.isArray(record.prompt)) {
    return extractPromptText({ messages: record.prompt });
  }

  const messages = record.messages;
  if (Array.isArray(messages)) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i] as { role?: unknown; content?: unknown } | undefined;
      if (message?.role !== "user") {
        continue;
      }
      const text = textFromContent(message.content);
      if (text.trim().length > 0) {
        return text;
      }
    }
  }

  return undefined;
}

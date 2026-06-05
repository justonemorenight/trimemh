import type { LanguageModelMiddleware } from "ai";

import type { BuildMemorySystemPrefixOptions } from "./context";
import { buildMemorySystemPrefix } from "./context";
import { hasMemhContext, prependStringPrefix, prependSystemPrefix } from "./prompt";

export interface VercelMemhOptions extends BuildMemorySystemPrefixOptions {
  ai?: {
    generateText?: (params: Record<string, unknown>) => unknown;
    streamText?: (params: Record<string, unknown>) => unknown;
  };
}

type PromptMessage = {
  role: string;
  content: unknown;
  [key: string]: unknown;
};

function injectPromptArray(prompt: PromptMessage[], prefix: string): PromptMessage[] {
  if (hasMemhContext(prompt)) {
    return prompt;
  }
  const [first, ...rest] = prompt;
  if (first?.role === "system" && typeof first.content === "string") {
    return [
      {
        ...first,
        content: prependStringPrefix(first.content, prefix),
      },
      ...rest,
    ];
  }
  return [{ role: "system", content: prefix }, ...prompt];
}

export async function injectVercelParams<TParams extends Record<string, unknown>>(
  params: TParams,
  options: VercelMemhOptions = {},
): Promise<TParams> {
  const prefix = await buildMemorySystemPrefix(options, params);

  if (Array.isArray(params.prompt)) {
    return {
      ...params,
      prompt: injectPromptArray(params.prompt as PromptMessage[], prefix),
    };
  }

  return {
    ...params,
    system: prependSystemPrefix(params.system, prefix),
  };
}

export function createMemhMiddleware(options: VercelMemhOptions = {}): LanguageModelMiddleware {
  return {
    specificationVersion: "v3",
    // biome-ignore lint/suspicious/useAwait: warning suppression
    transformParams: async ({ params }) => {
      return injectVercelParams(params as unknown as Record<string, unknown>, options) as never;
    },
  };
}

export async function generateTextWithMemh<TParams extends Record<string, unknown>>(
  params: TParams,
  options: VercelMemhOptions = {},
): Promise<unknown> {
  const ai = (options.ai ?? (await import("ai"))) as {
    generateText?: (params: Record<string, unknown>) => unknown;
  };
  if (typeof ai.generateText !== "function") {
    throw new Error("generateTextWithMemh requires ai.generateText.");
  }
  return ai.generateText(await injectVercelParams(params, options));
}

export async function streamTextWithMemh<TParams extends Record<string, unknown>>(
  params: TParams,
  options: VercelMemhOptions = {},
): Promise<unknown> {
  const ai = (options.ai ?? (await import("ai"))) as {
    streamText?: (params: Record<string, unknown>) => unknown;
  };
  if (typeof ai.streamText !== "function") {
    throw new Error("streamTextWithMemh requires ai.streamText.");
  }
  return ai.streamText(await injectVercelParams(params, options));
}

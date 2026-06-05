import type { BuildMemorySystemPrefixOptions } from "./context";
import { buildMemorySystemPrefix } from "./context";
import { prependSystemPrefix } from "./prompt";

type AnthropicMessageMethod = (params: Record<string, unknown>, ...rest: unknown[]) => unknown;

export interface AnthropicLike {
  messages: {
    create?: AnthropicMessageMethod;
    stream?: AnthropicMessageMethod;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export type AnthropicMemhOptions = BuildMemorySystemPrefixOptions;

async function injectAnthropicSystem(
  params: Record<string, unknown>,
  options: AnthropicMemhOptions,
): Promise<Record<string, unknown>> {
  const prefix = await buildMemorySystemPrefix(options, params);
  return {
    ...params,
    system: prependSystemPrefix(params.system, prefix),
  };
}

export function withMemhAnthropic<TClient extends AnthropicLike>(
  client: TClient,
  options: AnthropicMemhOptions = {},
): TClient {
  const messagesProxy = new Proxy(client.messages, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if ((prop !== "create" && prop !== "stream") || typeof value !== "function") {
        return value;
      }

      return async (params: Record<string, unknown>, ...rest: unknown[]) => {
        const nextParams = await injectAnthropicSystem(params, options);
        return value.call(target, nextParams, ...rest);
      };
    },
  });

  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === "messages") {
        return messagesProxy;
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

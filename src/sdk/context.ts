import type { MemhClientOptions } from "./client";
import { MemhClient } from "./client";
import type { MemoryContextRequestOptions } from "./prompt";
import { extractPromptText, formatMemorySystemPrefix, resolveMemoryQuery } from "./prompt";

export interface BuildMemorySystemPrefixOptions
  extends MemhClientOptions,
    MemoryContextRequestOptions {
  client?: Pick<MemhClient, "context">;
}

export async function buildMemorySystemPrefix(
  options: BuildMemorySystemPrefixOptions = {},
  input?: unknown,
): Promise<string> {
  const client = options.client ?? new MemhClient(options);
  const query = await resolveMemoryQuery(options.query, input, () => extractPromptText(input));
  const context = await client.context({
    query,
    openPaths: options.openPaths,
    includeLineageForIds: options.includeLineageForIds,
    modelContextTokens: options.modelContextTokens,
  });
  return formatMemorySystemPrefix(context.xml);
}

import type { CodeEntityType, CodeLinkRelation, SuggestedCodeLink } from "../domain/schema";
import { extractFilePaths } from "./path-extract";

export function suggestCodeLinksFromText(
  text: string,
  extraPaths: string[] = [],
): SuggestedCodeLink[] {
  const paths = extractFilePaths(text, extraPaths);
  return paths.map((path) => ({
    path,
    relation: relationForPath(path),
    entity_type: "file" as CodeEntityType,
    reason: `Path referenced in memory text: ${path}`,
  }));
}

function relationForPath(path: string): CodeLinkRelation {
  const base = path.split("/").pop() ?? path;
  if (/\.(md|txt|rst)$/i.test(base)) {
    return "documents";
  }
  if (/\.(json|toml|yaml|yml|config)$/i.test(base) || base.includes("config")) {
    return "implements";
  }
  return "relates_to";
}

export function formatSuggestedCodeLinks(links: SuggestedCodeLink[]): string[] {
  if (links.length === 0) {
    return [];
  }
  return [
    "Suggested code links (call memory_code_link_propose or approve in batch):",
    ...links.map((link) => `- ${link.path} (${link.relation}) — ${link.reason}`),
  ];
}

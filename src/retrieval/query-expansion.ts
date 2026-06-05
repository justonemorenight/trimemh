/**
 * Query Expansion (P1 — Accuracy Upgrade)
 *
 * Expands short user/agent queries with synonyms, related terms, and
 * code-path context to increase recall in FTS5 and vector search.
 *
 * Strategy:
 * 1. Synonym expansion — domain-specific synonym pairs
 * 2. Code entity injection — function/class names from open paths
 * 3. Negation-aware — detect "not X" patterns and avoid expanding them
 *
 * The expanded query is used by BOTH FTS5 (lexical) and vector search
 * (semantic). RRF fusion naturally dampens any noise introduced by
 * expansion because only results matching across both legs get boosted.
 */

// ─── Synonym map ────────────────────────────────────────────────────

/**
 * Domain-specific synonym pairs.
 * Each entry maps a canonical term to its synonyms.
 * Only top-2 synonyms are used per term to avoid noise.
 */
const SYNONYM_MAP: Record<string, string[]> = {
  // Software development
  bug: ["error", "defect", "issue", "failure", "crash"],
  fix: ["resolve", "patch", "repair", "correct", "remediate"],
  login: ["auth", "authentication", "signin", "sign-in", "oauth"],
  logout: ["signout", "sign-out", "session end"],
  deploy: ["release", "ship", "publish", "push"],
  rollback: ["revert", "undo", "backout"],
  migrate: ["upgrade", "transition", "move"],
  slow: ["performance", "latency", "timeout", "bottleneck", "lag"],
  crash: ["panic", "segfault", "abort", "terminate"],
  memory: ["ram", "heap", "allocation"],
  leak: ["memory leak", "resource leak"],
  deadlock: ["lock contention", "mutex", "starvation"],
  race: ["race condition", "data race", "concurrency"],

  // Database
  query: ["sql", "select", "fetch", "retrieve"],
  index: ["btree", "hash index", "composite index"],
  migration: ["schema change", "ddl", "alter table"],
  backup: ["snapshot", "dump", "restore"],

  // Security
  vulnerability: ["cve", "exploit", "weakness", "hole"],
  injection: ["sqli", "xss", "csrf", "command injection"],
  sanitize: ["escape", "validate", "cleanse", "filter"],
  secret: ["api key", "token", "password", "credential"],

  // Infrastructure
  config: ["configuration", "settings", "env", "environment"],
  docker: ["container", "image", "compose"],
  ci: ["pipeline", "build", "github actions", "jenkins"],
  monitor: ["observability", "metrics", "logging", "tracing"],

  // Operations
  delete: ["remove", "drop", "purge", "clean", "destroy"],
  create: ["build", "generate", "scaffold", "initialize"],
  update: ["modify", "change", "patch", "upgrade"],
  search: ["find", "lookup", "query", "scan"],
};

/** Maximum synonyms per query term to prevent query explosion. */
const MAX_SYNONYMS_PER_TERM = 2;

/** Maximum total terms in the expanded query. */
const MAX_EXPANDED_TERMS = 30;

// ─── Negation detection ─────────────────────────────────────────────

const NEGATION_PATTERNS = [
  /\bnot\s+(\w+)/i,
  /\bwithout\s+(\w+)/i,
  /\bdon'?t\s+(\w+)/i,
  /\bnever\s+(\w+)/i,
];

/**
 * Extract terms that appear in negation contexts.
 * These terms should NOT be expanded because the user explicitly
 * doesn't want them.
 */
function extractNegatedTerms(query: string): Set<string> {
  const negated = new Set<string>();
  for (const pattern of NEGATION_PATTERNS) {
    for (const match of query.matchAll(new RegExp(pattern.source, "gi"))) {
      const term = match[1]?.toLowerCase();
      if (term && term.length > 1) {
        negated.add(term);
      }
    }
  }
  return negated;
}

// ─── Code entity extraction from open paths ─────────────────────────

/**
 * Extract meaningful identifiers from file paths for query expansion.
 *
 * Examples:
 *   "src/auth/login-service.ts" → ["auth", "login", "service"]
 *   "pkg/database/postgres.go" → ["database", "postgres"]
 */
function pathEntities(openPaths: string[]): string[] {
  const entities = new Set<string>();
  for (const path of openPaths) {
    // Extract filename without extension
    const basename =
      path
        .split("/")
        .pop()
        // biome-ignore lint/performance/useTopLevelRegex: warning suppression
        ?.replace(/\.[^.]+$/, "") ?? "";
    // Split on separators: -, _, ., camelCase boundaries
    // biome-ignore lint/performance/useTopLevelRegex: warning suppression
    const parts = basename.split(/[-_.]+/);
    for (const part of parts) {
      // Further split camelCase
      // biome-ignore lint/performance/useTopLevelRegex: warning suppression
      const words = part.split(/(?<=[a-z])(?=[A-Z])/);
      for (const word of words) {
        const cleaned = word.toLowerCase().trim();
        if (cleaned.length > 2 && cleaned.length < 30) {
          entities.add(cleaned);
        }
      }
    }
    // Also add directory names (last 2 segments)
    const dirs = path.split("/").slice(-3, -1);
    for (const dir of dirs) {
      const cleaned = dir.toLowerCase().trim();
      if (cleaned.length > 2 && !cleaned.startsWith(".")) {
        entities.add(cleaned);
      }
    }
  }
  return [...entities].slice(0, 10);
}

// ─── Main expansion API ─────────────────────────────────────────────

export interface ExpansionResult {
  /** The expanded query text for FTS5 search */
  expandedQuery: string;
  /** Original query terms */
  originalTerms: string[];
  /** Synonyms that were added */
  addedSynonyms: string[];
  /** Code entities that were injected */
  injectedEntities: string[];
  /** Whether the query was expanded at all */
  expanded: boolean;
}

/**
 * Expand a query with synonyms and code-path context.
 *
 * Algorithm:
 * 1. Extract original terms from the query
 * 2. Detect negated terms (don't expand those)
 * 3. For each non-negated term, add top-2 synonyms
 * 4. If openPaths provided, inject path-derived entities
 * 5. Limit total terms to MAX_EXPANDED_TERMS
 *
 * The output is suitable for FTS5 MATCH. For vector search, the
 * expanded terms increase the semantic signal in the embedding.
 */
export function expandQuery(
  query: string,
  opts: {
    openPaths?: string[];
    maxSynonymsPerTerm?: number;
  } = {},
): ExpansionResult {
  const maxSynonyms = opts.maxSynonymsPerTerm ?? MAX_SYNONYMS_PER_TERM;
  const negated = extractNegatedTerms(query);

  // Step 1: Extract original terms
  const originalTerms = query
    .toLowerCase()
    // biome-ignore lint/performance/useTopLevelRegex: warning suppression
    .split(/\s+/)
    .filter((t) => t.length > 1)
    .filter(
      (t) =>
        // biome-ignore lint/performance/useTopLevelRegex: warning suppression
        !/^(the|a|an|is|are|was|were|be|been|being|have|has|had|do|does|did|will|would|shall|should|may|might|must|can|could|to|of|in|for|on|with|at|by|from|as|into|through|during|before|after|above|below|between|under|again|further|then|once|here|there|when|where|why|how|all|both|each|few|more|most|other|some|such|only|own|same|so|than|too|very|just|about|also|if|or|but|and|not|no|nor|neither|either)$/i.test(
          t,
        ),
    )
    .slice(0, 20);

  // Step 2: Add synonyms for non-negated terms
  const addedSynonyms: string[] = [];
  const expandedTerms = new Set(originalTerms);

  for (const term of originalTerms) {
    if (negated.has(term)) {
      continue;
    }
    const synonyms = SYNONYM_MAP[term];
    if (synonyms) {
      let added = 0;
      for (const synonym of synonyms) {
        if (added >= maxSynonyms) {
          break;
        }
        if (!expandedTerms.has(synonym)) {
          expandedTerms.add(synonym);
          addedSynonyms.push(synonym);
          added++;
        }
      }
    }
  }

  // Step 3: Inject code entities from open paths
  const injectedEntities: string[] = [];
  if (opts.openPaths?.length) {
    const entities = pathEntities(opts.openPaths);
    for (const entity of entities) {
      if (!expandedTerms.has(entity) && expandedTerms.size < MAX_EXPANDED_TERMS) {
        expandedTerms.add(entity);
        injectedEntities.push(entity);
      }
    }
  }

  // Step 4: Cap total terms
  const finalTerms = [...expandedTerms].slice(0, MAX_EXPANDED_TERMS);

  return {
    expandedQuery: finalTerms.join(" OR "),
    originalTerms,
    addedSynonyms,
    injectedEntities,
    expanded: addedSynonyms.length > 0 || injectedEntities.length > 0,
  };
}

/**
 * Expand a query specifically for vector/embedding search.
 * Unlike FTS5 expansion (OR-separated terms), embedding search uses
 * the expanded text as a single string for the embedding model.
 */
export function expandQueryForEmbedding(
  query: string,
  opts: { openPaths?: string[] } = {},
): string {
  const result = expandQuery(query, opts);
  if (!result.expanded) {
    return query;
  }

  // For embedding: concatenate original query + key synonyms + path entities
  const parts = [query];

  if (result.addedSynonyms.length > 0) {
    parts.push(result.addedSynonyms.slice(0, 5).join(" "));
  }

  if (result.injectedEntities.length > 0) {
    parts.push(result.injectedEntities.slice(0, 5).join(" "));
  }

  return parts.join(" | ");
}

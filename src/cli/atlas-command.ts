import type { Command } from "commander";

import type { CodeEntity, MemoryItem, StaleMemoryReport } from "../domain/schema";
import { getCodeEntitiesForMemoryRows, listMemoryItems } from "../persistence/repository";
import { getCodeImpact } from "../service/graph-service";
import { detectStaleMemories } from "../service/lifecycle-service";
import { withDb } from "./with-db";

interface AtlasNode {
  id: string;
  label: string;
  kind: "memory" | "file" | "function" | "class" | "module" | "section";
  path?: string;
  symbol?: string | null;
  severity?: "low" | "medium" | "high";
  memory?: MemoryItem;
  entity?: CodeEntity;
  staleReasons?: string[];
}

interface AtlasEdge {
  id: string;
  source: string;
  target: string;
  label: string;
  kind: "memory_code" | "memory_memory" | "affected_path" | "stale_reason";
  confidence?: number;
}

interface AtlasGraph {
  query: { path?: string; symbol?: string | null; depth: number };
  nodes: AtlasNode[];
  edges: AtlasEdge[];
  stale?: StaleMemoryReport;
  summary: {
    node_count: number;
    edge_count: number;
    memory_count: number;
    code_count: number;
    stale_count: number;
  };
}

function parseDepth(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 3) {
    throw new Error("--depth must be an integer between 1 and 3.");
  }
  return parsed;
}

function codeNodeId(entity: CodeEntity): string {
  return `code:${entity.entity_type}:${entity.path}:${entity.symbol ?? ""}`;
}

function memoryNodeId(memoryId: string): string {
  return `memory:${memoryId}`;
}

function addNode(nodes: Map<string, AtlasNode>, node: AtlasNode): void {
  const existing = nodes.get(node.id);
  nodes.set(node.id, existing ? { ...existing, ...node } : node);
}

function addEdge(edges: Map<string, AtlasEdge>, edge: AtlasEdge): void {
  edges.set(edge.id, edge);
}

function annotateStale(nodes: Map<string, AtlasNode>, stale?: StaleMemoryReport): void {
  if (!stale) {
    return;
  }
  for (const finding of stale.results) {
    const id = memoryNodeId(finding.memory.id);
    const existing = nodes.get(id);
    if (!existing) {
      addNode(nodes, {
        id,
        label: `${finding.memory.kind}: ${finding.memory.text.slice(0, 48)}`,
        kind: "memory",
        memory: finding.memory,
      });
    }
    const node = nodes.get(id);
    if (node) {
      node.severity = finding.severity;
      node.staleReasons = finding.reasons.map((reason) => reason.reason);
    }
  }
}

function buildGraph(input: {
  projectId: string;
  path?: string;
  symbol?: string;
  depth: number;
  includeStale: boolean;
  db: Parameters<typeof listMemoryItems>[0];
}): AtlasGraph {
  const nodes = new Map<string, AtlasNode>();
  const edges = new Map<string, AtlasEdge>();
  const stale = input.includeStale
    ? detectStaleMemories(input.db, {
        projectId: input.projectId,
        path: input.path,
        symbol: input.symbol,
        includeConflicts: true,
        limit: 100,
      })
    : undefined;

  if (input.path) {
    const impact = getCodeImpact(input.db, {
      projectId: input.projectId,
      path: input.path,
      symbol: input.symbol,
      depth: input.depth,
    });

    for (const entity of impact.entities) {
      addNode(nodes, {
        id: codeNodeId(entity),
        label: entity.symbol ?? entity.path.split("/").pop() ?? entity.path,
        kind: entity.entity_type,
        path: entity.path,
        symbol: entity.symbol,
        entity,
      });
    }

    for (const linked of impact.linked_memories) {
      const memoryId = memoryNodeId(linked.item.id);
      addNode(nodes, {
        id: memoryId,
        label: `${linked.item.kind}: ${linked.item.text.slice(0, 48)}`,
        kind: "memory",
        memory: linked.item,
      });
      for (const entity of impact.entities) {
        addEdge(edges, {
          id: `memory_code:${linked.link.id}:${entity.id}`,
          source: memoryId,
          target: codeNodeId(entity),
          label: linked.link.relation,
          kind: "memory_code",
          confidence: linked.link.confidence,
        });
      }
    }

    for (const related of impact.related_memories) {
      const sourceId = memoryNodeId(related.edge.source_memory_id);
      const targetId = memoryNodeId(related.edge.target_memory_id);
      addNode(nodes, {
        id: memoryNodeId(related.item.id),
        label: `${related.item.kind}: ${related.item.text.slice(0, 48)}`,
        kind: "memory",
        memory: related.item,
      });
      addEdge(edges, {
        id: `memory_memory:${related.edge.id}`,
        source: sourceId,
        target: targetId,
        label: related.edge.relation,
        kind: "memory_memory",
        confidence: related.edge.confidence,
      });
    }

    for (const affected of impact.affected_paths) {
      const codeId = codeNodeId(affected.entity);
      addNode(nodes, {
        id: codeId,
        label:
          affected.entity.symbol ?? affected.entity.path.split("/").pop() ?? affected.entity.path,
        kind: affected.entity.entity_type,
        path: affected.entity.path,
        symbol: affected.entity.symbol,
        entity: affected.entity,
      });
      addEdge(edges, {
        id: `affected_path:${affected.memory_id}:${affected.entity.id}`,
        source: memoryNodeId(affected.memory_id),
        target: codeId,
        label: affected.relation,
        kind: "affected_path",
      });
    }
  } else {
    const memories = listMemoryItems(input.db, input.projectId, { status: "active", limit: 100 });
    for (const memory of memories) {
      addNode(nodes, {
        id: memoryNodeId(memory.id),
        label: `${memory.kind}: ${memory.text.slice(0, 48)}`,
        kind: "memory",
        memory,
      });
    }
    const rows = getCodeEntitiesForMemoryRows(
      input.db,
      input.projectId,
      memories.map((memory) => memory.id),
    );
    for (const row of rows) {
      const codeId = codeNodeId(row.entity);
      addNode(nodes, {
        id: codeId,
        label: row.entity.symbol ?? row.entity.path.split("/").pop() ?? row.entity.path,
        kind: row.entity.entity_type,
        path: row.entity.path,
        symbol: row.entity.symbol,
        entity: row.entity,
      });
      addEdge(edges, {
        id: `memory_code:${row.link.id}`,
        source: memoryNodeId(row.memoryId),
        target: codeId,
        label: row.link.relation,
        kind: "memory_code",
        confidence: row.link.confidence,
      });
    }
  }

  annotateStale(nodes, stale);

  const nodeList = [...nodes.values()];
  const edgeList = [...edges.values()].filter(
    (edge) => nodes.has(edge.source) && nodes.has(edge.target),
  );
  return {
    query: { path: input.path, symbol: input.symbol ?? null, depth: input.depth },
    nodes: nodeList,
    edges: edgeList,
    stale,
    summary: {
      node_count: nodeList.length,
      edge_count: edgeList.length,
      memory_count: nodeList.filter((node) => node.kind === "memory").length,
      code_count: nodeList.filter((node) => node.kind !== "memory").length,
      stale_count: stale?.summary.flagged_memory_count ?? 0,
    },
  };
}

export function registerAtlasCommand(program: Command): void {
  program
    .command("atlas")
    .description("Build a memory-code atlas graph for a path or workspace")
    .option("--path <path>", "Focus graph on a code path")
    .option("--symbol <symbol>", "Focus graph on a symbol")
    .option("--depth <number>", "Memory graph traversal depth", "2")
    .option("--no-stale", "Skip stale memory overlay")
    .option("--json", "Print JSON")
    .option("--db <path>", "Custom database path")
    .action(
      withDb((db, config, opts) => {
        const graph = buildGraph({
          db,
          projectId: config.projectId,
          path: opts.path,
          symbol: opts.symbol,
          depth: parseDepth(opts.depth),
          includeStale: opts.stale !== false,
        });
        if (opts.json) {
          console.log(JSON.stringify(graph, null, 2));
          return;
        }
        console.log(
          `atlas: ${graph.summary.node_count} nodes, ${graph.summary.edge_count} edges, stale=${graph.summary.stale_count}`,
        );
      }),
    );
}

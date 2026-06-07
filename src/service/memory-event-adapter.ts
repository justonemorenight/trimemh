import type { HookCaptureEvent } from "./hook-service";

export interface NormalizedMemoryEvent {
  agent_id: string;
  session_id: string | null;
  parent_session_id: string | null;
  event: HookCaptureEvent;
  cwd: string | null;
  tool: string | null;
  files: string[];
  summary: string;
  risk_signals: string[];
  payload_hash: string;
  raw_payload: unknown;
}

export interface MemoryEventAdapter {
  readonly target: string;
  normalize(input: {
    event: HookCaptureEvent;
    agent: string;
    payload: unknown;
    payloadHash: string;
    sanitizedPayload: string;
  }): NormalizedMemoryEvent;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function nestedString(payload: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
    if (isRecord(value)) {
      const nested = nestedString(value, keys);
      if (nested) {
        return nested;
      }
    }
  }
  return null;
}

function arrayStrings(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim());
}

function collectFiles(payload: unknown): string[] {
  if (!isRecord(payload)) {
    return [];
  }

  const direct = [
    ...arrayStrings(payload.files),
    ...arrayStrings(payload.file_paths),
    ...arrayStrings(payload.open_paths),
  ];
  const toolInput = isRecord(payload.tool_input) ? payload.tool_input : {};
  const toolFiles = [
    stringValue(toolInput.file_path),
    stringValue(toolInput.path),
    ...arrayStrings(toolInput.files),
  ].filter((entry): entry is string => Boolean(entry));

  return [...new Set([...direct, ...toolFiles])];
}

function detectRiskSignals(input: {
  event: HookCaptureEvent;
  sanitizedPayload: string;
  tool: string | null;
}): string[] {
  const signals: string[] = [];
  const lower = input.sanitizedPayload.toLowerCase();
  if (lower.includes("[redacted]") || lower.includes("[redacted_private]")) {
    signals.push("sensitive_payload");
  }
  if (lower.includes("[truncated_hook_payload]")) {
    signals.push("large_payload");
  }
  if (input.event === "user_prompt_submit") {
    signals.push("raw_user_prompt");
  }
  if (input.event === "pre_tool_use" || input.event === "post_tool_use") {
    signals.push("tool_observation");
  }
  if (input.tool && ["bash", "shell", "terminal"].includes(input.tool.toLowerCase())) {
    signals.push("shell_tool");
  }
  return [...new Set(signals)];
}

function firstLine(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 180 ? `${line.slice(0, 180)}...` : line;
}

class StaticMemoryEventAdapter implements MemoryEventAdapter {
  constructor(readonly target: string) {}

  normalize(input: {
    event: HookCaptureEvent;
    agent: string;
    payload: unknown;
    payloadHash: string;
    sanitizedPayload: string;
  }): NormalizedMemoryEvent {
    const payload = isRecord(input.payload) ? input.payload : {};
    const tool =
      nestedString(payload, ["tool_name", "tool", "name"]) ??
      nestedString(payload, ["tool_use_name"]);
    const sessionId =
      nestedString(payload, ["session_id", "sessionId", "conversation_id", "run_id"]) ?? null;
    const parentSessionId =
      nestedString(payload, ["parent_session_id", "parentSessionId", "parent_run_id"]) ?? null;
    const cwd = nestedString(payload, ["cwd", "project_dir", "workspace", "working_directory"]);
    const files = collectFiles(payload);
    const summary = [
      `${input.agent} ${input.event}`,
      tool ? `tool=${tool}` : null,
      files.length > 0 ? `files=${files.slice(0, 5).join(",")}` : null,
      firstLine(input.sanitizedPayload),
    ]
      .filter(Boolean)
      .join(" | ");

    return {
      agent_id: input.agent,
      session_id: sessionId,
      parent_session_id: parentSessionId,
      event: input.event,
      cwd,
      tool,
      files,
      summary,
      risk_signals: detectRiskSignals({
        event: input.event,
        sanitizedPayload: input.sanitizedPayload,
        tool,
      }),
      payload_hash: input.payloadHash,
      raw_payload: input.payload,
    };
  }
}

export class ClaudeCodeAdapter extends StaticMemoryEventAdapter {
  constructor() {
    super("claude-code");
  }
}

export class CodexAdapter extends StaticMemoryEventAdapter {
  constructor() {
    super("codex");
  }
}

export class GenericMemoryEventAdapter extends StaticMemoryEventAdapter {
  constructor() {
    super("generic");
  }
}

const ADAPTERS: Record<string, MemoryEventAdapter> = {
  "claude-code": new ClaudeCodeAdapter(),
  codex: new CodexAdapter(),
  generic: new GenericMemoryEventAdapter(),
};

export function adapterForAgent(agent: string): MemoryEventAdapter {
  return ADAPTERS[agent] ?? ADAPTERS.generic;
}

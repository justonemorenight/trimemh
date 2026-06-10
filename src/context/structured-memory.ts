import type { MemoryItem, MemoryKind } from "../domain/schema";
import type { EvidenceLabel } from "./compression-policy";
import { EVIDENCE_LABELS } from "./compression-policy";

export const STRUCTURED_CONTEXT_KEY = "structured_context_v1";
export const STRUCTURED_CONTEXT_GENERATOR = "trimemh:structured-context-v1";

export interface StructuredEvidenceSpan {
  id: string;
  label: EvidenceLabel;
  text: string;
  score: number;
  source_start?: number;
  source_end?: number;
}

export interface StructuredContextV1 {
  version: 1;
  generated_by: string;
  source_text_length: number;
  facts: string[];
  decisions: string[];
  constraints: string[];
  open_questions: string[];
  failure_modes: string[];
  evidence_spans: StructuredEvidenceSpan[];
}

const MAX_BUCKET_ITEMS = 8;
const MAX_SPANS = 12;
const MIN_SPAN_CHARS = 18;
const MAX_SPAN_CHARS = 420;
const SENTENCE_SPLIT_RE = /(?<=[.!?])\s+|\n+/g;
const WHITESPACE_RE = /\s+/g;
const DECISION_TEXT_RE = /\b(decision|decided|choose|chosen|use|adopt)\b/;
const CONSTRAINT_TEXT_RE = /\b(must|required|never|constraint|rule|invariant|only|do not|don't)\b/;
const FAILURE_TEXT_RE = /\b(error|failed|failure|bug|mistake|regression|gotcha)\b/;
const OPEN_QUESTION_TEXT_RE = /\?|open question|unknown|todo|needs follow-up/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonRecord(json: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json || "{}");
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function validLabel(value: unknown): value is EvidenceLabel {
  return typeof value === "string" && EVIDENCE_LABELS.includes(value as EvidenceLabel);
}

function parseSpan(value: unknown): StructuredEvidenceSpan | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    !(typeof value.id === "string" && validLabel(value.label) && typeof value.text === "string")
  ) {
    return null;
  }
  const score = typeof value.score === "number" && Number.isFinite(value.score) ? value.score : 0.5;
  return {
    id: value.id,
    label: value.label,
    text: value.text,
    score,
    source_start:
      typeof value.source_start === "number" && Number.isFinite(value.source_start)
        ? value.source_start
        : undefined,
    source_end:
      typeof value.source_end === "number" && Number.isFinite(value.source_end)
        ? value.source_end
        : undefined,
  };
}

export function parseStructuredContext(metadataJson: string): StructuredContextV1 | null {
  const metadata = parseJsonRecord(metadataJson);
  const structured = metadata[STRUCTURED_CONTEXT_KEY];
  if (!isRecord(structured) || structured.version !== 1) {
    return null;
  }
  const evidence = Array.isArray(structured.evidence_spans)
    ? structured.evidence_spans
        .map(parseSpan)
        .filter((span): span is StructuredEvidenceSpan => span !== null)
    : [];
  return {
    version: 1,
    generated_by:
      typeof structured.generated_by === "string"
        ? structured.generated_by
        : STRUCTURED_CONTEXT_GENERATOR,
    source_text_length:
      typeof structured.source_text_length === "number" &&
      Number.isFinite(structured.source_text_length)
        ? structured.source_text_length
        : 0,
    facts: stringArray(structured.facts).slice(0, MAX_BUCKET_ITEMS),
    decisions: stringArray(structured.decisions).slice(0, MAX_BUCKET_ITEMS),
    constraints: stringArray(structured.constraints).slice(0, MAX_BUCKET_ITEMS),
    open_questions: stringArray(structured.open_questions).slice(0, MAX_BUCKET_ITEMS),
    failure_modes: stringArray(structured.failure_modes).slice(0, MAX_BUCKET_ITEMS),
    evidence_spans: evidence.slice(0, MAX_SPANS),
  };
}

function normalizeSpan(text: string): string {
  return text.replace(WHITESPACE_RE, " ").trim().slice(0, MAX_SPAN_CHARS);
}

function classifySpan(text: string, kind: MemoryKind): EvidenceLabel {
  const lower = text.toLowerCase();
  if (kind === "decision" || DECISION_TEXT_RE.test(lower)) {
    return "decision";
  }
  if (
    kind === "procedure" ||
    kind === "security_rule" ||
    kind === "trade_rule" ||
    CONSTRAINT_TEXT_RE.test(lower)
  ) {
    return "constraint";
  }
  if (kind === "mistake" || FAILURE_TEXT_RE.test(lower)) {
    return "failure_mode";
  }
  if (OPEN_QUESTION_TEXT_RE.test(lower)) {
    return "open_question";
  }
  return "fact";
}

function baseScore(label: EvidenceLabel, kind: MemoryKind): number {
  const labelScore: Record<EvidenceLabel, number> = {
    fact: 0.5,
    decision: 0.75,
    constraint: 0.7,
    open_question: 0.45,
    failure_mode: 0.65,
  };
  const kindBoost =
    kind === "security_rule" || kind === "trade_rule"
      ? 0.25
      : kind === "procedure" || kind === "mistake" || kind === "decision"
        ? 0.15
        : 0;
  return Number((labelScore[label] + kindBoost).toFixed(3));
}

function sentenceCandidates(text: string): Array<{ text: string; start: number; end: number }> {
  const candidates: Array<{ text: string; start: number; end: number }> = [];
  let searchStart = 0;
  for (const raw of text.split(SENTENCE_SPLIT_RE)) {
    const normalized = normalizeSpan(raw);
    if (normalized.length < MIN_SPAN_CHARS) {
      continue;
    }
    const index = text.indexOf(raw, searchStart);
    const start = index >= 0 ? index : searchStart;
    const end = start + raw.length;
    searchStart = end;
    candidates.push({ text: normalized, start, end });
  }
  if (candidates.length === 0) {
    const normalized = normalizeSpan(text);
    if (normalized.length >= MIN_SPAN_CHARS) {
      candidates.push({ text: normalized, start: 0, end: text.length });
    }
  }
  return candidates;
}

function pushBucket(target: string[], value: string): void {
  if (target.length < MAX_BUCKET_ITEMS && !target.includes(value)) {
    target.push(value);
  }
}

export function deriveStructuredContext(input: {
  text: string;
  kind: MemoryKind;
}): StructuredContextV1 {
  const facts: string[] = [];
  const decisions: string[] = [];
  const constraints: string[] = [];
  const openQuestions: string[] = [];
  const failureModes: string[] = [];
  const evidence: StructuredEvidenceSpan[] = [];

  for (const candidate of sentenceCandidates(input.text)) {
    if (evidence.length >= MAX_SPANS) {
      break;
    }
    const label = classifySpan(candidate.text, input.kind);
    const score = baseScore(label, input.kind);
    const span: StructuredEvidenceSpan = {
      id: `span-${evidence.length + 1}`,
      label,
      text: candidate.text,
      score,
      source_start: candidate.start,
      source_end: candidate.end,
    };
    evidence.push(span);

    if (label === "decision") {
      pushBucket(decisions, candidate.text);
    } else if (label === "constraint") {
      pushBucket(constraints, candidate.text);
    } else if (label === "open_question") {
      pushBucket(openQuestions, candidate.text);
    } else if (label === "failure_mode") {
      pushBucket(failureModes, candidate.text);
    } else {
      pushBucket(facts, candidate.text);
    }
  }

  return {
    version: 1,
    generated_by: STRUCTURED_CONTEXT_GENERATOR,
    source_text_length: input.text.length,
    facts,
    decisions,
    constraints,
    open_questions: openQuestions,
    failure_modes: failureModes,
    evidence_spans: evidence,
  };
}

export function structuredContextForMemory(item: MemoryItem): StructuredContextV1 {
  return parseStructuredContext(item.metadata_json) ?? deriveStructuredContext(item);
}

export function withStructuredContextMetadata(input: {
  metadataJson?: string;
  metadata?: Record<string, unknown>;
  text: string;
  kind: MemoryKind;
}): Record<string, unknown> {
  const existing = input.metadata ?? parseJsonRecord(input.metadataJson ?? "{}");
  return {
    ...existing,
    [STRUCTURED_CONTEXT_KEY]: deriveStructuredContext({ text: input.text, kind: input.kind }),
  };
}

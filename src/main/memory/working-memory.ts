import type { AgentEvent } from '../../shared/agent-events';

export interface WorkingMemorySnapshot {
  goal?: string;
  constraints: string[];
  openLoops: string[];
  recentCorrections: string[];
  recentDecisions: string[];
  pendingFacts: string[];
  updatedAt: number;
  lastCompactedAt?: number;
}

const SNIPPET_MAX_CHARS = 160;
const FIELD_MAX_ITEMS = 3;
const CONSTRAINT_MARKERS = /不要|别|必须|务必|仅|只能|限制|记得|请勿|must|don't|do not|only|limit/i;
const CORRECTION_MARKERS = /不是|改成|改为|更正|纠正|其实|别用|instead|actually|correction/i;
const DECISION_MARKERS = /决定|采用|改为|定为|保持|继续|结论|方案|use|choose|decide/i;

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function toSnippet(text: string): string {
  const normalized = normalizeText(text);
  if (normalized.length <= SNIPPET_MAX_CHARS) return normalized;
  return `${normalized.slice(0, SNIPPET_MAX_CHARS - 1)}...`;
}

function firstUsefulSentence(text: string): string | undefined {
  const normalized = normalizeText(text);
  if (!normalized) return undefined;
  const [first] = normalized.split(/(?<=[。！？.!?])\s+|\n+/);
  return toSnippet(first ?? normalized);
}

function extractTaggedSentences(text: string, matcher: RegExp): string[] {
  const sentences = normalizeText(text)
    .split(/(?<=[。！？.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  return sentences
    .filter((sentence) => matcher.test(sentence))
    .map((sentence) => toSnippet(sentence));
}

function pushUnique(list: string[], values: string[]): string[] {
  const next = [...list];
  for (const value of values) {
    if (!value || next.includes(value)) continue;
    next.unshift(value);
  }
  return next.slice(0, FIELD_MAX_ITEMS);
}

export class WorkingMemoryStore {
  private snapshots = new Map<string, WorkingMemorySnapshot>();

  private ensure(sessionId: string): WorkingMemorySnapshot {
    let snapshot = this.snapshots.get(sessionId);
    if (!snapshot) {
      snapshot = {
        constraints: [],
        openLoops: [],
        recentCorrections: [],
        recentDecisions: [],
        pendingFacts: [],
        updatedAt: Date.now(),
      };
      this.snapshots.set(sessionId, snapshot);
    }
    return snapshot;
  }

  applyEvent(event: AgentEvent): void {
    const snapshot = this.ensure(event.sessionId);
    switch (event.type) {
      case 'message.final': {
        if (event.role === 'user') {
          const goal = firstUsefulSentence(event.content.text);
          if (goal) snapshot.goal = goal;
          snapshot.constraints = pushUnique(
            snapshot.constraints,
            extractTaggedSentences(event.content.text, CONSTRAINT_MARKERS),
          );
          snapshot.recentCorrections = pushUnique(
            snapshot.recentCorrections,
            extractTaggedSentences(event.content.text, CORRECTION_MARKERS),
          );
        }
        if (event.role === 'assistant') {
          snapshot.recentDecisions = pushUnique(
            snapshot.recentDecisions,
            extractTaggedSentences(event.content.text, DECISION_MARKERS),
          );
        }
        snapshot.updatedAt = event.ts;
        return;
      }
      case 'tool.start': {
        snapshot.openLoops = pushUnique(snapshot.openLoops, [
          `${event.toolName}: ${toSnippet(event.target)}`,
        ]);
        snapshot.updatedAt = event.ts;
        return;
      }
      case 'tool.end':
      case 'tool.blocked': {
        const key = `${event.toolName}: ${toSnippet(event.target)}`;
        snapshot.openLoops = snapshot.openLoops.filter((loop) => loop !== key);
        snapshot.updatedAt = event.ts;
        return;
      }
      case 'memory.recorded': {
        snapshot.pendingFacts = pushUnique(snapshot.pendingFacts, [
          `${event.kind}: ${event.title}`,
        ]);
        snapshot.updatedAt = event.ts;
        return;
      }
      default:
        return;
    }
  }

  markCompacted(sessionId: string): void {
    const snapshot = this.ensure(sessionId);
    snapshot.openLoops = snapshot.openLoops.slice(0, FIELD_MAX_ITEMS);
    snapshot.constraints = snapshot.constraints.slice(0, FIELD_MAX_ITEMS);
    snapshot.recentCorrections = snapshot.recentCorrections.slice(0, FIELD_MAX_ITEMS);
    snapshot.recentDecisions = snapshot.recentDecisions.slice(0, FIELD_MAX_ITEMS);
    snapshot.pendingFacts = snapshot.pendingFacts.slice(0, FIELD_MAX_ITEMS);
    snapshot.lastCompactedAt = Date.now();
    snapshot.updatedAt = snapshot.lastCompactedAt;
  }

  buildContext(sessionId: string): string {
    const snapshot = this.snapshots.get(sessionId);
    if (!snapshot) return '';
    const lines: string[] = [];
    if (snapshot.goal) lines.push(`- [goal] ${snapshot.goal}`);
    if (snapshot.constraints.length > 0) {
      lines.push(`- [constraints] ${snapshot.constraints.join(' ; ')}`);
    }
    if (snapshot.openLoops.length > 0) {
      lines.push(`- [open_loops] ${snapshot.openLoops.join(' ; ')}`);
    }
    if (snapshot.recentCorrections.length > 0) {
      lines.push(`- [recent_corrections] ${snapshot.recentCorrections.join(' ; ')}`);
    }
    if (snapshot.recentDecisions.length > 0) {
      lines.push(`- [recent_decisions] ${snapshot.recentDecisions.join(' ; ')}`);
    }
    if (snapshot.pendingFacts.length > 0) {
      lines.push(`- [pending_facts] ${snapshot.pendingFacts.join(' ; ')}`);
    }
    return lines.join('\n');
  }

  getSnapshot(sessionId: string): WorkingMemorySnapshot | undefined {
    const snapshot = this.snapshots.get(sessionId);
    if (!snapshot) return undefined;
    return {
      ...snapshot,
      constraints: [...snapshot.constraints],
      openLoops: [...snapshot.openLoops],
      recentCorrections: [...snapshot.recentCorrections],
      recentDecisions: [...snapshot.recentDecisions],
      pendingFacts: [...snapshot.pendingFacts],
    };
  }

  clear(sessionId: string): void {
    this.snapshots.delete(sessionId);
  }

  clearAll(): void {
    this.snapshots.clear();
  }
}

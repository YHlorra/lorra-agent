import type { AgentSession } from '@earendil-works/pi-coding-agent';
import type { SessionStatus } from '../../shared/agent-events';

export interface SessionRecord {
  sessionId: string;
  piSessionHandle: AgentSession;
  status: SessionStatus;
  /**
 * M1 (Oracle ): handle to unsubscribe from the AgentSession event
 * stream. Stored so subsequent `send` calls can detach the previous
 * subscription before attaching a new one — otherwise duplicate events
 * reach the router and seq numbering drifts.
 */
  unsubscribe?: () => void;
  lastSeq: number;
}

export class SessionRegistry {
  private records = new Map<string, SessionRecord>();

  register(sessionId: string, handle: AgentSession): SessionRecord {
    const record: SessionRecord = {
      sessionId,
      piSessionHandle: handle,
      status: 'idle',
      lastSeq: 0,
    };
    this.records.set(sessionId, record);
    return record;
  }

  get(sessionId: string): SessionRecord | undefined {
    return this.records.get(sessionId);
  }

  remove(sessionId: string): void {
    const record = this.records.get(sessionId);
    record?.unsubscribe?.();
    record?.piSessionHandle.dispose();
    this.records.delete(sessionId);
  }

  activeRecord(): SessionRecord | undefined {
    for (const record of this.records.values()) {
      if (record.status !== 'idle') {
        return record;
      }
    }
    return undefined;
  }

  updateStatus(sessionId: string, status: SessionStatus): void {
    const record = this.records.get(sessionId);
    if (!record) {
      throw new Error(`SessionRegistry: no record for sessionId "${sessionId}"`);
    }
    record.status = status;
  }

  nextSeq(sessionId: string): number {
    const record = this.records.get(sessionId);
    if (!record) {
      throw new Error(`SessionRegistry: no record for sessionId "${sessionId}"`);
    }
    return ++record.lastSeq;
  }

  allRecords(): SessionRecord[] {
    return Array.from(this.records.values());
  }

  async shutdownAll(timeoutMs = 2000): Promise<void> {
    const records = Array.from(this.records.values());
    await Promise.all(
      records.map(async (record) => {
        record.unsubscribe?.();
        try {
          await record.piSessionHandle.abort();
        } catch {
          // abort may throw if session was never started; not fatal here.
        }
        const idlePromise = record.piSessionHandle.waitForIdle();
        const timeoutPromise = new Promise<void>((resolve) => {
          setTimeout(resolve, timeoutMs);
        });
        await Promise.race([idlePromise, timeoutPromise]);
        // N3 (Oracle ): release SDK resources so a relaunched process
        // does not see stale handles.
        try {
          record.piSessionHandle.dispose();
        } catch {
          // dispose may throw if already disposed; not fatal.
        }
      }),
    );
    this.records.clear();
  }
}

import type { WebContents } from 'electron';
import type { AgentEvent } from '../../shared/agent-events';

export class EventRouter {
  private subscribers = new Map<string, Set<WebContents>>();

  subscribe(sessionId: string, wc: WebContents): () => void {
    const set = this.subscribers.get(sessionId);
    if (set) {
      set.add(wc);
    } else {
      this.subscribers.set(sessionId, new Set([wc]));
    }
    return () => {
      this.unsubscribe(sessionId, wc);
    };
  }

  unsubscribe(sessionId: string, wc: WebContents): void {
    const set = this.subscribers.get(sessionId);
    if (!set) return;
    set.delete(wc);
    if (set.size === 0) {
      this.subscribers.delete(sessionId);
    }
  }

  emit(sessionId: string, event: AgentEvent): void {
    const set = this.subscribers.get(sessionId);
    if (!set) return;
    for (const wc of set) {
      if (wc.isDestroyed()) {
        set.delete(wc);
      } else {
        wc.send('lorra.events', event);
      }
    }
    if (set.size === 0) {
      this.subscribers.delete(sessionId);
    }
  }

  prune(): void {
    for (const [sessionId, set] of this.subscribers) {
      for (const wc of set) {
        if (wc.isDestroyed()) {
          set.delete(wc);
        }
      }
      if (set.size === 0) {
        this.subscribers.delete(sessionId);
      }
    }
  }
}

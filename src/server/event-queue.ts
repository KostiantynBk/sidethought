import { ClientMessageSchema, type ClientMessage } from '../contract/index.js';
import type { RawEvent } from '../runtime/model-port.js';
import type { SessionRunner } from '../runtime/session-runner.js';
import { projectState } from './projection.js';

export class EventQueue {
  private readonly pending: RawEvent[] = [];
  private draining = false;

  constructor(
    private readonly runner: () => SessionRunner,
    private readonly broadcast: (message: ClientMessage) => void,
  ) {}

  emit = (event: RawEvent): void => {
    this.pending.push(event);
    this.drain();
  };

  recover(eventId: string): void {
    this.draining = true;
    try {
      this.runner().recover(eventId);
    } finally {
      this.draining = false;
    }
    this.drain();
  }

  private drain(): void {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.pending.length) this.accept(this.pending.shift()!);
    } finally {
      this.draining = false;
    }
  }

  private accept(event: RawEvent): void {
    const runner = this.runner();
    const before = runner.current().domain.projectRev;
    const result = runner.accept(event);
    const after = result.state.domain.projectRev;
    if (after <= before) return;
    const message = ClientMessageSchema.parse({
      type: 'project.changed',
      projectRev: after,
      items: projectState(result.state).items,
    });
    this.broadcast(message);
  }
}

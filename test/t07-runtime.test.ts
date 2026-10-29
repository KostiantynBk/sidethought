import { expect, it } from 'vitest';
import type { Effect } from '../src/contract/index.js';
import { SessionRunner } from '../src/runtime/session-runner.js';
import { MemoryStore } from '../src/store/index.js';
import { config, readyOutput } from './t03-helpers.js';

type Batch = {
  effects: Effect[];
  persistedSeq: number | undefined;
};

function startReply(
  runner: SessionRunner,
  accept: (at: number, type: string, payload: object) => unknown,
) {
  accept(0, 'input.committed', {
    clientMsgId: 'm1',
    text: 'Hello.',
    modality: 'text',
  });
  const call = runner.current().domain.call!;
  accept(10, 'interpretation.ready', {
    requestId: call.requestId,
    callId: call.callId,
    output: readyOutput,
  });
  const timer = runner.current().domain.timers[0]!;
  accept(800, 'timer.fired', {
    timerId: timer.timerId,
    purpose: timer.purpose,
  });
  return runner.current().domain.reply!;
}

function runtime(store = new MemoryStore()) {
  let clock = 0;
  let count = 0;
  const batches: Batch[] = [];
  const runner = new SessionRunner('s', config, store, () => clock, effects => batches.push({
    effects,
    persistedSeq: store.loadSnapshot('s')?.seq,
  }));
  const accept = (at: number, type: string, payload: object) => {
    clock = at;
    return runner.accept({
      eventId: `e${++count}`,
      sessionId: 's',
      type,
      payload,
    });
  };
  const reply = startReply(runner, accept);
  const delta = (at: number, text: string) => accept(at, 'reply.chunk', {
    requestId: reply.requestId,
    callId: reply.callId,
    text,
  });
  return {
    runner,
    store,
    batches,
    accept,
    delta,
  };
}

it('journals a sentence and its preceding buffer-only delta before sending its chunk', () => {
  const world = runtime();
  expect(world.delta(900, 'Hello').effects).toEqual([]);
  expect(world.store.loadSnapshot('s')?.seq).toBe(3);
  expect(world.runner.persistenceState().unflushed).toHaveLength(1);
  const result = world.delta(910, '. ');
  expect(result.effects[0]?.type).toBe('client.send');
  expect(world.batches.at(-1)?.persistedSeq).toBe(5);
  expect(world.store.readJournal('s').slice(-2).map(event => event.type)).toEqual(['reply.chunk', 'reply.chunk']);
  expect(world.runner.persistenceState().unflushed).toEqual([]);
  expect(world.store.loadSnapshot('s')?.state.domain.deliveries[result.state.domain.reply!.deliveryId]?.sentChars)
    .toBe('Hello. '.length);
});

it('an interrupt never flushes a queued sentence chunk alongside its abort', () => {
  const world = runtime();
  world.delta(900, 'Already sent. ');
  world.delta(950, 'Still buffered');
  const sentBatch = world.batches.at(-1)!;
  expect(sentBatch.effects.some(effect => effect.type === 'client.send'
    && effect.message.type === 'assistant.chunk')).toBe(true);
  const result = world.accept(1000, 'input.committed', {
    clientMsgId: 'interrupt',
    text: 'Stop that thought.',
    modality: 'text',
    renderedUpTo: 8,
  });
  expect(world.batches.at(-1)?.effects).toEqual(result.effects);
  expect(result.effects[0]?.type).toBe('llm.abort');
  expect(result.effects.some(effect => effect.type === 'client.send'
    && effect.message.type === 'assistant.chunk')).toBe(false);
  expect(world.batches.at(-1)?.persistedSeq).toBe(6);
  expect(world.runner.persistenceState().unflushed).toEqual([]);
});

class FailingStore extends MemoryStore {
  fail = false;

  override commit(...args: Parameters<MemoryStore['commit']>): void {
    if (this.fail) throw new Error('injected commit failure');
    super.commit(...args);
  }
}

it('never emits a sentence whose durable transaction failed', () => {
  const store = new FailingStore();
  const world = runtime(store);
  world.delta(900, 'Buffered');
  const batchesBefore = world.batches.length;
  store.fail = true;
  expect(() => world.delta(910, '. ')).toThrow('injected commit failure');
  expect(world.batches).toHaveLength(batchesBefore);
  expect(store.loadSnapshot('s')?.seq).toBe(3);
  expect(world.runner.current().domain.reply?.buffer).toBe('Buffered');
});

it('persists an activity event that clears a wait timer before emitting the clear effect', () => {
  const world = runtime();
  world.accept(900, 'input.committed', {
    clientMsgId: 'wait-input',
    text: 'Please wait.',
    modality: 'text',
  });
  const call = world.runner.current().domain.call!;
  world.accept(910, 'interpretation.ready', {
    requestId: call.requestId,
    callId: call.callId,
    output: {
      ...readyOutput,
      inputKinds: [{
        inputId: call.inputIds[0]!,
        kind: 'wait',
      }],
    },
  });
  const result = world.accept(920, 'input.activity', {
    channel: 'composer',
    active: true,
  });
  expect(result.effects.some(effect => effect.type === 'timer.clear')).toBe(true);
  expect(world.batches.at(-1)?.persistedSeq).toBe(result.state.meta.seq);
  expect(world.runner.persistenceState().unflushed).toEqual([]);
});

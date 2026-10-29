import { describe, expect, it } from 'vitest';
import { idle, typing } from '../web/src/logic/activity.js';
import {
  contiguousText,
  finalProgress,
  mergeChunk,
  pendingProgress,
  renderedUpTo,
  type TranscriptDelivery,
} from '../web/src/logic/transcript.js';
import { emptyView, nextView } from '../web/src/logic/view.js';

describe('client transcript logic', () => {
  const chunks = [{ chunkIdx: 0, text: 'Hello ' }, { chunkIdx: 1, text: 'world.' }];

  it('calculates rendered offsets at a chunk boundary', () => {
    expect(renderedUpTo(chunks, 0, 6)).toBe(6);
  });

  it('calculates rendered offsets inside a chunk', () => {
    expect(renderedUpTo(chunks, 1, 3)).toBe(9);
  });

  it('merges out-of-order chunks without rendering past a gap', () => {
    let delivery: TranscriptDelivery = { deliveryId: 'one', chunks: [], stopped: false };
    delivery = mergeChunk(delivery, chunks[1]!);
    expect(contiguousText(delivery.chunks)).toBe('');
    delivery = mergeChunk(delivery, chunks[0]!);
    expect(contiguousText(delivery.chunks)).toBe('Hello world.');
    expect(mergeChunk(delivery, chunks[0]!).chunks).toHaveLength(2);
  });
});

describe('delivery completion', () => {
  it('waits until every announced chunk has rendered', () => {
    const view = nextView(emptyView(), { type: 'assistant.done', deliveryId: 'one', chunkCount: 2 });
    const partial = mergeChunk(view.deliveries.one!, { chunkIdx: 1, text: 'world' });
    expect(finalProgress(partial)).toBeUndefined();
    const complete = mergeChunk(partial, { chunkIdx: 0, text: 'hello ' });
    expect(finalProgress(complete)).toEqual({
      deliveryId: 'one',
      chunkIdx: 1,
      chars: 11,
      final: true,
      reason: 'rendered',
    });
  });

  it('returns no final progress for stopped or already completed deliveries', () => {
    const delivery: TranscriptDelivery = {
      deliveryId: 'one',
      chunks: [{ chunkIdx: 0, text: 'hello' }],
      stopped: false,
      chunkCount: 1,
    };
    expect(finalProgress({ ...delivery, stopped: true })).toBeUndefined();
    expect(finalProgress({ ...delivery, complete: true })).toBeUndefined();
  });

  it('does not invent a delivery acknowledgment for a zero-chunk PASS', () => {
    expect(finalProgress({ deliveryId: 'one', chunks: [], stopped: false, chunkCount: 0 })).toBeUndefined();
  });

  it('computes cumulative UTF-16 offsets after a previous acknowledged index', () => {
    const delivery: TranscriptDelivery = {
      deliveryId: 'one',
      chunks: [
        { chunkIdx: 0, text: 'A😀' },
        { chunkIdx: 1, text: 'xy' },
      ],
      stopped: false,
      chunkCount: 2,
    };
    expect(pendingProgress(delivery, -1).map(progress => progress.chars)).toEqual([3, 5]);
    expect(pendingProgress(delivery, 0).map(progress => progress.chars)).toEqual([5]);
    expect(finalProgress(delivery)?.chars).toBe(5);
  });

  it('ignores unknown messages without changing the view', () => {
    const view = emptyView();
    expect(nextView(view, { type: 'future.message' })).toBe(view);
  });
});

describe('composer activity', () => {
  it('stays active until the 1.5 second idle deadline', () => {
    const active = typing(1000);
    expect(idle(active, 2499).active).toBe(true);
    expect(idle(active, 2500).active).toBe(false);
  });

  it('ends activity immediately on blur', () => {
    expect(idle(typing(1000), 1001, true).active).toBe(false);
  });
});

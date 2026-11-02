import { describe, expect, it, vi } from 'vitest';
import { cleanSpeech, ReadAloud, type Synthesizer } from '../web/src/logic/speech.js';

function setup(available = true) {
  const synth: Synthesizer = { available, speak: vi.fn(), cancel: vi.fn() };
  const speech = new ReadAloud(synth);
  return { synth, speech };
}

function chunk(index: number, text: string) {
  return { type: 'assistant.chunk', deliveryId: 'delivery', chunkIdx: index, text };
}

function snapshot() {
  return {
    type: 'ui.snapshot',
    state: {
      inputs: [{ id: 'input', text: 'User text' }],
      deliveries: [{ deliveryId: 'old', text: 'Old text' }],
      streamingChunks: [{ deliveryId: 'delivery', chunkIdx: 0, text: 'Snapshot text' }],
      possiblyDelivered: [{ deliveryId: 'card', text: 'Card text' }],
    },
  };
}

describe('speech cleaning', () => {
  it('replaces each fenced or inline code block once', () => {
    expect(cleanSpeech('Before ```ts\na()\nb()\n``` and `x` after')).toBe('Before code omitted and code omitted after');
  });
  it('replaces URLs with link', () => {
    expect(cleanSpeech('See https://example.com/path now')).toBe('See link now');
  });
  it('strips markdown markers and bullets', () => {
    expect(cleanSpeech('# Header\n> **bold** | _word_\n- item')).toBe('Header bold word item');
  });
  it('does not produce an utterance for empty cleaned text', () => {
    const { speech, synth } = setup();
    speech.setEnabled(true);
    speech.receive(chunk(0, '  ** | #  '));
    expect(synth.speak).not.toHaveBeenCalled();
  });
});

describe('read-aloud controller', () => {
  it('reads new chunks in order', () => {
    const { speech, synth } = setup();
    speech.setEnabled(true);
    speech.receive(chunk(0, 'First.'));
    speech.receive(chunk(1, 'Second.'));
    expect(vi.mocked(synth.speak).mock.calls).toEqual([['First.'], ['Second.']]);
  });
  it('never reads snapshot history or replayed snapshot chunks', () => {
    const { speech, synth } = setup();
    speech.setEnabled(true);
    speech.receive(snapshot());
    speech.receive(chunk(0, 'Snapshot text'));
    expect(synth.speak).not.toHaveBeenCalled();
  });
  it('does not read when switched off, including after enabling', () => {
    const { speech, synth } = setup();
    speech.receive(chunk(0, 'Off.'));
    speech.setEnabled(true);
    speech.receive(chunk(0, 'Off.'));
    expect(synth.speak).not.toHaveBeenCalled();
  });
  it('reads a delivered contribution chunk but not a contribution card', () => {
    const { speech, synth } = setup();
    speech.setEnabled(true);
    speech.receive({ type: 'contribution.upserted', text: 'Card only' });
    speech.receive(chunk(0, 'Delivered contribution.'));
    expect(synth.speak).toHaveBeenCalledExactlyOnceWith('Delivered contribution.');
  });
  it('cancels on switch-off', () => {
    const { speech, synth } = setup();
    speech.setEnabled(true);
    speech.setEnabled(false);
    expect(synth.cancel).toHaveBeenCalledOnce();
  });
  it('cancels on a project switch', () => {
    const { speech, synth } = setup();
    speech.switchProject();
    expect(synth.cancel).toHaveBeenCalledOnce();
  });
  it('cancels on hidden page and does not speak while hidden', () => {
    const { speech, synth } = setup();
    speech.setEnabled(true);
    speech.setHidden(true);
    speech.receive(chunk(0, 'Hidden.'));
    expect(synth.cancel).toHaveBeenCalledOnce();
    expect(synth.speak).not.toHaveBeenCalled();
  });
  it('reports an unavailable synthesizer as disabled', () => {
    const { speech, synth } = setup(false);
    speech.setEnabled(true);
    speech.receive(chunk(0, 'Hello'));
    expect(speech.available).toBe(false);
    expect(synth.speak).not.toHaveBeenCalled();
  });
});

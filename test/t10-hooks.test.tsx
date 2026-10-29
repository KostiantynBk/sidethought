// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { contiguousText } from '../web/src/logic/transcript.js';
import { useComposer } from '../web/src/useComposer.js';
import { useConnection } from '../web/src/useConnection.js';

class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = FakeSocket.OPEN;
  sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(_url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  receive(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }
}

type Harness = {
  connection: ReturnType<typeof useConnection>;
  composer: ReturnType<typeof useComposer>;
};
let harness: Harness;
let root: Root;
let container: HTMLDivElement;
let visibleLimit: number | undefined;

function TestApp() {
  const connection = useConnection(true);
  const composer = useComposer(connection);
  harness = {
    connection,
    composer,
  };
  const delivery = connection.view.deliveries.delivery;
  const text = delivery ? contiguousText(delivery.chunks).slice(0, visibleLimit) : '';
  return <span id="delivery-delivery">{text}</span>;
}

function snapshot(chunks: Array<{ deliveryId: string; chunkIdx: number; text: string }> = []) {
  return {
    type: 'ui.snapshot',
    state: {
      inputs: [],
      deliveries: [],
      streamingChunks: chunks,
      possiblyDelivered: [],
      items: [],
      replyStatus: 'streaming',
    },
  };
}

function chunk(index: number, text: string) {
  return {
    type: 'assistant.chunk',
    deliveryId: 'delivery',
    chunkIdx: index,
    text,
  };
}

function messages(socket: FakeSocket, type: string) {
  return socket.sent.filter(message => message.type === type);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('WebSocket', FakeSocket);
  FakeSocket.instances = [];
  visibleLimit = undefined;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<TestApp />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('composer and connection hooks', () => {
  it('sends activity booleans for typing, idle, and blur', () => {
    const socket = FakeSocket.instances[0]!;
    act(() => harness.composer.onTyping('draft'));
    act(() => vi.advanceTimersByTime(1500));
    act(() => harness.composer.onTyping('another draft'));
    act(() => harness.composer.endActivity());
    expect(messages(socket, 'input.activity').map(message => message.payload)).toEqual([
      {
        channel: 'composer',
        active: true,
      },
      {
        channel: 'composer',
        active: false,
      },
      {
        channel: 'composer',
        active: true,
      },
      {
        channel: 'composer',
        active: false,
      },
    ]);
    expect(JSON.stringify(socket.sent)).not.toContain('draft');
  });

  it('commits the characters actually displayed during a partially rendered chunk', () => {
    const socket = FakeSocket.instances[0]!;
    visibleLimit = 3;
    act(() => socket.receive(chunk(0, 'Hello world.')));
    act(() => harness.composer.onTyping('interrupt'));
    act(() => harness.composer.commit());
    expect(messages(socket, 'input.committed')[0]?.payload).toMatchObject({
      text: 'interrupt',
      renderedUpTo: 3,
    });
  });

  it('acknowledges completion once and omits renderedUpTo from the next commit', () => {
    const socket = FakeSocket.instances[0]!;
    act(() => socket.receive(chunk(0, 'Hello.')));
    act(() => socket.receive({ type: 'assistant.done', deliveryId: 'delivery', chunkCount: 1 }));
    act(() => socket.receive({ type: 'assistant.done', deliveryId: 'delivery', chunkCount: 1 }));
    const finals = messages(socket, 'delivery.progress').filter(message => message.payload.final === true);
    expect(finals).toHaveLength(1);
    expect(finals[0]?.payload).toMatchObject({
      chars: 6,
      chunkIdx: 0,
      reason: 'rendered',
    });
    act(() => harness.composer.onTyping('next'));
    act(() => harness.composer.commit());
    expect(messages(socket, 'input.committed')[0]?.payload).not.toHaveProperty('renderedUpTo');
  });

  it('acknowledges newly rendered snapshot chunks after an actual reconnect', () => {
    const first = FakeSocket.instances[0]!;
    act(() => first.receive(chunk(0, 'A😀')));
    expect(messages(first, 'delivery.progress')[0]?.payload.chars).toBe(3);
    act(() => first.close());
    act(() => vi.advanceTimersByTime(1000));
    const second = FakeSocket.instances[1]!;
    act(() => second.receive(snapshot([
      { deliveryId: 'delivery', chunkIdx: 0, text: 'A😀' },
      { deliveryId: 'delivery', chunkIdx: 1, text: 'xy' },
    ])));
    const progress = messages(second, 'delivery.progress');
    expect(progress).toHaveLength(1);
    expect(progress[0]?.payload).toMatchObject({ chunkIdx: 1, chars: 5, final: false });
  });
});

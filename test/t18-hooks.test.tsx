// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ReadAloud, type Synthesizer } from '../web/src/logic/speech.js';
import { useComposer } from '../web/src/useComposer.js';
import { useConnection } from '../web/src/useConnection.js';

class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 1;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor() { FakeSocket.instances.push(this); }
  send(_data: string) {}
  close() { this.readyState = 3; this.onclose?.(); }
  receive(message: unknown) { this.onmessage?.({ data: JSON.stringify(message) }); }
}

let root: Root;
let container: HTMLDivElement;
let synth: Synthesizer;
let speech: ReadAloud;
let composer: ReturnType<typeof useComposer>;

function App() {
  const connection = useConnection(true, 'local', speech);
  composer = useComposer(connection, () => speech.cancel());
  return null;
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('WebSocket', FakeSocket);
  FakeSocket.instances = [];
  synth = { available: true, speak: vi.fn(), cancel: vi.fn() };
  speech = new ReadAloud(synth);
  speech.setEnabled(true);
  container = document.createElement('div');
  root = createRoot(container);
  act(() => root.render(<App />));
});

afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

it('cancels speech on composer typing', () => {
  act(() => composer.onTyping('Hello'));
  expect(synth.cancel).toHaveBeenCalledOnce();
});

it('cancels speech on send', () => {
  act(() => composer.onTyping('Hello'));
  vi.mocked(synth.cancel).mockClear();
  act(() => composer.commit());
  expect(synth.cancel).toHaveBeenCalledOnce();
});

it('cancels speech on socket disconnect', () => {
  act(() => FakeSocket.instances[0]!.close());
  expect(synth.cancel).toHaveBeenCalledOnce();
});

it('does not speak chunks blocked by an interruption', () => {
  const socket = FakeSocket.instances[0]!;
  act(() => socket.receive({ type: 'assistant.chunk', deliveryId: 'd', chunkIdx: 0, text: 'First.' }));
  act(() => composer.onTyping('Stop'));
  act(() => composer.commit());
  act(() => socket.receive({ type: 'assistant.chunk', deliveryId: 'd', chunkIdx: 1, text: 'Blocked.' }));
  expect(synth.speak).toHaveBeenCalledExactlyOnceWith('First.');
});

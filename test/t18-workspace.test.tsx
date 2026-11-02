// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Workspace } from '../web/src/Workspace.js';

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
let synth: { speak: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn>; getVoices: ReturnType<typeof vi.fn> };

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('SpeechSynthesisUtterance', class { constructor(public text: string) {} });
  synth = { speak: vi.fn(), cancel: vi.fn(), getVoices: vi.fn(() => []) };
  vi.stubGlobal('speechSynthesis', synth);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(
    url.endsWith('/input-status') ? { pending: 0, failedCount: 0, needsRetry: [] } : {
      model: 'dev',
      projects: [{ id: 'local', name: 'A' }, { id: 'b', name: 'B' }],
    },
  ), { headers: { 'content-type': 'application/json' } })));
  FakeSocket.instances = [];
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

async function render() {
  await act(async () => root.render(<Workspace />));
}

it('defaults off and unlocks in the toggle handler while remembering the choice', async () => {
  await render();
  const toggle = container.querySelector('input[type=checkbox]') as HTMLInputElement;
  expect(toggle.checked).toBe(false);
  act(() => toggle.click());
  expect(synth.speak).toHaveBeenCalledOnce();
  expect(synth.speak.mock.calls[0]![0].text).toBe('');
  expect(localStorage.getItem('sidethought.readAloud')).toBe('on');
});

it('cancels speech when switching projects', async () => {
  await render();
  vi.mocked(synth.cancel).mockClear();
  const select = container.querySelector('select')!;
  act(() => {
    select.value = 'b';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(synth.cancel).toHaveBeenCalled();
});

it('cancels speech when the page becomes hidden', async () => {
  await render();
  vi.mocked(synth.cancel).mockClear();
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  expect(synth.cancel).toHaveBeenCalledOnce();
});

it('disables the switch and shows a note without speech synthesis', async () => {
  vi.stubGlobal('speechSynthesis', undefined);
  await render();
  const toggle = container.querySelector('input[type=checkbox]') as HTMLInputElement;
  expect(toggle.disabled).toBe(true);
  expect(container.textContent).toContain("This browser can't read aloud");
});

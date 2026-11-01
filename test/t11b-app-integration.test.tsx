// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../web/src/App.js';

class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = FakeSocket.OPEN;
  sent: Array<{ type: string; payload: unknown }> = [];
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

let container: HTMLDivElement;
let root: Root;

async function mountAndLogin(model: 'dev' | 'meta'): Promise<void> {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/health') return { ok: true, json: async () => ({ ok: true, model }) };
    if (url === '/login') return { ok: true };
    throw new Error(`Unexpected fetch: ${url}`);
  }));
  await act(async () => root.render(<App />));
  const form = container.querySelector('form');
  expect(form).not.toBeNull();
  await act(async () => {
    form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('WebSocket', FakeSocket);
  FakeSocket.instances = [];
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('research UI integration', () => {
  it('shows the dev label only when health reports dev', async () => {
    await mountAndLogin('dev');
    const header = container.querySelector('h1')?.textContent ?? '';
    expect(header).toContain('dev model: no real AI');
    expect(header).not.toContain('Meta Spark');
  });

  it('shows Meta Spark and not the dev label when health reports meta', async () => {
    await mountAndLogin('meta');
    const header = container.querySelector('h1')?.textContent ?? '';
    expect(header).toContain('Meta Spark');
    expect(header).not.toContain('dev model: no real AI');
  });

  it('sends job.cancelRequested with the clicked job ID over the connection', async () => {
    await mountAndLogin('dev');
    const socket = FakeSocket.instances[0];
    expect(socket).toBeDefined();
    act(() => socket!.receive({
      type: 'job.updated',
      jobId: 'research-17',
      publicQuery: 'A public query',
      state: 'running',
    }));
    const button = Array.from(container.querySelectorAll('button'))
      .find(candidate => /cancel/i.test(candidate.textContent ?? ''));
    expect(button).toBeDefined();
    act(() => button!.click());
    expect(socket!.sent).toContainEqual({
      type: 'job.cancelRequested',
      payload: { jobId: 'research-17' },
    });
  });
});

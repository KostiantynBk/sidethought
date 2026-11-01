// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Workspace } from '../web/src/Workspace.js';
import { MemoryPanel } from '../web/src/MemoryPanel.js';
import { InputStatus } from '../web/src/InputStatus.js';

class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = FakeSocket.OPEN;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }
  send(_message: string) {}
  receive(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
}

let root: Root;
let container: HTMLDivElement;
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const json = (body: unknown) => new Response(JSON.stringify(body), {
  headers: { 'content-type': 'application/json' },
});

describe('T13 project and memory UI', () => {
  it('switches to an isolated connection and ignores late packets from the previous project', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/input-status')) return json({ pending: 0, failedCount: 0, needsRetry: [] });
      return json({
        model: 'meta',
        projects: [
          { id: 'local', name: 'Project A', memoryEnabled: false },
          { id: 'project-b', name: 'Project B', memoryEnabled: true },
        ],
      });
    }));
    await act(async () => root.render(<Workspace />));
    const first = FakeSocket.instances[0]!;
    expect(container.textContent).toContain('Meta Spark');
    expect(container.textContent).toContain('Cross-project recall is OFF for Project A.');
    act(() => first.receive({ type: 'assistant.chunk', deliveryId: 'a.1.1', chunkIdx: 0, text: 'Private A reply.' }));
    expect(container.textContent).toContain('Private A reply.');
    const select = container.querySelector('select')!;
    act(() => {
      select.value = 'project-b';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(first.readyState).toBe(3);
    const second = FakeSocket.instances[1]!;
    expect(second.url).toContain('/ws?project=project-b');
    expect(container.textContent).toContain('Cross-project recall is ON for Project B.');
    act(() => first.receive({ type: 'assistant.chunk', deliveryId: 'a.1.1', chunkIdx: 1, text: 'Late A leak.' }));
    act(() => second.receive({ type: 'assistant.chunk', deliveryId: 'b.1.1', chunkIdx: 0, text: 'B only.' }));
    expect(container.textContent).not.toContain('Private A reply');
    expect(container.textContent).not.toContain('Late A leak');
    expect(container.textContent).toContain('B only.');
  });

  it('makes a failed interpretation visible and retries only on explicit user action', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({
      pending: 0,
      failedCount: 1,
      needsRetry: [{ id: 'local.1.1', preview: 'A message that was not interpreted.' }],
    })));
    const retry = vi.fn(() => true);
    await act(async () => root.render(<InputStatus projectId="local" retry={retry} />));
    expect(container.textContent).toContain('did not reach project state, even if chat replied');
    expect(retry).not.toHaveBeenCalled();
    const button = [...container.querySelectorAll('button')].find(e => e.textContent === 'Retry interpretation')!;
    await act(async () => button.click());
    expect(retry).toHaveBeenCalledExactlyOnceWith('local.1.1');
  });

  it('escapes lesson text and never forgets a lesson without explicit confirmation', async () => {
    const requests: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      requests.push(init?.method ?? 'GET');
      if (url.endsWith('/lessons')) return json({ lessons: [{
        id: 'lesson',
        sourceProjectId: 'local',
        sourceProjectName: 'Project A',
        sourceInputId: 'local.1.1',
        quote: 'Exact source quote.',
        text: '<script>untrusted lesson</script>',
        terms: ['forecasting'],
        version: 1,
      }] });
      if (url.endsWith('/inputs')) return json({ inputs: [] });
      return json({ uses: [] });
    }));
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await act(async () => root.render(<MemoryPanel projectId="local" />));
    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toContain('<script>untrusted lesson</script>');
    const forget = [...container.querySelectorAll('button')].find(button => button.textContent === 'Forget lesson…')!;
    await act(async () => forget.click());
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('clears extracted project state'));
    expect(requests).not.toContain('DELETE');
  });
});

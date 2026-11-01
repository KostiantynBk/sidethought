import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { serverConfig } from '../src/server/config.js';
import { projectState } from '../src/server/projection.js';
import { createRuntime } from '../src/server/runtime.js';
import { FindingCard } from '../web/src/ResearchPanel.js';
import { emptyView, nextView } from '../web/src/logic/view.js';

async function flushSockets() {
  for (let index = 0; index < 10; index += 1) {
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

async function closeSocket(socket: WebSocket) {
  if (socket.readyState === socket.CLOSED) return;
  const closed = new Promise(resolve => socket.once('close', resolve));
  socket.close();
  await closed;
}

describe('integrated dev research', () => {
  it('runs a synthetic check and restores its job and finding after reconnect', async () => {
    const config = serverConfig({
      SIDETHOUGHT_PASSCODE: 'test-only-passcode',
      SIDETHOUGHT_COOKIE_SECRET: 'test-only-cookie-secret-is-long-enough',
      SIDETHOUGHT_ALLOWED_ORIGINS: 'http://127.0.0.1:5173',
      SIDETHOUGHT_DB_PATH: ':memory:',
      SIDETHOUGHT_MODEL: 'dev',
    });
    const runtime = await createRuntime(config);
    const sockets: WebSocket[] = [];
    const messages: Array<Record<string, unknown>> = [];
    try {
      const login = await runtime.app.inject({
        method: 'POST',
        url: '/login',
        payload: { passcode: config.passcode },
      });
      const headers = {
        cookie: String(login.headers['set-cookie']).split(';')[0]!,
        origin: config.allowedOrigins[0]!,
      };
      const socket = await runtime.app.injectWS('/ws', { headers }, {
        onInit: client => client.on('message', data => messages.push(JSON.parse(data.toString()))),
      });
      sockets.push(socket);
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      socket.send(JSON.stringify({
        type: 'input.committed',
        payload: {
          clientMsgId: 'check-1',
          text: 'check whether Example works offline',
          modality: 'text',
        },
      }));
      await flushSockets();
      expect(Object.values(runtime.runner.current().domain.jobs)).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(200);
      await flushSockets();
      expect(messages.some(message => String(message.text).startsWith('Checking:'))).toBe(true);
      expect(messages.some(message => String(message.text).startsWith('Finished checking:'))).toBe(true);
      const finding = Object.values(runtime.runner.current().domain.findings)[0]!;
      expect(finding.verdict).toBe('not_researched');
      expect(renderToStaticMarkup(<FindingCard finding={finding} />)).toContain('No completed web search');
      const copied = structuredClone(runtime.runner.current());
      Object.values(copied.domain.jobs)[0]!.question = 'private-question-sentinel';
      expect(JSON.stringify(projectState(copied).jobs)).not.toContain('private-question-sentinel');
      vi.useRealTimers();
      await closeSocket(socket);
      const reconnected: Array<Record<string, unknown>> = [];
      const socket2 = await runtime.app.injectWS('/ws', { headers }, {
        onInit: client => client.on('message', data => reconnected.push(JSON.parse(data.toString()))),
      });
      sockets.push(socket2);
      await vi.waitFor(() => expect(reconnected.some(message => message.type === 'ui.snapshot')).toBe(true));
      const snapshot = reconnected.find(message => message.type === 'ui.snapshot')!;
      const view = nextView(emptyView(), snapshot as { type: string });
      expect(view.jobs).toHaveLength(1);
      expect(view.findings).toHaveLength(1);
      const liveJob = messages.filter(message => message.type === 'job.updated').at(-1)!;
      expect(view.jobs[0]).toEqual({
        jobId: liveJob.jobId,
        publicQuery: liveJob.publicQuery,
        state: liveJob.state,
      });
      const liveFinding = messages.find(message => message.type === 'finding.upserted')!;
      expect(view.findings[0]).toEqual(liveFinding.finding);
      expect(view.findings[0]!.verdict).toBe('not_researched');
      expect(renderToStaticMarkup(<FindingCard finding={view.findings[0]!} />)).toContain('No completed web search');
    } finally {
      vi.useRealTimers();
      await Promise.all(sockets.map(closeSocket));
      await runtime.close();
    }
  });
});

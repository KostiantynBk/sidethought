import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { serverConfig } from '../src/server/config.js';
import { createRuntime } from '../src/server/runtime.js';
import type { SessionRunner } from '../src/runtime/session-runner.js';
import { delta, sentinel, sse, terminal, validOutput } from './t09-helpers.js';

type Body = { instructions: string; input: string };
async function setup() {
  const requests: Body[] = [];
  const controls = { stall: false, reply: 'One step at a time.' };
  const held: Array<{ release: (response: Response) => void; signal: AbortSignal | null | undefined }> = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as Body;
    requests.push(body);
    const { task, reusableLessons } = JSON.parse(body.input);
    if (task.role === 'responder' && controls.stall && reusableLessons?.length) {
      return new Promise<Response>(release => held.push({ release, signal: init?.signal }));
    }
    if (task.role === 'responder') return sse([delta(controls.reply), terminal()]);
    return sse([delta(JSON.stringify({
      ...validOutput,
      inputKinds: task.inputs.map((input: { id: string }) => ({ inputId: input.id, kind: 'statement' })),
    })), terminal()]);
  });
  const config = serverConfig({
    SIDETHOUGHT_PASSCODE: 'test-only-passcode',
    SIDETHOUGHT_COOKIE_SECRET: 'test-only-cookie-secret-is-long-enough',
    SIDETHOUGHT_ALLOWED_ORIGINS: 'http://127.0.0.1:5173',
    SIDETHOUGHT_DB_PATH: ':memory:',
    SIDETHOUGHT_MODEL: 'meta',
    MODEL_API_KEY: sentinel,
  });
  const runtime = await createRuntime(config, undefined, { fetch });
  const login = await runtime.app.inject({ method: 'POST', url: '/login', payload: { passcode: config.passcode } });
  const cookie = String(login.headers['set-cookie']).split(';')[0]!;
  const headers = { cookie, origin: config.allowedOrigins[0]! };
  return { runtime, requests, headers, controls, held };
}

async function beginInput(runner: SessionRunner, text: string) {
  const sessionId = runner.current().sessionId;
  runner.accept({ eventId: randomUUID(), sessionId, type: 'client.connected', payload: { modality: 'text' } });
  runner.accept({
    eventId: randomUUID(),
    sessionId,
    type: 'input.committed',
    payload: { clientMsgId: randomUUID(), text, modality: 'text' },
  });
  await vi.waitFor(() => expect(runner.current().domain.inputs.at(-1)?.status).toBe('interpreted'));
  const timer = runner.current().domain.timers.find(entry => entry.purpose === 'replyDebounce');
  if (timer) runner.accept({
    eventId: randomUUID(),
    sessionId,
    type: 'timer.fired',
    payload: { timerId: timer.timerId, purpose: timer.purpose },
  });
}

async function input(runner: SessionRunner, text: string) {
  await beginInput(runner, text);
  await vi.waitFor(() => expect(runner.current().domain.reply?.status).toBe('done'));
}

async function prepareTargets(test: Awaited<ReturnType<typeof setup>>, count: number) {
  await input(test.runtime.runner, 'The amber-canary pilot took 43 minutes.');
  const source = test.runtime.runner.current().domain.inputs[0]!;
  const lesson = test.runtime.memory.createLesson('local', {
    sourceInputId: source.id,
    quote: source.text,
    text: source.text,
    terms: ['forecasting'],
    confirmed: true,
  });
  const runners: SessionRunner[] = [];
  test.controls.reply = 'amber-canary remembered note.';
  for (let index = 0; index < count; index++) {
    const project = test.runtime.memory.createProject(`Target ${index}`);
    test.runtime.memory.setEnabled(project.id, true);
    const runner = test.runtime.projectRunner(project.id);
    await input(runner, 'Start a forecasting project.');
    runners.push(runner);
  }
  return { lesson, runners };
}

describe('T13 real runtime composition', () => {
  it('still invalidates live state when post-commit WAL cleanup throws', async () => {
    const test = await setup();
    try {
      const { lesson, runners } = await prepareTargets(test, 1);
      const database = (test.runtime.memory as unknown as { db: Database.Database }).db;
      const checkpoint = vi.spyOn(database, 'pragma').mockImplementationOnce(() => {
        throw new Error('synthetic checkpoint failure');
      });
      const result = await test.runtime.app.inject({
        method: 'DELETE',
        url: `/api/lessons/${lesson.id}`,
        headers: test.headers,
        payload: { expectedVersion: 1, acknowledgeRedaction: true },
      });
      checkpoint.mockRestore();
      expect(result.statusCode).toBe(200);
      expect(result.json().storageCleanupPending).toBe(true);
      expect(runners[0]!.isSuspended()).toBe(false);
      expect(JSON.stringify(runners[0]!.current())).not.toContain('amber-canary');
      expect(test.runtime.memory.lessons()).toEqual([]);
    } finally {
      await test.runtime.close();
    }
  });

  it('fences a failed recovery and still recovers the other affected project', async () => {
    const test = await setup();
    try {
      const { lesson, runners } = await prepareTargets(test, 2);
      const failure = vi.spyOn(runners[0]!, 'recover').mockImplementation(() => {
        throw new Error('synthetic recovery failure');
      });
      const result = await test.runtime.app.inject({
        method: 'DELETE',
        url: `/api/lessons/${lesson.id}`,
        headers: test.headers,
        payload: { expectedVersion: 1, acknowledgeRedaction: true },
      });
      failure.mockRestore();
      expect(result.statusCode).toBe(503);
      expect(runners[0]!.isSuspended()).toBe(true);
      expect(runners[1]!.isSuspended()).toBe(false);
      expect(JSON.stringify(runners.map(runner => runner.current()))).not.toContain('amber-canary');
      expect(() => runners[0]!.accept({})).toThrow('session paused');
      expect(test.runtime.memory.lessons()).toEqual([]);
    } finally {
      await test.runtime.close();
    }
  });
  it('re-fences a project if reconnect fails after recovery already committed', async () => {
    const test = await setup();
    try {
      const { lesson, runners } = await prepareTargets(test, 1);
      const runner = runners[0]!;
      const original = runner.accept.bind(runner);
      const failure = vi.spyOn(runner, 'accept').mockImplementation(raw => {
        if ((raw as { type?: string }).type === 'client.connected') throw new Error('synthetic reconnect failure');
        return original(raw);
      });
      const result = await test.runtime.app.inject({
        method: 'DELETE',
        url: `/api/lessons/${lesson.id}`,
        headers: test.headers,
        payload: { expectedVersion: 1, acknowledgeRedaction: true },
      });
      failure.mockRestore();
      expect(result.statusCode).toBe(503);
      expect(runner.isSuspended()).toBe(true);
      expect(JSON.stringify(runner.current())).not.toContain('amber-canary');
      expect(() => runner.accept({})).toThrow('session paused');
    } finally {
      await test.runtime.close();
    }
  });

  it('aborts an in-flight memory reply on deletion and discards its late provider response', async () => {
    const { runtime, headers, controls, held, requests } = await setup();
    try {
      await input(runtime.runner, 'The amber-canary pilot took 43 minutes.');
      const source = runtime.runner.current().domain.inputs[0]!;
      const lesson = runtime.memory.createLesson('local', {
        sourceInputId: source.id,
        quote: source.text,
        text: source.text,
        terms: ['forecasting'],
        confirmed: true,
      });
      const project = runtime.memory.createProject('Forecast race');
      runtime.memory.setEnabled(project.id, true);
      controls.stall = true;
      const runner = runtime.projectRunner(project.id);
      await beginInput(runner, 'Start a forecasting experiment.');
      await vi.waitFor(() => expect(held).toHaveLength(1));
      expect(held[0]!.signal?.aborted).toBe(false);
      const removed = await runtime.app.inject({
        method: 'DELETE',
        url: `/api/lessons/${lesson.id}`,
        headers,
        payload: { expectedVersion: 1, acknowledgeRedaction: true },
      });
      expect(removed.statusCode).toBe(200);
      expect(held[0]!.signal?.aborted).toBe(true);
      held[0]!.release(sse([delta('amber-canary late leaked reply.'), terminal()]));
      await new Promise(resolve => setTimeout(resolve, 25));
      expect(JSON.stringify(runner.current())).not.toContain('amber-canary');
      await input(runner, 'Continue with forecasting.');
      expect(requests.at(-1)!.input).not.toContain('amber-canary');
    } finally {
      for (const request of held) request.release(sse([terminal()]));
      await runtime.close();
    }
  });
  it('supplies source-only knowledge to a separately stored opted-in project but never its Interpreter', async () => {
    const { runtime, requests, headers } = await setup();
    try {
      await input(runtime.runner, 'Our amber-canary pilot took 43 minutes; use a smaller forecasting run.');
      const source = runtime.runner.current().domain.inputs[0]!;
      const saved = await runtime.app.inject({
        method: 'POST',
        url: '/api/projects/local/lessons',
        headers,
        payload: {
          sourceInputId: source.id,
          quote: source.text,
          text: 'Our amber-canary pilot took 43 minutes; prefer a small first run.',
          terms: ['forecasting'],
          confirmed: true,
        },
      });
      expect(saved.statusCode).toBe(200);
      await input(runtime.runner, 'UNSHARED PRIVATE SOURCE: internal budget is unrelated.');
      const created = await runtime.app.inject({ method: 'POST', url: '/api/projects', headers,
        payload: { name: 'Forecast B' } });
      const projectId = created.json().project.id as string;
      const target = runtime.projectRunner(projectId);
      await input(target, 'Start a forecasting project.');
      expect(requests.at(-1)!.input).not.toContain('amber-canary');
      await runtime.app.inject({ method: 'PUT', url: `/api/projects/${projectId}/memory`, headers,
        payload: { enabled: true } });
      const start = requests.length;
      await input(target, 'Plan the next forecasting experiment.');
      const newRequests = requests.slice(start);
      const interpreter = newRequests.find(body => JSON.parse(body.input).task.role === 'interpreter')!;
      const responder = newRequests.find(body => JSON.parse(body.input).task.role === 'responder')!;
      expect(interpreter.input).not.toContain('amber-canary');
      expect(responder.input).toContain('amber-canary');
      expect(responder.input).not.toContain('UNSHARED PRIVATE SOURCE');
      expect(JSON.parse(responder.input).projectSnapshot.items).toEqual([]);
      const audit = await runtime.app.inject({ method: 'GET', url: `/api/projects/${projectId}/lesson-uses`, headers });
      expect(audit.json().uses[0]).toMatchObject({ lessonId: saved.json().lesson.id, version: 1 });
      expect(runtime.runner.current().domain.inputs).toHaveLength(2);
      expect(target.current().domain.inputs).toHaveLength(2);
    } finally {
      await runtime.close();
    }
  });

  it('requires authentication, valid origin, explicit sharing, and redaction acknowledgment', async () => {
    const { runtime, headers } = await setup();
    try {
      expect((await runtime.app.inject({ method: 'GET', url: '/api/projects' })).statusCode).toBe(401);
      expect((await runtime.app.inject({ method: 'POST', url: '/api/projects', headers: {
        ...headers, origin: 'https://evil.invalid',
      }, payload: { name: 'Bad' } })).statusCode).toBe(403);
      expect((await runtime.app.inject({ method: 'POST', url: '/api/projects', headers: {
        cookie: headers.cookie,
      }, payload: { name: 'Bad' } })).statusCode).toBe(403);
      await input(runtime.runner, 'A concrete user lesson.');
      const source = runtime.runner.current().domain.inputs[0]!;
      const payload = {
        sourceInputId: source.id,
        quote: source.text,
        text: 'A reusable lesson.',
        terms: ['concrete'],
        confirmed: false,
      };
      expect((await runtime.app.inject({ method: 'POST', url: '/api/projects/local/lessons', headers,
        payload })).statusCode).toBe(400);
      const saved = await runtime.app.inject({ method: 'POST', url: '/api/projects/local/lessons', headers,
        payload: { ...payload, confirmed: true } });
      const id = saved.json().lesson.id;
      expect((await runtime.app.inject({ method: 'DELETE', url: `/api/lessons/${id}`, headers,
        payload: { expectedVersion: 1 } })).statusCode).toBe(400);
      expect(runtime.memory.lessons()).toHaveLength(1);
      expect((await runtime.app.inject({ method: 'POST', url: '/api/projects', headers,
        payload: { name: '' } })).statusCode).toBe(400);
    } finally {
      await runtime.close();
    }
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { questionKey } from '../src/kernel/research/policy.js';
import { ResearchHarness, item } from './t11a-helpers.js';

describe.each(['memory', 'sqlite'] as const)('T11a admission (%s)', store => {
  let h: ResearchHarness;
  afterEach(() => h?.store.close());

  it('refuses a query containing a private term with a truthful notice', () => {
    h = new ResearchHarness(store, {}, [item(), item('private', 'SecretZephyr', true)]);
    const result = h.request(undefined, 'SecretZephyr offline');
    expect(Object.values(result.state.domain.jobs)[0]?.state).toBe('rejected');
    expect(result.decisions.map(decision => decision.reason)).toContain('research:refused:private_term');
    expect(result.effects.some(effect => effect.type === 'job.dispatch')).toBe(false);
    expect(h.notices()).toEqual(["Can't check that now: the public query contains private terms"]);
  });

  it('rechecks privacy when a queued job reaches dispatch', () => {
    h = new ResearchHarness(store, {}, [item(), item('private', 'SecretZephyr', true)]);
    h.request(['Check one?', 'Check two?', 'Check three?']);
    const jobs = Object.values(h.state.domain.jobs);
    h.send('item.action', {
      itemId: 'private',
      expectedVersion: 1,
      action: 'edit',
      text: 'Provider',
    });
    const result = h.complete(jobs[0]!.id);
    expect(result.state.domain.jobs[jobs[2]!.id]?.state).toBe('cancelled');
    expect(result.decisions.map(decision => decision.reason)).toContain('research:dispatch_blocked:private_term');
    expect(h.effects.filter(effect => effect.type === 'job.dispatch')).toHaveLength(2);
  });

  it('refuses queries beyond the configured public length cap', () => {
    h = new ResearchHarness(store, { publicQueryMaxChars: 8 });
    const result = h.request();
    expect(result.decisions.map(decision => decision.reason)).toContain('research:refused:query_length');
    expect(h.notices()[0]).toContain('too long');
  });

  it('enforces the queue cap separately from occupied workers', () => {
    h = new ResearchHarness(store);
    h.request(['Check one?', 'Check two?', 'Check three?']);
    h.request(['Check four?', 'Check five?', 'Check six?']);
    const result = h.request(['Check seven?']);
    const jobs = Object.values(h.state.domain.jobs);
    expect(jobs.filter(job => job.state === 'running')).toHaveLength(2);
    expect(jobs.filter(job => job.state === 'queued')).toHaveLength(4);
    expect(result.decisions.map(decision => decision.reason)).toContain('research:refused:queue_cap');
    expect(h.notices().at(-1)).toBe("Can't check that now: the research queue is full");
  });

  it('enforces the session logical-job cap', () => {
    h = new ResearchHarness(store, { jobsMaxPerSession: 1 });
    h.request();
    h.complete();
    const result = h.request(['Check pricing?']);
    expect(result.decisions.map(decision => decision.reason)).toContain('research:refused:session_cap');
    expect(result.state.domain.researchAdmitted).toBe(1);
    expect(h.notices().at(-1)).toContain('session research limit');
  });

  it('attaches duplicates to open and recently succeeded promises without another closure', () => {
    h = new ResearchHarness(store, { jobsMaxPerSession: 1 });
    h.request();
    h.request();
    expect(Object.values(h.state.domain.jobs)).toHaveLength(1);
    h.complete();
    h.request();
    expect(Object.values(h.state.domain.jobs)).toHaveLength(1);
    expect(Object.values(h.state.domain.jobs)[0]?.inputIds).toHaveLength(3);
    expect(h.notices().filter(text => text.startsWith('Finished checking:'))).toHaveLength(1);
  });

  it('does not reuse an answer outside the recent-success window', () => {
    h = new ResearchHarness(store, { jobDedupeWindowMs: 10 });
    h.request();
    h.complete();
    h.at += 11;
    h.request();
    expect(Object.values(h.state.domain.jobs)).toHaveLength(2);
  });

  it('gates admission on spent plus reservations and accounts all usage', () => {
    h = new ResearchHarness(store, { sessionSoftCapUsd: 0.15 });
    h.request();
    const job = Object.values(h.state.domain.jobs)[0]!;
    const refused = h.request(['Check pricing?']);
    expect(refused.decisions.map(decision => decision.reason)).toContain('research:refused:budget');
    h.send('llm.usage', {
      callId: job.callId,
      inputTokens: 100,
      outputTokens: 100,
      queries: 2,
      audioSeconds: 0,
      costUsd: 0.03,
    });
    const admitted = h.request(['Check licences?']);
    expect(admitted.decisions.map(decision => decision.reason)).toContain('research:admitted');
    expect(h.state.domain.researchBudget.spentUsd).toBe(0.03);
    expect(h.state.domain.researchBudget.queries).toBe(2);
    expect(h.state.domain.jobs[job.id]).toMatchObject({
      costUsd: 0.03,
      queriesCounted: 2,
    });
  });

  it('does not reuse global headroom across several admissions before another aggregate update', () => {
    h = new ResearchHarness(store);
    h.send('budget.global', {
      spentTodayUsd: 9.85,
      reservedUsd: 0,
      reserveUsd: 40,
    });
    const result = h.request(['Check one?', 'Check two?', 'Check three?']);
    expect(Object.values(h.state.domain.jobs).map(job => job.state))
      .toEqual(['running', 'rejected', 'rejected']);
    expect(result.decisions.filter(decision => decision.reason === 'research:refused:budget')).toHaveLength(2);
  });

  it('accounts local usage since the global aggregate without freeing stale headroom', () => {
    h = new ResearchHarness(store);
    h.send('budget.global', {
      spentTodayUsd: 9.85,
      reservedUsd: 0,
      reserveUsd: 40,
    });
    h.request();
    const job = Object.values(h.state.domain.jobs)[0]!;
    h.send('llm.usage', {
      callId: job.callId,
      inputTokens: 100,
      outputTokens: 100,
      queries: 2,
      audioSeconds: 0,
      costUsd: 0.09,
    });
    const result = h.request(['Another check?']);
    expect(result.decisions.map(decision => decision.reason)).toContain('research:refused:budget');
  });

  it('rejects a fourth request at the unchanged event schema boundary', () => {
    h = new ResearchHarness(store);
    expect(() => h.request(['Check one?', 'Check two?', 'Check three?', 'Check four?'])).toThrow();
    expect(h.state.domain.jobs).toEqual({});
  });

  it('blocks queued dispatch when a global budget update removes capacity', () => {
    h = new ResearchHarness(store);
    h.request(['Check one?', 'Check two?', 'Check three?']);
    const jobs = Object.values(h.state.domain.jobs);
    h.send('budget.global', {
      spentTodayUsd: 10,
      reservedUsd: 1,
      reserveUsd: 40,
    });
    const result = h.complete(jobs[0]!.id);
    expect(result.state.domain.jobs[jobs[2]!.id]?.state).toBe('cancelled');
    expect(result.decisions.map(decision => decision.reason)).toContain('research:dispatch_blocked:budget');
  });
});

it('hashes ordered normalized questions together with captured dependency versions', () => {
  const deps = [{
    itemId: 'r1',
    contentVersion: 1,
  }];
  expect(questionKey('Does A sync with B?', deps)).toBe(questionKey('does a sync with b!', deps));
  expect(questionKey('Does A sync with B?', deps)).not.toBe(questionKey('Does B sync with A?', deps));
  expect(questionKey('Does A sync?', deps)).not.toBe(questionKey('Does A not sync?', deps));
  expect(questionKey('Does A sync?', deps)).not.toBe(questionKey('Does A sync?', [{
    itemId: 'r1',
    contentVersion: 2,
  }]));
});

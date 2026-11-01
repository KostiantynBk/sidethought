import { afterEach, describe, expect, it } from 'vitest';
import { jobForDispatch } from '../src/kernel/research/index.js';
import { ResearchHarness } from './t11a-helpers.js';

describe.each(['memory', 'sqlite'] as const)('T11a lifecycle (%s)', store => {
  let h: ResearchHarness;
  afterEach(() => h?.store.close());

  it('S1 dispatches an explicit promise, verifies two claims and closes once', () => {
    h = new ResearchHarness(store);
    const admitted = h.request();
    const job = Object.values(h.state.domain.jobs)[0]!;
    expect(job).toMatchObject({
      state: 'running',
      promised: true,
      causalDepth: 0,
      deps: [{
        itemId: 'r1',
        contentVersion: 1,
      }],
    });
    expect(admitted.effects).toContainEqual({
      type: 'job.dispatch',
      jobId: job.id,
      callId: job.callId,
      capturedInputs: job.deps,
    });
    expect(jobForDispatch(h.state, job.id)).toEqual({ publicQuery: 'Provider A offline' });
    h.complete();
    const finding = Object.values(h.state.domain.findings)[0]!;
    expect(finding.verdict).toBe('mixed');
    expect(finding.claims.map(claim => claim.support[0]?.quoteVerified)).toEqual([true, true, false]);
    expect(finding.retrievedAt).toBe(h.at);
    expect(finding.claims[0]?.support[0]?.published).toBe('2026-10-01');
    expect(h.state.domain.jobs[job.id]?.closureCount).toBe(1);
    expect(h.notices()).toEqual([
      'Checking: Does Provider A work offline?',
      'Finished checking: Does Provider A work offline? — see the card',
    ]);
    const late = h.complete();
    expect(late.decisions[0]?.reason).toBe('late:retired_job');
    expect(late.effects).toEqual([]);
  });

  it('admits three requests per input and closes each independent promise', () => {
    h = new ResearchHarness(store);
    h.request(['Check offline?', 'Check pricing?', 'Check licences?']);
    const jobs = Object.values(h.state.domain.jobs);
    expect(jobs.map(job => job.state)).toEqual(['running', 'running', 'queued']);
    for (const job of jobs) h.complete(job.id);
    expect(Object.values(h.state.domain.jobs).map(job => job.closureCount)).toEqual([1, 1, 1]);
    expect(h.notices().filter(text => text.startsWith('Finished checking:'))).toHaveLength(3);
  });

  it('times out with an abort and retains unknown-cost reservation', () => {
    h = new ResearchHarness(store);
    h.request();
    const job = Object.values(h.state.domain.jobs)[0]!;
    h.at = job.deadlineAt!;
    const result = h.send('timer.fired', {
      timerId: job.deadlineTimerId,
      purpose: 'jobDeadline',
    });
    expect(result.effects).toContainEqual({
      type: 'job.abort',
      callId: job.callId,
    });
    expect(h.state.domain.jobs[job.id]?.state).toBe('timed_out');
    expect(h.state.domain.researchBudget.reservedUsd).toBe(0.1);
    expect(h.notices().at(-1)).toContain('exceeded its time limit');
  });

  it('retries one transient failure with a fresh call and rejects retired results', () => {
    h = new ResearchHarness(store);
    h.request();
    const original = Object.values(h.state.domain.jobs)[0]!;
    h.send('job.failed', {
      jobId: original.id,
      callId: original.callId,
      reason: 'transient_provider_failure',
    });
    const retry = h.state.domain.jobs[original.id]!;
    expect(retry.attempt).toBe(2);
    expect(retry.callId).not.toBe(original.callId);
    expect(retry.deadlineAt).toBe(original.deadlineAt);
    const before = h.state.domain;
    const late = h.send('job.cancelled', {
      jobId: original.id,
      callId: original.callId,
    });
    expect(late.state.domain).toEqual(before);
    expect(late.effects).toEqual([]);
    h.complete(original.id);
    expect(h.state.domain.jobs[original.id]?.state).toBe('succeeded');
    expect(h.notices().filter(text => text.startsWith('Checking:'))).toHaveLength(1);
  });

  it('stops after the second transient failure', () => {
    h = new ResearchHarness(store);
    h.request();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const job = Object.values(h.state.domain.jobs)[0]!;
      h.send('job.failed', {
        jobId: job.id,
        callId: job.callId,
        reason: 'transient_capacity',
      });
    }
    expect(Object.values(h.state.domain.jobs)[0]?.state).toBe('failed');
    expect(h.effects.filter(effect => effect.type === 'job.dispatch')).toHaveLength(2);
    expect(h.notices().filter(text => text.startsWith("Couldn't check"))).toHaveLength(1);
  });

  it('does not retry a permanent failure', () => {
    h = new ResearchHarness(store);
    h.request();
    const job = Object.values(h.state.domain.jobs)[0]!;
    h.send('job.failed', {
      jobId: job.id,
      callId: job.callId,
      reason: 'permanent_provider_failure',
    });
    expect(h.state.domain.jobs[job.id]?.state).toBe('failed');
    expect(h.effects.filter(effect => effect.type === 'job.dispatch')).toHaveLength(1);
  });

  it('does not retry an unknown failure reason', () => {
    h = new ResearchHarness(store);
    h.request();
    const job = Object.values(h.state.domain.jobs)[0]!;
    h.send('job.failed', {
      jobId: job.id,
      callId: job.callId,
      reason: 'unknown_provider_prose',
    });
    expect(h.state.domain.jobs[job.id]?.state).toBe('failed');
    expect(h.effects.filter(effect => effect.type === 'job.dispatch')).toHaveLength(1);
  });

  it('does not retry the executor missing-job classification', () => {
    h = new ResearchHarness(store);
    h.request();
    const job = Object.values(h.state.domain.jobs)[0]!;
    h.send('job.failed', {
      jobId: job.id,
      callId: job.callId,
      reason: 'permanent_missing_job',
    });
    expect(h.state.domain.jobs[job.id]?.state).toBe('failed');
  });

  it('reconciles usage from a retired timed-out call without reopening its promise', () => {
    h = new ResearchHarness(store);
    h.request();
    const job = Object.values(h.state.domain.jobs)[0]!;
    h.send('job.timedOut', {
      jobId: job.id,
      callId: job.callId,
    });
    h.send('llm.usage', {
      callId: job.callId,
      inputTokens: 10,
      outputTokens: 10,
      queries: 3,
      audioSeconds: 0,
      costUsd: 0.04,
    });
    expect(h.state.domain.researchBudget.reservedUsd).toBe(0);
    expect(h.state.domain.researchBudget.spentUsd).toBe(0.04);
    expect(h.state.domain.jobs[job.id]).toMatchObject({
      state: 'timed_out',
      closureCount: 1,
      costUsd: 0.04,
      queriesCounted: 3,
    });
  });

  it('recovers running and queued jobs as interrupted without restarting work', () => {
    h = new ResearchHarness(store);
    h.request(['Check offline?', 'Check pricing?', 'Check licences?']);
    const result = h.send('session.recovered', {});
    expect(Object.values(result.state.domain.jobs).map(job => job.state))
      .toEqual(['interrupted', 'interrupted', 'interrupted']);
    expect(result.effects.some(effect => effect.type === 'job.dispatch' || effect.type === 'llm.call')).toBe(false);
    expect(result.state.domain.timers.some(timer => timer.purpose === 'jobDeadline')).toBe(false);
    expect(result.state.domain.researchBudget.reservedUsd).toBe(0.2);
    const again = h.send('session.recovered', {});
    expect(again.effects).toEqual([]);
    expect(h.notices().filter(text => text.startsWith("Couldn't check"))).toHaveLength(3);
  });

  it('cancels a queued promise without dispatching it', () => {
    h = new ResearchHarness(store);
    h.request(['Check offline?', 'Check pricing?', 'Check licences?']);
    const job = Object.values(h.state.domain.jobs)[2]!;
    const result = h.send('job.cancelRequested', { jobId: job.id });
    expect(result.state.domain.jobs[job.id]?.state).toBe('cancelled');
    expect(result.effects.some(effect => effect.type === 'job.abort')).toBe(false);
    expect(result.state.domain.jobs[job.id]?.closureCount).toBe(1);
  });

  it('cancels a running job when its dependency is rejected through the UI', () => {
    h = new ResearchHarness(store);
    h.request();
    const job = Object.values(h.state.domain.jobs)[0]!;
    const result = h.send('item.action', {
      itemId: 'r1',
      expectedVersion: 1,
      action: 'reject',
    });
    expect(result.effects).toContainEqual({
      type: 'job.abort',
      callId: job.callId,
    });
    expect(result.state.domain.jobs[job.id]?.state).toBe('cancelled');
    const late = h.send('job.started', {
      jobId: job.id,
      callId: job.callId,
    });
    expect(late.decisions[0]?.reason).toBe('late:retired_job');
    expect(late.effects).toEqual([]);
  });

  it('keeps out-of-order findings attached to their questions', () => {
    h = new ResearchHarness(store);
    h.request(['Check offline?', 'Check pricing?']);
    const jobs = Object.values(h.state.domain.jobs);
    h.complete(jobs[1]!.id);
    h.complete(jobs[0]!.id);
    expect(Object.values(h.state.domain.findings).map(finding => finding.jobId)).toEqual([jobs[1]!.id, jobs[0]!.id]);
  });
});

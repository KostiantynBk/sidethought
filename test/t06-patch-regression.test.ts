import { describe, expect, it } from 'vitest';
import { hasUninterpretedInput } from '../src/kernel/index.js';
import { edit, fixture, ready, reasons, start } from './t06-patch-helpers.js';

describe('T06 patch regression fixtures', () => {
  it('does not change an identical normalized supersede or bump the project revision', () => {
    const state = start();
    const before = structuredClone(state.domain.items);
    const result = ready(state, fixture('supersede-identical-noop', state.domain.inputs[0]!.id));
    expect(result.state.domain.items).toEqual(before);
    expect(result.state.domain.projectRev).toBe(state.domain.projectRev);
    expect(reasons(result)).toContain('patch:noop_identical');
    expect(result.state.domain.inputs[0]?.status).toBe('interpreted');
  });

  it('rejects the entire group when the second inline supersede replacement is invalid', () => {
    const state = start();
    const before = structuredClone(state.domain.items);
    const result = ready(state, fixture('group-two-supersedes', state.domain.inputs[0]!.id));
    expect(result.state.domain.items).toEqual(before);
    expect(result.state.domain.projectRev).toBe(state.domain.projectRev);
    expect(reasons(result)).toContain('patch:group_rejected');
    expect(result.state.domain.inputs[0]?.status).toBe('interpreted');
  });

  it('applies grouped correction with retract as one project revision', () => {
    const state = start();
    const result = ready(state, fixture('grouped-correction-with-retract', state.domain.inputs[0]!.id));
    const replacement = Object.values(result.state.domain.items).find(value => value.text === 'Use local storage');
    expect(result.state.domain.items.r1?.status).toBe('superseded');
    expect(result.state.domain.items.r2?.status).toBe('retracted');
    expect(replacement?.contentVersion).toBe(1);
    expect(result.state.domain.projectRev).toBe(state.domain.projectRev + 1);
    expect(result.state.domain.inputs[0]?.status).toBe('interpreted');
  });

  it('rolls back a grouped retract when a later create is rejected', () => {
    const state = start();
    const result = ready(state, fixture('group-atomic-reject', state.domain.inputs[0]!.id));
    expect(result.state.domain.items).toEqual(state.domain.items);
    expect(result.state.domain.projectRev).toBe(state.domain.projectRev);
    expect(reasons(result)).toContain('patch:group_rejected');
  });

  it('retries an operation targeting an item not captured by the call', () => {
    const state = start();
    const firstCall = state.domain.call!;
    const result = ready(state, fixture('not-captured-item', state.domain.inputs[0]!.id));
    expect(result.state.domain.items).toEqual(state.domain.items);
    expect(result.state.domain.call?.requestId).toBe(firstCall.requestId);
    expect(result.state.domain.call?.callId).not.toBe(firstCall.callId);
    expect(result.state.domain.call?.attempt).toBe(2);
  });

  it('retries duplicate localRefs without applying either create', () => {
    const state = start();
    const firstCall = state.domain.call!;
    const result = ready(state, fixture('duplicate-local-ref', state.domain.inputs[0]!.id));
    expect(result.state.domain.items).toEqual(state.domain.items);
    expect(result.state.domain.call?.requestId).toBe(firstCall.requestId);
    expect(result.state.domain.call?.callId).not.toBe(firstCall.callId);
    expect(result.state.domain.call?.attempt).toBe(2);
  });

  it('retries a request with an unresolved localRef', () => {
    const state = start();
    const firstCall = state.domain.call!;
    const result = ready(state, fixture('missing-local-ref', state.domain.inputs[0]!.id));
    expect(result.state.domain.items).toEqual(state.domain.items);
    expect(result.state.domain.call?.requestId).toBe(firstCall.requestId);
    expect(result.state.domain.call?.callId).not.toBe(firstCall.callId);
    expect(result.state.domain.call?.attempt).toBe(2);
  });

  it('applies no otherwise-valid op when another op conflicts with a newer UI edit', () => {
    const state = edit(start(), 'edit', 1, 'Use encrypted cloud');
    const before = structuredClone(state.domain.items);
    const result = ready(state, fixture('s3e-typo-edit-race', state.domain.inputs[0]!.id));
    expect(result.state.domain.items).toEqual(before);
    expect(result.state.domain.projectRev).toBe(state.domain.projectRev);
    expect(reasons(result)).toContain('patch:conflict_reinterpret');
    expect(result.state.domain.call?.capturedInputs).toContainEqual({
      itemId: 'r1',
      contentVersion: 2,
    });
    const retried = ready(result.state, fixture('s3e-typo-edit-race', state.domain.inputs[0]!.id), 'retry-ready');
    expect(retried.state.domain.items.r1?.status).toBe('retracted');
    expect(Object.values(retried.state.domain.items).some(value => value.text === 'Use local storage')).toBe(true);
    expect(retried.state.domain.inputs[0]?.status).toBe('interpreted');
  });

  it('leaves a twice-conflicted input uninterpreted with a visible retry notice', () => {
    const first = edit(start(), 'edit-1', 1, 'Use encrypted cloud');
    const output = fixture('conflict-twice-needs-retry', first.domain.inputs[0]!.id);
    const retried = ready(first, output).state;
    const second = edit(retried, 'edit-2', 2, 'Use private cloud');
    const result = ready(second, output, 'ready-2');
    expect(result.state.domain.items).toEqual(second.domain.items);
    expect(result.state.domain.inputs[0]?.status).not.toBe('interpreted');
    expect(hasUninterpretedInput(result.state)).toBe(true);
    expect(reasons(result)).toContain('patch:conflict_needs_retry');
  });

});

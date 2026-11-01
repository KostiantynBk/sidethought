import { describe, expect, it } from 'vitest';
import { assembleContext, type CallEffect } from '../src/context/index.js';
import { streaming } from './t07-helpers.js';

function responderPrompt() {
  const state = streaming();
  const reply = state.domain.reply!;
  const effect: CallEffect = {
    type: 'llm.call',
    role: 'responder',
    requestId: reply.requestId,
    callId: reply.callId,
    basisRev: reply.basisRev,
    capturedInputs: reply.capturedInputs,
  };
  return assembleContext(state, effect);
}

describe('T13 adaptive guidance contract', () => {
  it('supplies actual requested help instead of offering another question loop', () => {
    const { instructions } = responderPrompt();
    expect(instructions).toContain('[sidethought-responder-v2]');
    expect(instructions).toContain('give the actual explanation, worked example, or code');
    expect(instructions).toContain('Do not merely offer to provide it');
    expect(instructions).not.toContain('one to three');
  });

  it('resets confusion with a concrete example and a recommended action', () => {
    const { instructions } = responderPrompt();
    expect(instructions).toContain('one concrete next action');
    expect(instructions).toContain('If the user is lost, pause the previous plan');
    expect(instructions).toContain('Do not keep repeating parked features');
    expect(instructions).toContain('A helpful reply need not end in a question');
  });

  it('retains unperformed-work, credential, research, and approval boundaries', () => {
    const { instructions } = responderPrompt();
    expect(instructions).toContain('Do not claim to have run code');
    expect(instructions).toContain('Never announce a new research job');
    expect(instructions).toContain('Never approve or confirm a decision');
    expect(instructions).toContain('Never ask the user to provide a secret');
  });

  it('distinguishes relevant reusable lessons from evidence and new project decisions', () => {
    const { instructions } = responderPrompt();
    expect(instructions).toContain('not research or decisions for this project');
    expect(instructions).toContain('name their source project');
    expect(instructions).toContain('Current user input takes precedence');
  });
});

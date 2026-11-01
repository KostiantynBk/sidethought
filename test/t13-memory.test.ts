import { describe, expect, it } from 'vitest';
import { assembleWithLessons } from '../src/memory/context.js';
import { MemoryError } from '../src/memory/types.js';
import { requestBody } from '../src/model/meta/request.js';
import { memorySetup, modelState, saveState } from './t13-memory-helpers.js';
import { ContributionHarness } from './t12a-helpers.js';

describe('reviewed cross-project lesson boundaries', () => {
  it('preserves the existing default project and makes new projects retrieval-off by default', () => {
    const { memory, target } = memorySetup();
    expect(memory.projects().map(project => project.name)).toEqual(['Current project', 'Forecast B']);
    expect(memory.project('local').memoryEnabled).toBe(false);
    expect(target.memoryEnabled).toBe(false);
    expect(memory.retrieve(target.id, 'forecasting')).toEqual([]);
  });

  it('retrieves a confirmed relevant lesson with source provenance only after opt-in', () => {
    const { memory, target, lesson } = memorySetup();
    memory.setEnabled(target.id, true);
    expect(memory.retrieve(target.id, 'New forecasting experiment')).toEqual([lesson]);
    expect(memory.retrieve(target.id, 'I want to design a photo gallery')).toEqual([]);
    expect(memory.retrieve(target.id, 'forecastingly')).toEqual([]);
  });

  it('never retrieves a project’s own lessons as cross-project memory', () => {
    const { memory } = memorySetup();
    memory.setEnabled('local', true);
    expect(memory.retrieve('local', 'forecasting')).toEqual([]);
  });

  it('rejects invented source quotes and another project’s input identity', () => {
    const { memory, target, lesson } = memorySetup();
    const draft = { ...lesson, confirmed: true as const };
    expect(() => memory.createLesson('local', {
      sourceInputId: lesson.sourceInputId,
      quote: 'Invented source text',
      text: draft.text,
      terms: draft.terms,
      confirmed: true,
    })).toThrow(MemoryError);
    expect(() => memory.createLesson(target.id, {
      sourceInputId: lesson.sourceInputId,
      quote: lesson.quote,
      text: lesson.text,
      terms: lesson.terms,
      confirmed: true,
    })).toThrow('Source quote must match');
  });

  it('puts only the selected lesson into Responder context and audits its version', () => {
    const { memory, target, lesson } = memorySetup();
    memory.setEnabled(target.id, true);
    const { state, effect } = modelState(target.id);
    const prompt = assembleWithLessons(memory, state, effect);
    const input = JSON.parse(prompt.input);
    expect(input.reusableLessons).toHaveLength(1);
    expect(input.reusableLessons[0]).toMatchObject({
      id: lesson.id,
      sourceProjectName: 'Current project',
      sourceInputId: 'local.1.1',
      version: 1,
      lesson: lesson.text,
    });
    expect(prompt.input).not.toContain('unrelated source history');
    expect(input.projectSnapshot.items).toEqual([]);
    expect(memory.recentUses(target.id)).toEqual([{
      callId: effect.callId,
      sessionId: target.id,
      lessonId: lesson.id,
      version: 1,
    }]);
  });

  it('supplies and audits relevant lessons for an opted-in Deliberator call', () => {
    const { memory, target, lesson } = memorySetup();
    memory.setEnabled(target.id, true);
    const h = new ContributionHarness('memory', {}, []);
    h.connect();
    h.statement('Plan a forecasting experiment.');
    h.timer('deliberationDebounce');
    const state = structuredClone(h.state);
    state.sessionId = target.id;
    const call = state.domain.initiative.deliberation!;
    const effect = { type: 'llm.call' as const, role: 'deliberator' as const, ...call };
    const prompt = assembleWithLessons(memory, state, effect);
    expect(prompt.suppliedLessons).toEqual([{
      lessonId: lesson.id,
      version: lesson.version,
      sourceProjectName: lesson.sourceProjectName,
      text: lesson.text,
    }]);
    expect(JSON.parse(prompt.input).reusableLessons).toEqual(prompt.suppliedLessons);
    expect(memory.recentUses(target.id)[0]).toMatchObject({ callId: call.callId, lessonId: lesson.id });
    h.store.close();
  });

  it('does not supply a relevant lesson to the Deliberator when recall is off', () => {
    const { memory, target } = memorySetup();
    const h = new ContributionHarness('memory', {}, []);
    h.connect();
    h.statement('Plan a forecasting experiment.');
    h.timer('deliberationDebounce');
    const state = structuredClone(h.state);
    state.sessionId = target.id;
    const call = state.domain.initiative.deliberation!;
    const prompt = assembleWithLessons(memory, state, { type: 'llm.call', role: 'deliberator', ...call });
    expect(prompt.suppliedLessons).toBeUndefined();
    expect(JSON.parse(prompt.input)).not.toHaveProperty('reusableLessons');
    expect(memory.recentUses(target.id)).toEqual([]);
    h.store.close();
  });

  it('never gives foreign memory to the Interpreter or its quote witness', () => {
    const { memory, target } = memorySetup();
    memory.setEnabled(target.id, true);
    const { state, effect } = modelState(target.id);
    effect.role = 'interpreter';
    const prompt = assembleWithLessons(memory, state, effect);
    expect(prompt.input).not.toContain('amber-canary');
    expect(JSON.stringify(requestBody(state, effect, prompt))).not.toContain('amber-canary');
    expect(JSON.parse(prompt.input)).not.toHaveProperty('reusableLessons');
    expect(state.domain.call!.quoteWitness.sources).toEqual([]);
    expect(memory.recentUses(target.id)).toEqual([]);
  });

  it('removes retrieval immediately when disabled and provides no memory to irrelevant input', () => {
    const { memory, target } = memorySetup();
    memory.setEnabled(target.id, true);
    const unrelated = modelState(target.id, 'Help me choose image colors');
    expect(assembleWithLessons(memory, unrelated.state, unrelated.effect).input).not.toContain('amber-canary');
    memory.setEnabled(target.id, false);
    const relevant = modelState(target.id);
    expect(assembleWithLessons(memory, relevant.state, relevant.effect).input).not.toContain('amber-canary');
  });

  it('rejects stale revisions without overwriting a newer lesson', () => {
    const { memory, lesson } = memorySetup();
    memory.changeLesson(lesson.id, {
      text: 'Corrected lesson',
      terms: ['forecasting'],
      expectedVersion: 1,
      acknowledgeRedaction: true,
    });
    expect(() => memory.changeLesson(lesson.id, {
      text: 'Stale correction',
      terms: ['forecasting'],
      expectedVersion: 1,
      acknowledgeRedaction: true,
    })).toThrow('Lesson changed');
    expect(() => memory.removeLesson(lesson.id, 1)).toThrow('Lesson changed');
    expect(memory.lessons()[0]!.text).toBe('Corrected lesson');
    expect(memory.lessons()[0]!.version).toBe(2);
  });

  it('persists named projects, explicit consent, source quotes, and lesson revisions across reopening', () => {
    const test = memorySetup();
    test.memory.setEnabled(test.target.id, true);
    const reopened = test.reopen();
    expect(reopened.memory.project(test.target.id).memoryEnabled).toBe(true);
    expect(reopened.memory.retrieve(test.target.id, 'forecasting')).toEqual([test.lesson]);
    expect(reopened.store.loadSnapshot('local')).toBeDefined();
  });

  it('excludes lessons whose original user source was redacted or was assistant-origin', () => {
    const { memory, target, source, store, lesson } = memorySetup();
    memory.setEnabled(target.id, true);
    source.domain.inputs[0]!.origin = 'assistant';
    saveState(store, source);
    expect(memory.retrieve(target.id, 'forecasting')).toEqual([]);
    expect(() => memory.createLesson('local', {
      sourceInputId: lesson.sourceInputId,
      quote: lesson.quote,
      text: lesson.text,
      terms: lesson.terms,
      confirmed: true,
    })).toThrow('Source quote must match');
    source.domain.inputs[0]!.origin = 'user';
    source.domain.inputs[0]!.text = '[redacted]';
    saveState(store, source);
    expect(memory.retrieve(target.id, 'forecasting')).toEqual([]);
  });

  it('bounds retrieval to three lessons and respects multiword applicability', () => {
    const { memory, target, lesson } = memorySetup();
    memory.setEnabled(target.id, true);
    for (let index = 0; index < 4; index++) memory.createLesson('local', {
      sourceInputId: lesson.sourceInputId,
      quote: lesson.quote,
      text: `Alternative confirmed lesson ${index}`,
      terms: ['time split'],
      confirmed: true,
    });
    expect(memory.retrieve(target.id, 'forecasting with a time split')).toHaveLength(3);
    expect(memory.retrieve(target.id, 'a time to split hairs')).toHaveLength(0);
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { assembleContext, type CallEffect } from '../src/context/index.js';
import { researchContext } from '../src/context/research.js';
import { ResearchHarness, url } from './t11a-helpers.js';

function reply(h: ResearchHarness, text: string) {
  const timer = h.state.domain.timers.find(value => value.purpose === 'replyDebounce')!;
  h.at = timer.dueAt;
  h.send('timer.fired', {
    timerId: timer.timerId,
    purpose: timer.purpose,
  });
  const call = h.state.domain.reply!;
  return h.send('reply.chunk', {
    requestId: call.requestId,
    callId: call.callId,
    text,
  });
}

function hasChunk(h: ResearchHarness): boolean {
  return h.effects.some(effect => effect.type === 'client.send' && effect.message.type === 'assistant.chunk');
}

describe.each(['memory', 'sqlite'] as const)('T11a context and URLs (%s)', store => {
  let h: ResearchHarness;
  afterEach(() => h?.store.close());

  it('includes running and queued titles but no partial evidence in context', () => {
    h = new ResearchHarness(store);
    h.request(['Check offline?', 'Check pricing?', 'Check licences?']);
    expect(researchContext(h.state)).toEqual({
      jobs: [
        {
          title: 'Check offline?',
          state: 'running',
        },
        {
          title: 'Check pricing?',
          state: 'running',
        },
        {
          title: 'Check licences?',
          state: 'queued',
        },
      ],
      findings: [],
    });
  });

  it('assembles verified current findings as structured data without raw evidence or caveats', () => {
    h = new ResearchHarness(store);
    h.request();
    h.complete();
    const result = h.send('input.committed', {
      clientMsgId: 'followup',
      text: 'What did you find?',
      modality: 'text',
    });
    const dispatch = result.effects.find(effect => effect.type === 'llm.call') as CallEffect;
    const prompt = assembleContext(h.state, dispatch);
    const research = JSON.parse(prompt.input).researchState;
    expect(research.findings[0]).toEqual({
      question: 'Does Provider A work offline?',
      verdict: 'mixed',
      claims: [
        {
          text: 'Provider A edits work offline after first sign-in',
          urls: [url],
        },
        {
          text: 'First sign-in requires a network',
          urls: [url],
        },
      ],
      validity: 'current',
    });
    expect(prompt.input).not.toContain('unlimited backups');
    expect(prompt.input).not.toContain('Card-only secondary note');
    expect(prompt.input).not.toContain('snippet');
    expect(prompt.input).not.toContain('quote');
  });

  it('excludes needs_recheck findings from context after a dependency edit', () => {
    h = new ResearchHarness(store);
    h.request();
    h.complete();
    h.send('item.action', {
      itemId: 'r1',
      expectedVersion: 1,
      action: 'edit',
      text: 'Provider A corrected',
    });
    expect(researchContext(h.state).findings).toEqual([]);
  });

  it('releases a reply sentence containing an exact verified-current finding URL', () => {
    h = new ResearchHarness(store);
    h.request();
    h.complete();
    reply(h, `See ${url} for details. `);
    expect(hasChunk(h)).toBe(true);
    expect(h.state.domain.reply?.status).toBe('streaming');
  });

  it('blocks an unlisted URL despite another verified URL in the same reply', () => {
    h = new ResearchHarness(store);
    h.request();
    h.complete();
    reply(h, `See ${url} and https://unknown.example/docs for details. `);
    expect(hasChunk(h)).toBe(false);
    expect(h.state.domain.reply?.status).toBe('aborted');
  });

  it('does not allow an attacker URL with an allowlisted prefix', () => {
    h = new ResearchHarness(store);
    h.request();
    h.complete();
    reply(h, `See ${url}/malicious for details. `);
    expect(hasChunk(h)).toBe(false);
  });

  it('blocks URLs whose finding is no longer current', () => {
    h = new ResearchHarness(store);
    h.request();
    h.complete();
    h.send('item.action', {
      itemId: 'r1',
      expectedVersion: 1,
      action: 'reject',
    });
    reply(h, `See ${url} for details. `);
    expect(hasChunk(h)).toBe(false);
  });

  it('blocks citation-only URLs even though their finding is current', () => {
    h = new ResearchHarness(store);
    h.request();
    h.complete(undefined, {
      verdict: 'inconclusive',
      claims: [{
        text: 'Provider A supports unlimited backups',
        support: [{
          url,
          quote: 'Provider A supports unlimited backups',
          sourceKind: 'vendor',
        }],
      }],
      caveats: [],
    });
    reply(h, `See ${url} for details. `);
    expect(hasChunk(h)).toBe(false);
  });

  it('still blocks credential requests containing an allowed URL', () => {
    h = new ResearchHarness(store);
    h.request();
    h.complete();
    reply(h, `Send me your password at ${url} please. `);
    expect(hasChunk(h)).toBe(false);
    expect(h.state.domain.reply?.status).toBe('aborted');
  });
});

import { describe, expect, it } from 'vitest';
import { ContributionHarness, scores } from './t12a-helpers.js';
import { readyOutput } from './t03-helpers.js';

for (const store of ['memory', 'sqlite'] as const) {
  describe(`T12a core (${store})`, () => {
    it('A: auto-investigates a requirement and option and contributes after an ordinary reply with no new user input', () => {
      const h = new ContributionHarness(store, {}, []);
      h.connect();
      const requirement = h.statement('Edits must work offline.');
      const option = h.statement('Use Provider A.', 'option');
      h.passReply();
      h.nominate([{
        kind: 'investigation',
        topic: 'Offline support',
        question: 'Does Provider A work offline?',
        publicQuery: 'Provider A offline',
        depItemIds: [requirement, option],
        scores,
      }]);
      const job = Object.values(h.state.domain.jobs)[0]!;
      expect(job.state).toBe('running');
      expect(job.promised).toBe(false);
      h.send('input.committed', {
        clientMsgId: 'ordinary',
        text: 'I am still thinking about the interface.',
        modality: 'text',
      });
      h.interpret();
      h.passReply();
      h.at += 3000;
      const inputCount = h.state.domain.inputs.length;
      h.complete(job.id);
      h.check();
      h.acknowledge();
      expect(Object.values(h.state.domain.initiative.candidates)[0]?.state).toBe('delivered');
      expect(h.state.domain.inputs).toHaveLength(inputCount);
      expect(h.state.domain.jobs[job.id]?.closureCount).toBe(0);
      h.store.close();
    });

    it('scenario 1: delivered evidence is the explicit check closure exactly once', () => {
      const h = new ContributionHarness(store);
      h.connect();
      h.request();
      h.passReply();
      h.at += 3000;
      h.complete();
      const job = Object.values(h.state.domain.jobs)[0]!;
      expect(job.closureCount).toBe(0);
      h.check();
      h.acknowledge();
      expect(h.state.domain.jobs[job.id]?.closureCount).toBe(1);
      expect(Object.values(h.state.domain.initiative.candidates).filter(value => value.payload === 'closure')).toEqual([]);
      expect(h.notices().filter(text => text.startsWith('Finished checking:'))).toEqual([]);
      h.store.close();
    });

    it('R: replacing the running job requirement cancels it and rejects the late old-version result', () => {
      const h = new ContributionHarness(store, {}, []);
      h.connect();
      const requirement = h.statement('Use Provider A.', 'option');
      h.request(['Does Provider A work offline?'], 'Provider A offline', [requirement]);
      const job = Object.values(h.state.domain.jobs)[0]!;
      h.send('input.committed', { clientMsgId: 'replace', text: 'Use local storage instead.', modality: 'text' });
      const call = h.state.domain.call!;
      const inputId = call.inputIds[0]!;
      const span = { inputId, start: 0, end: 26, quote: 'Use local storage instead.' };
      h.interpret({
        ...readyOutput,
        inputKinds: [{ inputId, kind: 'correction' }],
        ops: [{
          op: 'supersede',
          itemId: requirement,
          quoteSpans: [span],
          replacement: {
            kind: 'option',
            status: 'stated',
            text: 'Use local storage instead.',
            quoteSpans: [span],
          },
        }],
      });
      expect(h.state.domain.jobs[job.id]?.state).toBe('cancelled');
      const late = h.complete(job.id);
      expect(late.decisions[0]?.reason).toBe('late:retired_job');
      expect(Object.values(h.state.domain.findings)).toEqual([]);
      expect(Object.values(h.state.domain.initiative.candidates).every(value => value.payload === 'closure')).toBe(true);
      h.store.close();
    });

    it('R: an unrelated edit does not stale the finding or prevent its delivery', () => {
      const h = new ContributionHarness(store);
      h.connect();
      const unrelated = h.statement('Use a small interface.');
      h.request();
      h.send('item.action', { itemId: unrelated, expectedVersion: 1, action: 'edit', text: 'Use a simple interface.' });
      h.passReply();
      h.at += 3000;
      h.complete();
      h.check();
      h.acknowledge();
      expect(Object.values(h.state.domain.findings)[0]?.validity.state).toBe('current');
      expect(Object.values(h.state.domain.initiative.candidates)[0]?.state).toBe('delivered');
      h.store.close();
    });
  });
}

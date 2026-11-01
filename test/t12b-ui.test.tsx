// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ContributionPanel } from '../web/src/ContributionPanel.js';
import { Conversation } from '../web/src/components.js';
import { emptyView, nextView, type ContributionView } from '../web/src/logic/view.js';

const contribution: ContributionView = {
  candidateId: 'candidate-1',
  class: 'speak',
  payload: 'evidence',
  state: 'delivering',
  topic: 'Synthetic',
  text: '<img src=x onerror=alert(1)>',
  deliveryId: 'delivery-1',
};

beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
afterEach(() => vi.unstubAllGlobals());

it('labels evidence and links an unprompted delivery to its card', () => {
  let view = nextView(emptyView(), { type: 'contribution.upserted', ...contribution });
  view = nextView(view, { type: 'assistant.chunk', deliveryId: 'delivery-1', chunkIdx: 0, text: 'Found it.' });
  const html = renderToStaticMarkup(<Conversation view={view} />);
  expect(html).toContain('Sidethought — unprompted');
  expect(html).toContain('evidence (from sources)');
  expect(html).toContain('#contribution-candidate-1');
});

it('labels an unprompted inference as reasoning', () => {
  let view = nextView(emptyView(), { type: 'contribution.upserted', ...contribution, payload: 'inference' });
  view = nextView(view, { type: 'assistant.chunk', deliveryId: 'delivery-1', chunkIdx: 0, text: 'Consider this.' });
  expect(renderToStaticMarkup(<Conversation view={view} />)).toContain('reasoning');
});

it('escapes card text rather than rendering HTML', () => {
  const html = renderToStaticMarkup(<ContributionPanel
    contributions={[{ ...contribution, state: 'card_only' }]}
    jobs={[]}
    onApprove={() => undefined}
    onDecline={() => undefined} />);
  expect(html).toContain('&lt;img');
  expect(html).not.toContain('<img');
});

it('hides pending candidates while retaining delivered and card-only links', () => {
  const states = ['candidate', 'checking', 'delivering', 'delivered', 'card_only'] as const;
  const contributions = states.map(state => ({ ...contribution, candidateId: state, topic: state, state }));
  const html = renderToStaticMarkup(<ContributionPanel contributions={contributions} jobs={[]}
    onApprove={() => undefined} onDecline={() => undefined} />);
  expect(html).not.toContain('contribution-candidate');
  expect(html).not.toContain('contribution-checking');
  expect(html).not.toContain('contribution-delivering');
  expect(html).toContain('contribution-delivered');
  expect(html).toContain('contribution-card_only');
});

it('passes the exact job id to Check and No handlers', () => {
  const approve = vi.fn();
  const decline = vi.fn();
  const node = document.createElement('div');
  const root = createRoot(node);
  act(() => root.render(<ContributionPanel contributions={[{ ...contribution, jobId: 'job-1' }]}
    jobs={[{ jobId: 'job-1', state: 'awaiting_user', publicQuery: 'synthetic query' }]}
    onApprove={approve} onDecline={decline} />));
  expect(node.textContent).toContain('synthetic query');
  const buttons = node.querySelectorAll('button');
  act(() => { buttons[0]!.click(); buttons[1]!.click(); });
  expect(approve).toHaveBeenCalledWith('job-1');
  expect(decline).toHaveBeenCalledWith('job-1');
  act(() => root.unmount());
});

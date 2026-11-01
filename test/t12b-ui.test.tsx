// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ContributionPanel } from '../web/src/ContributionPanel.js';
import { Conversation } from '../web/src/components.js';
import { emptyView, nextView, type ContributionView } from '../web/src/logic/view.js';

const contribution: ContributionView = {
  type: 'contribution.upserted',
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
  let view = nextView(emptyView(), contribution);
  view = nextView(view, { type: 'assistant.chunk', deliveryId: 'delivery-1', chunkIdx: 0, text: 'Found it.' });
  const html = renderToStaticMarkup(<Conversation view={view} />);
  expect(html).toContain('Sidethought — unprompted');
  expect(html).toContain('evidence (from sources)');
  expect(html).toContain('#contribution-candidate-1');
});

it('labels an unprompted inference as reasoning', () => {
  let view = nextView(emptyView(), { ...contribution, payload: 'inference' });
  view = nextView(view, { type: 'assistant.chunk', deliveryId: 'delivery-1', chunkIdx: 0, text: 'Consider this.' });
  expect(renderToStaticMarkup(<Conversation view={view} />)).toContain('reasoning');
});

it('escapes card text rather than rendering HTML', () => {
  const html = renderToStaticMarkup(<ContributionPanel contributions={[contribution]} jobs={[]}
    onApprove={() => undefined} onDecline={() => undefined} />);
  expect(html).toContain('&lt;img');
  expect(html).not.toContain('<img');
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

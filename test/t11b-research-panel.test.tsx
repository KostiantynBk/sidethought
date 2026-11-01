// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FindingSchema, type Finding } from '../src/contract/models.js';
import { FindingCard, ResearchPanel } from '../web/src/ResearchPanel.js';

let container: HTMLDivElement;
let root: Root;

function finding(): Finding {
  return FindingSchema.parse({
    id: 'finding-1',
    jobId: 'job-1',
    questionKey: 'question-1',
    verdict: 'mixed',
    claims: [
      {
        text: 'Claim alpha',
        support: [{
          url: 'https://example.com/verified',
          title: 'Official source',
          quote: 'A verified quote',
          quoteVerified: true,
          published: '2026-10-01',
          sourceKind: 'official',
        }],
        corroboratedBy: [],
      },
      {
        text: 'Claim beta',
        support: [{
          url: 'https://example.com/citation',
          title: 'Community source',
          quoteVerified: false,
          sourceKind: 'community',
        }],
        corroboratedBy: [],
      },
    ],
    caveats: [],
    retrievedAt: Date.UTC(2026, 9, 30, 10, 0, 0),
    basisRev: 3,
    inputDeps: [],
    deps: [],
    rebases: [],
    validity: {
      state: 'stale',
      atRev: 3,
      reason: 'Dependencies changed',
    },
    retrievalEvidence: {
      completedSearchCalls: 1,
      issuedQueries: ['public query'],
      results: [],
    },
  });
}

function renderJob(state: string, onCancel = vi.fn()): void {
  act(() => root.render(<ResearchPanel
    jobs={[{ jobId: 'job-1', publicQuery: 'Actual public query', state }]}
    findings={[]}
    onCancel={onCancel}
  />));
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('research panel', () => {
  it('shows the actual public query and queued state with cancel', () => {
    renderJob('queued');
    expect(container.textContent).toContain('Actual public query');
    expect(container.textContent?.toLowerCase()).toContain('queued');
    expect(container.querySelector('button')?.textContent).toMatch(/cancel/i);
  });

  it('shows the running state with cancel', () => {
    renderJob('running');
    expect(container.textContent?.toLowerCase()).toContain('running');
    expect(container.querySelector('button')?.textContent).toMatch(/cancel/i);
  });

  it('passes the correct job ID when cancel is clicked', () => {
    const onCancel = vi.fn();
    renderJob('running', onCancel);
    const button = container.querySelector('button');
    expect(button).not.toBeNull();
    act(() => button!.click());
    expect(onCancel).toHaveBeenCalledExactlyOnceWith('job-1');
  });

  it('shows done without a cancel button', () => {
    renderJob('done');
    expect(container.textContent?.toLowerCase()).toContain('done');
    expect(container.querySelector('button')).toBeNull();
  });

  it('shows failed without a cancel button', () => {
    renderJob('failed');
    expect(container.textContent?.toLowerCase()).toContain('failed');
    expect(container.querySelector('button')).toBeNull();
  });

  it('shows cancelled without a cancel button', () => {
    renderJob('cancelled');
    expect(container.textContent?.toLowerCase()).toContain('cancelled');
    expect(container.querySelector('button')).toBeNull();
  });
});

describe('finding card', () => {
  it('shows the verdict, claim verification, source metadata and retrieval time', () => {
    act(() => root.render(<FindingCard finding={finding()} />));
    const text = container.textContent ?? '';
    expect(text.toLowerCase()).toContain('mixed');
    expect(text).toContain('Claim alpha');
    expect(text).toContain('Claim beta');
    expect(text.toLowerCase()).toMatch(/verified/);
    expect(text.toLowerCase()).toMatch(/citation.only/);
    expect(text).toContain('A verified quote');
    expect(text.toLowerCase()).toContain('official');
    expect(text.toLowerCase()).toContain('community');
    expect(text).toContain('2026');
    expect(text.toLowerCase()).toMatch(/retrieved/);
    const link = container.querySelector('a[href="https://example.com/verified"]');
    expect(link?.textContent).toContain('Official source');
    expect(link?.getAttribute('rel')?.split(/\s+/)).toEqual(expect.arrayContaining(['noopener', 'noreferrer']));
  });

  it('labels a stale finding with its earlier revision', () => {
    act(() => root.render(<FindingCard finding={finding()} />));
    expect(container.textContent?.toLowerCase()).toMatch(/earlier version\s+r3/);
  });

  it('labels a finding that needs recheck', () => {
    const value = finding();
    value.validity = { state: 'needs_recheck', editedItemIds: ['item-1'] };
    act(() => root.render(<FindingCard finding={value} />));
    expect(container.textContent?.toLowerCase()).toMatch(/needs recheck/);
  });

  it('renders hostile claim, source title, and quote as text rather than HTML', () => {
    const value = finding();
    value.claims[0]!.text = '<img src=x onerror=alert(1)>';
    value.claims[0]!.support[0]!.title = '<strong>hostile title</strong>';
    value.claims[0]!.support[0]!.quote = '<script>hostile quote</script>';
    act(() => root.render(<FindingCard finding={value} />));
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(container.textContent).toContain('<strong>hostile title</strong>');
    expect(container.textContent).toContain('<script>hostile quote</script>');
    expect(container.querySelector('img, script')).toBeNull();
    expect(Array.from(container.querySelectorAll('strong')).some(node => node.textContent === 'hostile title'))
      .toBe(false);
  });
});

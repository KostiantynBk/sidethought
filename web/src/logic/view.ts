import type { Finding } from '../../../src/contract/models.js';
import type { ResearchJob } from '../ResearchPanel.js';
import { mergeChunk, type TranscriptDelivery } from './transcript.js';

export type Item = {
  id: string;
  kind: string;
  status: string;
  text: string;
  contentVersion: number;
  quoteSpans?: Array<{ quote: string }>;
  provenance?: { quoteSpans: Array<{ quote: string }> };
};

export type Delivery = {
  deliveryId: string;
  text: string;
  interrupted: boolean;
};

export type Snapshot = {
  inputs: Array<{ id: string; text: string }>;
  deliveries: Delivery[];
  streamingChunks: Array<{ deliveryId: string; chunkIdx: number; text: string }>;
  possiblyDelivered: Delivery[];
  items: Item[];
  replyStatus: string;
};

export type Message = Record<string, unknown> & { type: string };
export type TimelineEntry = { kind: 'input' | 'delivery'; id: string };
export type View = {
  inputs: Snapshot['inputs'];
  deliveries: Record<string, TranscriptDelivery>;
  prefixes: Record<string, Delivery>;
  cards: Delivery[];
  items: Item[];
  notices: string[];
  decisions: string[];
  timeline: TimelineEntry[];
  jobs: ResearchJob[];
  findings: Finding[];
};

export const emptyView = (): View => ({
  inputs: [],
  deliveries: {},
  prefixes: {},
  cards: [],
  items: [],
  notices: [],
  decisions: [],
  timeline: [],
  jobs: [],
  findings: [],
});

function newDelivery(id: string): TranscriptDelivery {
  return {
    deliveryId: id,
    chunks: [],
    stopped: false,
  };
}

function addChunk(view: View, id: string, index: number, text: string): View {
  const previous = view.deliveries[id] ?? newDelivery(id);
  const exists = view.timeline.some(entry => entry.kind === 'delivery' && entry.id === id);
  const timeline = exists ? view.timeline : [...view.timeline, { kind: 'delivery' as const, id }];
  return {
    ...view,
    timeline,
    deliveries: {
      ...view.deliveries,
      [id]: mergeChunk(previous, { chunkIdx: index, text }),
    },
  };
}

function snapshotView(snapshot: Snapshot): View {
  let view = emptyView();
  view.inputs = snapshot.inputs;
  view.cards = snapshot.possiblyDelivered;
  view.items = snapshot.items;
  view.prefixes = Object.fromEntries(snapshot.deliveries.map(delivery => [delivery.deliveryId, delivery]));
  view.timeline = [
    ...snapshot.inputs.map(input => ({ kind: 'input' as const, id: input.id })),
    ...snapshot.deliveries.map(delivery => ({ kind: 'delivery' as const, id: delivery.deliveryId })),
  ];
  for (const chunk of snapshot.streamingChunks) view = addChunk(view, chunk.deliveryId, chunk.chunkIdx, chunk.text);
  view.timeline.sort((a, b) => Number(a.id.split('.')[1]) - Number(b.id.split('.')[1]));
  return view;
}

function updateDelivery(view: View, id: string, update: Partial<TranscriptDelivery>): View {
  const previous = view.deliveries[id] ?? newDelivery(id);
  return {
    ...view,
    deliveries: {
      ...view.deliveries,
      [id]: { ...previous, ...update },
    },
  };
}

export function nextView(view: View, message: Message): View {
  if (message.type === 'ui.snapshot') return snapshotView(message.state as Snapshot);
  if (message.type === 'assistant.chunk') {
    return addChunk(view, message.deliveryId as string, message.chunkIdx as number, message.text as string);
  }
  if (message.type === 'assistant.done') {
    const id = message.deliveryId;
    const count = message.chunkCount;
    if (typeof id !== 'string' || typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1) return view;
    return updateDelivery(view, id, { chunkCount: count });
  }
  if (message.type === 'assistant.stopped') {
    return updateDelivery(view, message.deliveryId as string, { stopped: true });
  }
  if (message.type === 'job.updated') {
    const job = { jobId: message.jobId as string, publicQuery: message.publicQuery as string, state: message.state as string };
    return { ...view, jobs: [...view.jobs.filter(previous => previous.jobId !== job.jobId), job] };
  }
  if (message.type === 'finding.upserted') {
    const finding = message.finding as Finding;
    return { ...view, findings: [...view.findings.filter(previous => previous.id !== finding.id), finding] };
  }
  if (message.type === 'project.changed') return { ...view, items: message.items as Item[] };
  if (message.type === 'transcript.appended') return { ...view, notices: [...view.notices, message.text as string] };
  if (message.type === 'inspector.decision') {
    return { ...view, decisions: [...view.decisions, message.reason as string] };
  }
  return view;
}

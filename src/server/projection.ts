import type { Delivery } from '../contract/index.js';
import { projectContributions, type State } from '../kernel/index.js';
import { projectFinding } from '../kernel/research/findings.js';
import { projectJob } from '../kernel/research/lifecycle.js';

export type ProjectedDelivery = {
  deliveryId: string;
  text: string;
  interrupted: boolean;
};

export type StreamingChunk = {
  deliveryId: string;
  chunkIdx: number;
  text: string;
};

function sentChunks(delivery: Delivery): StreamingChunk[] {
  return delivery.chunks.flatMap((chunk, chunkIdx) => {
    if (chunk.state !== 'sent' && chunk.state !== 'rendered' && chunk.state !== 'played') return [];
    return [{
      deliveryId: delivery.id,
      chunkIdx,
      text: chunk.text,
    }];
  });
}

export function projectState(state: State) {
  const deliveries: ProjectedDelivery[] = [];
  const streamingChunks: StreamingChunk[] = [];
  const possiblyDelivered: ProjectedDelivery[] = [];
  for (const delivery of Object.values(state.domain.deliveries)) {
    const chunks = sentChunks(delivery);
    const text = chunks.map(chunk => chunk.text).join('');
    const prefixLength = Math.min(delivery.deliveredChars, text.length);
    const interrupted = delivery.state === 'interrupted';
    if (prefixLength > 0) {
      deliveries.push({
        deliveryId: delivery.id,
        text: text.slice(0, prefixLength),
        interrupted,
      });
    }
    const streaming = state.domain.reply?.status === 'streaming'
      && state.domain.reply.deliveryId === delivery.id;
    if (streaming) {
      streamingChunks.push(...chunks);
    } else if (!delivery.finalAcknowledged && prefixLength < text.length) {
      possiblyDelivered.push({
        deliveryId: delivery.id,
        text: text.slice(prefixLength),
        interrupted,
      });
    }
  }
  return {
    inputs: state.domain.inputs.filter(input => input.origin !== 'assistant').map(input => ({
      id: input.id,
      text: input.text,
    })),
    deliveries,
    streamingChunks,
    possiblyDelivered,
    items: Object.values(state.domain.items).map(item => structuredClone(item)),
    jobs: Object.values(state.domain.jobs).map(projectJob),
    findings: Object.values(state.domain.findings).map(projectFinding),
    contributions: projectContributions(state),
    replyStatus: state.domain.reply?.status ?? 'idle',
  };
}

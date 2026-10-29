export type Chunk = {
  chunkIdx: number;
  text: string;
};

export type TranscriptDelivery = {
  deliveryId: string;
  chunks: Chunk[];
  stopped: boolean;
  visibleLimit?: number;
  chunkCount?: number;
  complete?: boolean;
};

export type RenderProgress = {
  deliveryId: string;
  chunkIdx: number;
  chars: number;
  final: boolean;
  reason: 'rendered';
};

export type FinalProgress = RenderProgress & { final: true };

export function mergeChunk(delivery: TranscriptDelivery, chunk: Chunk): TranscriptDelivery {
  if (delivery.chunks.some(existing => existing.chunkIdx === chunk.chunkIdx)) return delivery;
  return {
    ...delivery,
    chunks: [...delivery.chunks, chunk].sort((a, b) => a.chunkIdx - b.chunkIdx),
  };
}

export function contiguousText(chunks: Chunk[]): string {
  let text = '';
  let index = 0;
  for (const chunk of [...chunks].sort((a, b) => a.chunkIdx - b.chunkIdx)) {
    if (chunk.chunkIdx !== index) break;
    text += chunk.text;
    index++;
  }
  return text;
}

export function renderedUpTo(chunks: Chunk[], renderedChunkIdx: number, charsInChunk: number): number {
  let total = 0;
  for (const chunk of [...chunks].sort((a, b) => a.chunkIdx - b.chunkIdx)) {
    if (chunk.chunkIdx > renderedChunkIdx) break;
    if (chunk.chunkIdx === renderedChunkIdx) return total + Math.max(0, Math.min(charsInChunk, chunk.text.length));
    total += chunk.text.length;
  }
  return total;
}

export function visibleOffset(chunks: Chunk[], visibleChars: number): number {
  let preceding = 0;
  for (const chunk of [...chunks].sort((a, b) => a.chunkIdx - b.chunkIdx)) {
    if (visibleChars <= preceding + chunk.text.length) {
      return renderedUpTo(chunks, chunk.chunkIdx, visibleChars - preceding);
    }
    preceding += chunk.text.length;
  }
  const last = chunks.at(-1);
  return last ? renderedUpTo(chunks, last.chunkIdx, last.text.length) : 0;
}

export function pendingProgress(delivery: TranscriptDelivery, lastAcknowledged: number): RenderProgress[] {
  let chars = 0;
  let expected = 0;
  const result: RenderProgress[] = [];
  for (const chunk of delivery.chunks) {
    if (chunk.chunkIdx !== expected++) break;
    chars += chunk.text.length;
    if (chunk.chunkIdx <= lastAcknowledged) continue;
    result.push({
      deliveryId: delivery.deliveryId,
      chunkIdx: chunk.chunkIdx,
      chars,
      final: false,
      reason: 'rendered',
    });
  }
  return result;
}

// Called after React paints: a complete, contiguous delivery is safe to acknowledge.
export function finalProgress(delivery: TranscriptDelivery): FinalProgress | undefined {
  const count = delivery.chunkCount;
  // A [PASS] creates no delivery; never invent an acknowledgement for zero chunks.
  if (count === undefined || count < 1 || !Number.isSafeInteger(count)) return undefined;
  if (delivery.stopped || delivery.complete || delivery.chunks.length < count) return undefined;
  const chunks = [...delivery.chunks].sort((a, b) => a.chunkIdx - b.chunkIdx);
  for (let index = 0; index < count; index++) {
    if (chunks[index]?.chunkIdx !== index) return undefined;
  }
  const last = chunks[count - 1]!;
  return {
    deliveryId: delivery.deliveryId,
    chunkIdx: last.chunkIdx,
    chars: chunks.slice(0, count).reduce((total, chunk) => total + chunk.text.length, 0),
    final: true,
    reason: 'rendered',
  };
}

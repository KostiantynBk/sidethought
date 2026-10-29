import type { Config } from '../config/index.js';
import type { Delivery, ReplyGeneration } from '../contract/index.js';
import type { Context } from './state.js';

export const OUTPUT_CHECK_NOTICE = 'I stopped this reply because it failed an output safety check.';

export function outputFailure(text: string, config: Config): 'credential' | 'url' | undefined {
  const normalized = text.normalize('NFKC').replace(/\p{Cf}/gu, '').replace(/\s+/gu, ' ');
  if (config.credentialRequestPatterns.some(pattern => new RegExp(pattern, 'iu').test(normalized))) {
    return 'credential';
  }
  // §11.3: no findings exist yet, so no URL has an allowed provenance.
  const scheme = /\b(?:https?|ftp|file|mailto|data|javascript|wss?):|\bwww\./iu;
  const domain = /\b(?:[a-z0-9][a-z0-9-]*\.)+[a-z]{2,63}\b/iu;
  if (scheme.test(normalized) || domain.test(normalized)) return 'url';
  return undefined;
}

function rejectOutput(context: Context, reply: ReplyGeneration, delivery: Delivery, reason: string): void {
  reply.status = 'aborted';
  reply.buffer = '';
  delivery.aborted = true;
  delivery.state = 'interrupted';
  for (const chunk of delivery.chunks) {
    if (chunk.state !== 'pending') continue;
    chunk.state = 'discarded';
    chunk.text = '';
    chunk.claimIds = [];
    chunk.sentenceFinished = false;
  }
  context.domain.replyPending = false;
  context.effects.push({
    type: 'llm.abort',
    callId: reply.callId,
  });
  // This is a fixed kernel notice, not another chunk from the aborted generation (I3).
  context.effects.push({
    type: 'client.send',
    message: {
      type: 'transcript.appended',
      text: OUTPUT_CHECK_NOTICE,
    },
  });
  context.itemDecisions.push(`reply:output_blocked:${reason}`);
}

export function releaseReplySentences(
  context: Context,
  reply: ReplyGeneration,
  delivery: Delivery,
  config: Config,
): boolean {
  for (const [chunkIdx, chunk] of delivery.chunks.entries()) {
    if (chunk.state !== 'pending') continue;
    const reason = outputFailure(chunk.text, config);
    if (reason) {
      rejectOutput(context, reply, delivery, reason);
      return false;
    }
    chunk.state = 'sent';
    delivery.sentChars += chunk.text.length;
    context.effects.push({
      type: 'client.send',
      message: {
        type: 'assistant.chunk',
        deliveryId: delivery.id,
        chunkIdx,
        text: chunk.text,
      },
    });
  }
  return true;
}

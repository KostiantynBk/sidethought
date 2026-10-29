import type { Config } from '../config/index.js';
import type { Delivery, ReplyGeneration } from '../contract/index.js';
import type { Context } from './state.js';
import { normalizeOutput, removeAbbreviationDots } from './output-normalization.js';
import { containsUrl } from './output-url.js';

export const OUTPUT_CHECK_NOTICE = 'I stopped this reply because it failed an output safety check.';

export function outputFailure(text: string, config: Config): 'credential' | 'url' | undefined {
  const normalized = removeAbbreviationDots(normalizeOutput(text));
  for (const pattern of config.credentialRequestPatterns) {
    for (const match of normalized.matchAll(new RegExp(pattern, 'giu'))) {
      const earlier = normalized.slice(0, match.index).split(/[.!?;:]/u).at(-1) ?? '';
      const caution = /\b(?:never|don't|do not|avoid|shouldn't|must not|no one|nobody)\b/u;
      if (caution.test(earlier) || caution.test(match[0])) continue;
      return 'credential';
    }
  }
  if (containsUrl(text)) return 'url';
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
    const previous = delivery.chunks.slice(0, chunkIdx).findLast(item => item.state === 'sent');
    const reason = outputFailure(chunk.text, config)
      ?? (previous ? outputFailure(`${previous.text} ${chunk.text}`, config) : undefined);
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

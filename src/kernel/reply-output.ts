import type { Config } from '../config/index.js';
import type { Delivery, ReplyGeneration } from '../contract/index.js';
import type { Context } from './state.js';
import { normalizeOutput, removeAbbreviationDots } from './output-normalization.js';
import { containsCredentialRequest } from './output-credentials.js';
import { containsUrl } from './output-url.js';

export const OUTPUT_CHECK_NOTICE = 'I stopped this reply because it failed an output safety check.';

export function outputFailure(text: string, config: Config): 'credential' | 'url' | undefined {
  const normalized = removeAbbreviationDots(normalizeOutput(text));
  if (containsCredentialRequest(normalized, config)) return 'credential';
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
  // The sentinel is control data, never user-facing text, even after earlier output.
  delivery.chunks = delivery.chunks.filter(chunk => chunk.state !== 'pending' || chunk.text.trim() !== '[PASS]');
  for (const [chunkIdx, chunk] of delivery.chunks.entries()) {
    if (chunk.state !== 'pending') continue;
    const previous = delivery.chunks.slice(0, chunkIdx)
      .findLast(item => ['sent', 'rendered', 'played'].includes(item.state));
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

import type { ResponseCreateParamsStreaming } from 'openai/resources/responses/responses.js';
import type { CallEffect, RolePrompt } from '../../context/index.js';
import type { State } from '../../kernel/index.js';

import { interpreterJsonSchema } from './schema.js';

export function requestBody(state: State, effect: CallEffect, prompt: RolePrompt): ResponseCreateParamsStreaming {
  let cap = state.config.responderMaxOutputTokens;
  if (effect.role === 'interpreter') {
    const call = state.domain.call;
    if (!call || call.callId !== effect.callId || call.requestId !== effect.requestId) {
      throw new Error('model:owner_mismatch');
    }
    // §12 / T09 decision 2: the kernel's fresh callId owns the higher-cap retry.
    const multiplier = call.attempt >= 2 ? state.config.structuredRetryTokenMultiplier : 1;
    cap = Math.ceil(state.config.interpreterMaxOutputTokens * multiplier);
  }
  return {
    model: 'muse-spark-1.3',
    stream: true,
    store: false,
    reasoning: { effort: 'low' },
    max_output_tokens: cap,
    instructions: prompt.instructions,
    input: prompt.input,
    ...(effect.role === 'interpreter' ? {
      text: {
        format: {
          type: 'json_schema',
          name: 'interpreter_output',
          strict: true,
          schema: interpreterJsonSchema,
        },
      },
    } : {}),
  };
}

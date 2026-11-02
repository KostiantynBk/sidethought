import type { ResponseCreateParamsStreaming } from 'openai/resources/responses/responses.js';
import type { CallEffect, RolePrompt } from '../../context/index.js';
import type { State } from '../../kernel/index.js';

import { checkerJsonSchema, deliberatorJsonSchema, interpreterJsonSchema } from './schema.js';

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
  if (effect.role === 'deliberator') cap = state.config.deliberatorMaxOutputTokens;
  if (effect.role === 'checker') cap = state.config.checkerMaxOutputTokens;
  const formats = {
    interpreter: interpreterJsonSchema,
    deliberator: deliberatorJsonSchema,
    checker: checkerJsonSchema,
  };
  const schema = effect.role in formats ? formats[effect.role as keyof typeof formats] : undefined;
  return {
    model: 'muse-spark-1.3',
    stream: true,
    store: false,
    // T13 live checks: low exhausted 673/800 Responder tokens and both 1200/1800 Interpreter caps.
    // Use minimal for these two foreground roles; do not raise caps or weaken schema/quote checks.
    reasoning: { effort: effect.role === 'deliberator' ? 'medium' : 'minimal' },
    max_output_tokens: cap,
    instructions: prompt.instructions,
    input: prompt.input,
    ...(schema ? {
      text: {
        format: {
          type: 'json_schema',
          name: `${effect.role}_output`,
          strict: true,
          schema,
        },
      },
    } : {}),
  };
}

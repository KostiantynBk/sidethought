type StreamRecord = {
  type: string;
  [key: string]: unknown;
};

function decodeRecord(lines: string[]): StreamRecord | 'done' | undefined {
  const data = lines.filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).replace(/^ /, '')).join('\n');
  if (!data) return;
  if (data === '[DONE]') return 'done';
  const value: unknown = JSON.parse(data);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_stream_event');
  const record = value as Record<string, unknown>;
  const eventName = lines.find(line => line.startsWith('event:'))?.slice(6).trim();
  const type = record.type ?? eventName;
  if (typeof type !== 'string') throw new Error('invalid_stream_event');
  return {
    ...record,
    type,
  };
}

// The SDK's high-level iterator throws on `event: error`, discarding outer usage when error is nested.
// Keep the original terminal envelope by requesting .asResponse() and decoding SSE here instead.
export async function* readEvents(response: Response, signal: AbortSignal): AsyncGenerator<StreamRecord> {
  if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
    throw new Error('invalid_stream_response');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', cancel, { once: true });
  let buffer = '';
  let lines: string[] = [];
  try {
    while (!signal.aborted) {
      const part = await reader.read();
      buffer += decoder.decode(part.value, { stream: !part.done });
      // Handle LF, CRLF and CR; defer a trailing CR until the next network chunk.
      const pattern = part.done ? /\r\n|\r|\n/ : /\r\n|\r(?!$)|\n/;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(buffer))) {
        const line = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        if (line) {
          lines.push(line);
        } else {
          const event = decodeRecord(lines);
          lines = [];
          if (signal.aborted || event === 'done') return;
          if (event) yield event;
        }
      }
      if (part.done) {
        if (buffer) lines.push(buffer);
        const event = decodeRecord(lines);
        if (!signal.aborted && event && event !== 'done') yield event;
        return;
      }
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    cancel();
    reader.releaseLock();
  }
}

export function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

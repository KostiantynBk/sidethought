import { useEffect, useState } from 'react';
import { projectApi } from './project-api.js';

type Status = {
  pending: number;
  failedCount: number;
  needsRetry: Array<{ id: string; preview: string }>;
};

export function InputStatus({ projectId, retry }: { projectId: string; retry: (inputId: string) => boolean }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    async function refresh() {
      try {
        const result = await projectApi<Status>(`/projects/${projectId}/input-status`);
        if (active) {
          setStatus(result);
          setBusy(null);
          setError('');
        }
      } catch {
        if (active) setError('Could not check whether messages reached project state.');
      }
    }
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 3000);
    return () => { active = false; clearInterval(timer); };
  }, [projectId]);
  if (!status) return error ? <p role="alert">{error}</p> : null;
  return <div aria-label="Project interpretation status">
    {error && <p role="alert">{error}</p>}
    {status.pending > 0 && <p>Interpreting {status.pending} message(s) for project state…</p>}
    {status.failedCount === 0 && status.pending === 0 && <small>Received messages interpreted for project state.</small>}
    {status.failedCount > 0 && <>
      <p role="alert">{status.failedCount} message(s) did not reach project state, even if chat replied.</p>
      <p>Retry one message explicitly below. This makes another model call when using Meta.</p>
      {status.needsRetry.map(input => <div key={input.id}>
        <p>{input.preview}</p>
        <button type="button" disabled={busy === input.id} onClick={() => {
          if (retry(input.id)) setBusy(input.id);
          else setError('Connection is not ready. Please try again.');
        }}>{busy === input.id ? 'Retry requested…' : 'Retry interpretation'}</button>
      </div>)}
    </>}
  </div>;
}

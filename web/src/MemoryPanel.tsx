import { useEffect, useState, type FormEvent } from 'react';
import type { SharedLesson } from '../../src/memory/types.js';
import { projectApi } from './project-api.js';

type Source = { id: string; text: string };
type Use = { callId: string; lessonId: string; version: number };
const termsFrom = (value: string) => value.split(',').map(term => term.trim()).filter(Boolean);
const redactionWarning = 'Changing or forgetting this lesson removes assistant replies from its first use onward '
  + 'and clears extracted project state in affected target projects. Your original user messages and the source '
  + 'project remain. This cannot undo content already sent to Meta. Continue?';

type LessonCardProps = {
  lesson: SharedLesson;
  refresh: () => Promise<void>;
  onError: (message: string) => void;
};

function LessonCard({ lesson, refresh, onError }: LessonCardProps) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(lesson.text);
  const [terms, setTerms] = useState(lesson.terms.join(', '));
  async function mutate(remove: boolean) {
    if (!window.confirm(redactionWarning)) return;
    try {
      const result = await projectApi<{ storageCleanupPending?: boolean }>(
        `/lessons/${lesson.id}`, remove ? 'DELETE' : 'PUT', {
        expectedVersion: lesson.version,
        acknowledgeRedaction: true,
        ...(remove ? {} : { text, terms: termsFrom(terms) }),
      });
      setEditing(false);
      await refresh();
      if (result.storageCleanupPending) {
        onError('Lesson changed, but disk cleanup is pending. Close other database readers and restart the server.');
      }
    } catch (error) {
      onError((error as Error).message);
    }
  }
  return <article>
    <strong>From {lesson.sourceProjectName} · version {lesson.version}</strong>
    <p>{lesson.text}</p>
    <details><summary>Source and match terms</summary>
      <blockquote>{lesson.quote}</blockquote>
      <p>Source message: {lesson.sourceInputId}</p>
      <p>Match terms: {lesson.terms.join(', ')}</p>
    </details>
    <button type="button" onClick={() => setEditing(!editing)}>Edit lesson</button>
    <button type="button" onClick={() => { void mutate(true); }}>Forget lesson…</button>
    {editing && <div>
      <label>Revised lesson<textarea value={text} maxLength={1500} onChange={e => setText(e.target.value)} /></label>
      <label>Match terms<input value={terms} onChange={e => setTerms(e.target.value)} /></label>
      <button type="button" onClick={() => { void mutate(false); }}>Confirm revision…</button>
    </div>}
  </article>;
}

function LessonForm({ sources, projectId, refresh, onError }: {
  sources: Source[];
  projectId: string;
  refresh: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [sourceId, setSourceId] = useState('');
  const [quote, setQuote] = useState('');
  const [text, setText] = useState('');
  const [terms, setTerms] = useState('');
  const [saving, setSaving] = useState(false);
  function selectSource(id: string) {
    setSourceId(id);
    const source = sources.find(input => input.id === id)?.text ?? '';
    setQuote(source);
    setText(source.slice(0, 1500));
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      await projectApi(`/projects/${projectId}/lessons`, 'POST', {
        sourceInputId: sourceId,
        quote,
        text,
        terms: termsFrom(terms),
        confirmed: true,
      });
      setText('');
      setTerms('');
      await refresh();
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return <form onSubmit={event => { void save(event); }}>
    <h3>Review a reusable lesson</h3>
    <label>Source user message<select value={sourceId} onChange={e => selectSource(e.target.value)} required>
      <option value="">Choose a message from this project</option>
      {sources.map(source => <option key={source.id} value={source.id}>{source.text.slice(0, 90)}</option>)}
    </select></label>
    <label>Exact source quote<textarea value={quote} onChange={e => setQuote(e.target.value)}
      maxLength={4000} required /></label>
    <label>Lesson you confirm<textarea value={text} onChange={e => setText(e.target.value)}
      maxLength={1500} required /></label>
    <label>When relevant (1–8 comma-separated words or phrases)
      <input value={terms} onChange={e => setTerms(e.target.value)} placeholder="forecasting, time split" required />
    </label>
    <p>This explicitly shares the quote and lesson with your other enabled projects. Do not include secrets.</p>
    <button disabled={saving || !sourceId}>Confirm and share this lesson</button>
  </form>;
}

export function MemoryPanel({ projectId }: { projectId: string }) {
  const [lessons, setLessons] = useState<SharedLesson[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [uses, setUses] = useState<Use[]>([]);
  const [error, setError] = useState('');
  async function refresh() {
    const all = await projectApi<{ lessons: SharedLesson[] }>('/lessons');
    const inputs = await projectApi<{ inputs: Source[] }>(`/projects/${projectId}/inputs`);
    const audit = await projectApi<{ uses: Use[] }>(`/projects/${projectId}/lesson-uses`);
    setLessons(all.lessons);
    setSources(inputs.inputs);
    setUses(audit.uses);
  }
  useEffect(() => {
    let active = true;
    async function update() {
      try {
        const all = await projectApi<{ lessons: SharedLesson[] }>('/lessons');
        const inputs = await projectApi<{ inputs: Source[] }>(`/projects/${projectId}/inputs`);
        const audit = await projectApi<{ uses: Use[] }>(`/projects/${projectId}/lesson-uses`);
        if (!active) return;
        setLessons(all.lessons);
        setSources(inputs.inputs);
        setUses(audit.uses);
      } catch {
        if (active) setError('Could not load memory controls. Please refresh.');
      }
    }
    void update();
    const timer = setInterval(() => { void update(); }, 3000);
    return () => { active = false; clearInterval(timer); };
  }, [projectId]);
  return <section aria-label="Reviewed cross-project memory">
    <h2>Reviewed cross-project lessons</h2>
    <p>Only lessons you explicitly confirm are shared. Matching uses the words or phrases you supply,
      not semantic recall. Relevant lessons go to Meta for replies when using Meta, never to web search.
      Normal project conversations are stored; temporary sessions and project deletion are not implemented yet.</p>
    {error && <p role="alert">{error}</p>}
    <LessonForm sources={sources} projectId={projectId} refresh={refresh} onError={setError} />
    <h3>Recently supplied to this project's replies</h3>
    <p>These records prove context was supplied, not that the assistant used it well.</p>
    {!uses.length && <p>No shared lesson supplied yet.</p>}
    {uses.map(use => <p key={`${use.callId}-${use.lessonId}`}>
      {lessons.find(lesson => lesson.id === use.lessonId)?.sourceProjectName ?? 'Removed source'}
      {' · '}version {use.version}{' · '}call {use.callId}
    </p>)}
    <h3>Saved lessons</h3>
    {lessons.map(lesson => <LessonCard key={`${lesson.id}-${lesson.version}`} lesson={lesson}
      refresh={refresh} onError={setError} />)}
  </section>;
}

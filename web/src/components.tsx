import { useState, type FormEvent } from 'react';
import { contiguousText } from './logic/transcript.js';
import type { Item, View } from './logic/view.js';

type LoginProps = {
  onSuccess: () => void;
};

export function Login({ onSuccess }: LoginProps) {
  const [passcode, setPasscode] = useState('');
  const [error, setError] = useState('');
  async function login(event: FormEvent) {
    event.preventDefault();
    const response = await fetch('/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ passcode }),
    });
    setPasscode('');
    if (response.ok) onSuccess();
    else setError('Login failed or temporarily locked.');
  }
  return <main>
    <h1>Sidethought</h1>
    <form onSubmit={event => { void login(event); }}>
      <label>Passcode
        <input type="password" value={passcode} onChange={event => setPasscode(event.target.value)} />
      </label>
      <button>Log in</button>
      <p role="alert">{error}</p>
    </form>
  </main>;
}

function TranscriptEntry({ view, kind, id }: { view: View; kind: 'input' | 'delivery'; id: string }) {
  if (kind === 'input') {
    const input = view.inputs.find(item => item.id === id);
    return input && <p><strong>You:</strong> {input.text}</p>;
  }
  const delivery = view.deliveries[id];
  const prefix = view.prefixes[id];
  const text = delivery ? contiguousText(delivery.chunks).slice(0, delivery.visibleLimit) : prefix?.text ?? '';
  return <p>
    <strong>Assistant:</strong> <span id={`delivery-${id}`}>{text}</span>
    {(delivery?.stopped || prefix?.interrupted) && <em> interrupted</em>}
  </p>;
}

export function Conversation({ view }: { view: View }) {
  return <section aria-label="Conversation">
    {view.timeline.map(entry => <TranscriptEntry
      key={`${entry.kind}-${entry.id}`}
      view={view}
      kind={entry.kind}
      id={entry.id}
    />)}
    {view.notices.map((notice, index) => <p key={index}><em>{notice}</em></p>)}
    {view.cards.map(card => <p className="uncertain" key={card.deliveryId}>
      May not have been shown: {card.text}
    </p>)}
  </section>;
}

type ComposerProps = {
  draft: string;
  onTyping: (value: string) => void;
  onBlur: () => void;
  onCommit: () => void;
};

export function Composer({ draft, onTyping, onBlur, onCommit }: ComposerProps) {
  return <form onSubmit={event => { event.preventDefault(); onCommit(); }}>
    <label>Message
      <input value={draft} onChange={event => onTyping(event.target.value)} onBlur={() => onBlur()} />
    </label>
    <button>Send</button>
  </form>;
}

function ProjectGroup({ kind, items }: { kind: string; items: Item[] }) {
  return <div>
    <h3>{kind}</h3>
    {items.map(item => <article key={item.id}>
      <span>{item.status}</span>
      <p>{item.text}</p>
      {(item.quoteSpans ?? item.provenance?.quoteSpans ?? []).map((quote, index) =>
        <mark key={index}>{quote.quote}</mark>)}
    </article>)}
  </div>;
}

export function Project({ items }: { items: Item[] }) {
  const kinds = [...new Set(items.map(item => item.kind))];
  return <section>
    <h2>Project</h2>
    {kinds.map(kind => <ProjectGroup key={kind} kind={kind} items={items.filter(item => item.kind === kind)} />)}
  </section>;
}

export function Inspector({ decisions }: { decisions: string[] }) {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" onClick={() => setOpen(!open)}>Inspector</button>
    {open && <ul>{decisions.map((decision, index) => <li key={index}>{decision}</li>)}</ul>}
  </>;
}

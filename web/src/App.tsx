import { useEffect, useState } from 'react';
import { ResearchPanel } from './ResearchPanel.js';
import { Composer, Conversation, Inspector, Login, Project } from './components.js';
import { useComposer } from './useComposer.js';
import { useConnection } from './useConnection.js';

export default function App() {
  const [loggedIn, setLoggedIn] = useState(false);
  const [model, setModel] = useState<'dev' | 'meta' | null>(null);
  useEffect(() => {
    void fetch('/health').then(response => response.json()).then((health: { model?: string }) => {
      if (health.model === 'dev' || health.model === 'meta') setModel(health.model);
    }).catch(() => undefined);
  }, []);
  const connection = useConnection(loggedIn);
  const composer = useComposer(connection);

  if (!loggedIn) return <Login onSuccess={() => setLoggedIn(true)} />;
  return <main>
    <h1>Sidethought <small>{model === 'dev' ? 'dev model: no real AI' : model === 'meta' ? 'Meta Spark' : ''}</small></h1>
    <Conversation view={connection.view} />
    <Composer
      draft={composer.draft}
      onTyping={composer.onTyping}
      onBlur={composer.endActivity}
      onCommit={composer.commit}
    />
    <ResearchPanel
      jobs={connection.view.jobs}
      findings={connection.view.findings}
      onCancel={jobId => { connection.send('job.cancelRequested', { jobId }); }}
    />
    <Project items={connection.view.items} />
    <Inspector decisions={connection.view.decisions} />
  </main>;
}

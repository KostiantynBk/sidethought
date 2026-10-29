import { useState } from 'react';
import { Composer, Conversation, Inspector, Login, Project } from './components.js';
import { useComposer } from './useComposer.js';
import { useConnection } from './useConnection.js';

export default function App() {
  const [loggedIn, setLoggedIn] = useState(false);
  const connection = useConnection(loggedIn);
  const composer = useComposer(connection);

  if (!loggedIn) return <Login onSuccess={() => setLoggedIn(true)} />;
  return <main>
    <h1>Sidethought <small>dev model: no real AI</small></h1>
    <Conversation view={connection.view} />
    <Composer
      draft={composer.draft}
      onTyping={composer.onTyping}
      onBlur={composer.endActivity}
      onCommit={composer.commit}
    />
    <Project items={connection.view.items} />
    <Inspector decisions={connection.view.decisions} />
  </main>;
}

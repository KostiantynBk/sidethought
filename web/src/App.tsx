import { useState } from 'react';
import { Login } from './components.js';
import { Workspace } from './Workspace.js';

export default function App() {
  const [loggedIn, setLoggedIn] = useState(false);
  if (!loggedIn) return <Login onSuccess={() => setLoggedIn(true)} />;
  return <Workspace />;
}

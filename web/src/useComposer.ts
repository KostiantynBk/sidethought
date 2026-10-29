import { useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import type { View } from './logic/view.js';

type ComposerConnection = {
  socket: RefObject<WebSocket | null>;
  blocked: RefObject<Set<string>>;
  currentDelivery: RefObject<string | null>;
  setView: Dispatch<SetStateAction<View>>;
  send: (type: string, payload: unknown) => boolean;
};

function committedView(view: View, text: string, id: string | null, rendered: number | undefined): View {
  const inputId = crypto.randomUUID();
  const oldDelivery = id ? view.deliveries[id] : undefined;
  return {
    ...view,
    inputs: [...view.inputs, { id: inputId, text }],
    timeline: [...view.timeline, { kind: 'input', id: inputId }],
    deliveries: id && oldDelivery ? {
      ...view.deliveries,
      [id]: {
        ...oldDelivery,
        stopped: true,
        visibleLimit: rendered ?? 0,
      },
    } : view.deliveries,
  };
}

export function useComposer(connection: ComposerConnection) {
  const [draft, setDraft] = useState('');
  const activityTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function endActivity() {
    if (activityTimer.current) clearTimeout(activityTimer.current);
    activityTimer.current = null;
    connection.send('input.activity', { channel: 'composer', active: false });
  }

  function onTyping(value: string) {
    setDraft(value);
    if (!activityTimer.current) connection.send('input.activity', { channel: 'composer', active: true });
    if (activityTimer.current) clearTimeout(activityTimer.current);
    activityTimer.current = setTimeout(endActivity, 1500);
  }

  function commit() {
    const text = draft.trim();
    if (!text || connection.socket.current?.readyState !== WebSocket.OPEN) return;
    const id = connection.currentDelivery.current;
    const element = id ? document.getElementById(`delivery-${id}`) : null;
    const rendered = element?.textContent?.length;
    if (id) connection.blocked.current.add(id);
    connection.currentDelivery.current = null;
    connection.send('input.committed', {
      clientMsgId: crypto.randomUUID(),
      text,
      modality: 'text',
      ...(rendered === undefined ? {} : { renderedUpTo: rendered }),
    });
    connection.setView(previous => committedView(previous, text, id, rendered));
    setDraft('');
    if (activityTimer.current) clearTimeout(activityTimer.current);
    activityTimer.current = null;
  }

  return { draft, onTyping, endActivity, commit };
}

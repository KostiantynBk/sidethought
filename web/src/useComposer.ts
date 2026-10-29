import { useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { idle, typing, type ActivityState } from './logic/activity.js';
import { visibleOffset } from './logic/transcript.js';
import type { View } from './logic/view.js';

type ComposerConnection = {
  socket: RefObject<WebSocket | null>;
  blocked: RefObject<Set<string>>;
  currentDelivery: RefObject<string | null>;
  view: View;
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
  const activity = useRef<ActivityState>({ active: false, idleAt: null });

  function endActivity(blurred = true) {
    const next = idle(activity.current, Date.now(), blurred);
    if (activity.current.active && !next.active) {
      connection.send('input.activity', { channel: 'composer', active: false });
    }
    activity.current = next;
    if (activityTimer.current) clearTimeout(activityTimer.current);
    activityTimer.current = null;
  }

  function onTyping(value: string) {
    setDraft(value);
    if (!activity.current.active) connection.send('input.activity', { channel: 'composer', active: true });
    activity.current = typing(Date.now());
    if (activityTimer.current) clearTimeout(activityTimer.current);
    activityTimer.current = setTimeout(() => endActivity(false), 1500);
  }

  function commit() {
    const text = draft.trim();
    if (!text || connection.socket.current?.readyState !== WebSocket.OPEN) return;
    const id = connection.currentDelivery.current;
    const element = id ? document.getElementById(`delivery-${id}`) : null;
    const visible = element?.textContent?.length;
    const chunks = id ? connection.view.deliveries[id]?.chunks : undefined;
    const rendered = visible !== undefined && chunks ? visibleOffset(chunks, visible) : undefined;
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
    activity.current = { active: false, idleAt: null };
  }

  return { draft, onTyping, endActivity, commit };
}

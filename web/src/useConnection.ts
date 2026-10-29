import { useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { finalProgress, pendingProgress, type TranscriptDelivery } from './logic/transcript.js';
import { emptyView, nextView, type Message, type Snapshot, type View } from './logic/view.js';

type Send = (type: string, payload: unknown) => boolean;
type ConnectionRefs = {
  socket: RefObject<WebSocket | null>;
  blocked: RefObject<Set<string>>;
  currentDelivery: RefObject<string | null>;
  acknowledged: RefObject<Map<string, number>>;
  finalAcknowledged: RefObject<Set<string>>;
};

function acknowledgeChunks(delivery: TranscriptDelivery, send: Send, acknowledged: Map<string, number>): void {
  const last = acknowledged.get(delivery.deliveryId) ?? -1;
  for (const progress of pendingProgress(delivery, last)) {
    if (!send('delivery.progress', progress)) break;
    acknowledged.set(delivery.deliveryId, progress.chunkIdx);
  }
}

function finishView(view: View, id: string): View {
  const delivery = view.deliveries[id];
  if (!delivery || delivery.complete) return view;
  return {
    ...view,
    deliveries: {
      ...view.deliveries,
      [id]: { ...delivery, complete: true },
    },
  };
}

function receive(message: Message, refs: ConnectionRefs, setView: Dispatch<SetStateAction<View>>): void {
  if (message.type === 'ui.snapshot') {
    refs.blocked.current.clear();
    const snapshot = message.state as Snapshot;
    refs.currentDelivery.current = snapshot.streamingChunks.at(-1)?.deliveryId ?? null;
  }
  if (message.type === 'assistant.chunk') {
    const id = message.deliveryId as string;
    if (refs.blocked.current.has(id) || refs.finalAcknowledged.current.has(id)) return;
    refs.currentDelivery.current = id;
  }
  setView(previous => nextView(previous, message));
}

function useSocket(loggedIn: boolean, setView: Dispatch<SetStateAction<View>>) {
  const refs: ConnectionRefs = {
    socket: useRef<WebSocket | null>(null),
    blocked: useRef(new Set<string>()),
    currentDelivery: useRef<string | null>(null),
    acknowledged: useRef(new Map<string, number>()),
    finalAcknowledged: useRef(new Set<string>()),
  };

  useEffect(() => {
    if (!loggedIn) return;
    let active = true;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${protocol}//${location.host}/ws`);
      refs.socket.current = ws;
      ws.onmessage = event => receive(JSON.parse(String(event.data)) as Message, refs, setView);
      ws.onclose = () => {
        if (active) reconnect = setTimeout(connect, 1000);
      };
    };
    connect();
    return () => {
      active = false;
      if (reconnect) clearTimeout(reconnect);
      refs.socket.current?.close();
    };
  }, [loggedIn]);

  function send(type: string, payload: unknown): boolean {
    if (refs.socket.current?.readyState !== WebSocket.OPEN) return false;
    refs.socket.current.send(JSON.stringify({ type, payload }));
    return true;
  }
  return { refs, send };
}

function useAcknowledge(view: View, setView: Dispatch<SetStateAction<View>>, refs: ConnectionRefs, send: Send) {
  useEffect(() => {
    for (const delivery of Object.values(view.deliveries)) {
      if (delivery.stopped || refs.blocked.current.has(delivery.deliveryId)) continue;
      acknowledgeChunks(delivery, send, refs.acknowledged.current);
      const progress = finalProgress(delivery);
      if (!progress || refs.finalAcknowledged.current.has(delivery.deliveryId)) continue;
      if (!send('delivery.progress', progress)) continue;
      refs.finalAcknowledged.current.add(delivery.deliveryId);
      if (refs.currentDelivery.current === delivery.deliveryId) refs.currentDelivery.current = null;
      setView(previous => finishView(previous, delivery.deliveryId));
    }
  }, [view.deliveries]);
}

export function useConnection(loggedIn: boolean) {
  const [view, setView] = useState<View>(emptyView);
  const { refs, send } = useSocket(loggedIn, setView);
  useAcknowledge(view, setView, refs, send);
  return {
    view,
    setView,
    socket: refs.socket,
    blocked: refs.blocked,
    currentDelivery: refs.currentDelivery,
    send,
  };
}

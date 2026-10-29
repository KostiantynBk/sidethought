import type { State, Context, Timer } from './index.js';

const REARM_ON_RECOVERY: Timer['purpose'][] = [
  'rateLimit',
  'answerWait',
  'userWait',
  'candidateExpiry',
  'waitExpiry',
  'deliveryAck',
];

export function recoverDomain(context: Context): string {
  const domain = context.domain;
  if (domain.call) {
    domain.interruptedCalls = [...domain.interruptedCalls, {
      ...domain.call,
      status: 'interrupted',
    }];
  }
  domain.call = null;
  for (const input of domain.inputs) {
    if (input.status !== 'interpreted') input.status = 'needs_retry';
  }
  domain.replyPending = false;
  domain.composerActive = false;
  domain.replyStartWaiting = false;
  // New A1 state must not leave a live owner after the existing AD-9 recovery path.
  if (domain.reply?.status === 'streaming') {
    domain.reply.status = 'interrupted';
    domain.reply.buffer = '';
    const delivery = domain.deliveries[domain.reply.deliveryId]!;
    delivery.state = 'interrupted';
    for (const chunk of delivery.chunks) {
      if (chunk.state === 'pending') chunk.state = 'discarded';
    }
  }
  domain.awaitingUserAnswer = false;
  domain.userWait = false;
  domain.clientConnected = false;
  domain.reservations = [];
  domain.timers = domain.timers.filter(timer => REARM_ON_RECOVERY.includes(timer.purpose));
  for (const timer of domain.timers) {
    context.effects.push({
      type: 'timer.set',
      ...timer,
    });
  }
  return 'session:recovered';
}

export function connectClient(
  context: Context,
  state: State,
  acceptedAt: number,
  modality: 'text' | 'voice',
): string {
  context.domain.clientConnected = true;
  context.domain.lastFloorActivity = acceptedAt;
  for (const timer of context.domain.timers.filter(item => item.purpose === 'floorGap')) {
    context.effects.push({
      type: 'timer.clear',
      timerId: timer.timerId,
    });
  }
  context.domain.timers = context.domain.timers.filter(timer => timer.purpose !== 'floorGap');
  const timer: Timer = {
    timerId: context.id(),
    purpose: 'floorGap',
    dueAt: acceptedAt + (modality === 'text' ? state.config.gapTextMs : state.config.gapVoiceMs),
  };
  context.domain.timers.push(timer);
  context.effects.push({
    type: 'timer.set',
    ...timer,
  });
  return 'client:connected';
}


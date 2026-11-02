import type { Message, Snapshot } from './view.js';

export interface Synthesizer {
  available: boolean;
  speak(text: string): void;
  cancel(): void;
}

export function cleanSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, ' code omitted ')
    .replace(/`+[^`]*`+/g, ' code omitted ')
    .replace(/https?:\/\/[^\s<>()]+/gi, 'link')
    .replace(/[*_#>|]/g, ' ')
    .replace(/(^|\n)\s*[-+]\s+/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

export class ReadAloud {
  private enabled = false;
  private hidden = false;
  private seen = new Set<string>();

  constructor(private readonly synth: Synthesizer) {}

  get available(): boolean {
    return this.synth.available;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled && this.available;
    if (!this.enabled) this.cancel();
  }

  unlock(): void {
    if (this.available) this.synth.speak('');
  }

  cancel(): void {
    this.synth.cancel();
  }

  setHidden(hidden: boolean): void {
    this.hidden = hidden;
    if (hidden) this.cancel();
  }

  switchProject(): void {
    this.cancel();
    this.seen.clear();
  }

  receive(message: Message): void {
    if (message.type === 'ui.snapshot') {
      const snapshot = message.state as Snapshot;
      for (const chunk of snapshot.streamingChunks) this.seen.add(`${chunk.deliveryId}:${chunk.chunkIdx}`);
      return;
    }
    if (message.type !== 'assistant.chunk' || typeof message.deliveryId !== 'string'
      || typeof message.chunkIdx !== 'number' || typeof message.text !== 'string') return;
    const key = `${message.deliveryId}:${message.chunkIdx}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    if (!this.enabled || this.hidden) return;
    const text = cleanSpeech(message.text);
    if (text) this.synth.speak(text);
  }
}

export function browserSynthesizer(): Synthesizer {
  const available = typeof window !== 'undefined' && !!window.speechSynthesis
    && typeof SpeechSynthesisUtterance !== 'undefined';
  return {
    available,
    speak(text) {
      if (!available) return;
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = 'en';
      utterance.rate = 1;
      const voices = window.speechSynthesis.getVoices();
      const voice = voices.find(candidate => candidate.localService && /^en(?:-|$)/i.test(candidate.lang));
      if (voice) utterance.voice = voice;
      window.speechSynthesis.speak(utterance);
    },
    cancel() {
      if (available) window.speechSynthesis.cancel();
    },
  };
}

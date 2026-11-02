import type { ContributionView } from './logic/view.js';

export function contributionLabel(item: ContributionView): string {
  if (item.lessons?.length) return 'experience';
  if (item.payload === 'evidence') return 'evidence (from sources)';
  if (item.payload === 'clarification') return 'question';
  if (item.payload === 'inference') return 'reasoning';
  return item.payload;
}

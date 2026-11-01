import type { Job } from '../../contract/index.js';

export type ResearchJob = Job & {
  inputIds: string[];
  depItemIds: string[];
  closureCount: number;
  completedAt?: number;
  deadlineTimerId?: string;
};

export type ResearchBudget = {
  spentUsd: number;
  reservedUsd: number;
  queries: number;
  calls: Record<string, {
    jobId?: string;
    reservedUsd: number;
    costUsd: number;
    queries: number;
  }>;
  global: {
    spentTodayUsd: number;
    reservedUsd: number;
    reserveUsd: number;
    sessionSpentAtUpdate: number;
  } | null;
};

export function emptyResearchBudget(): ResearchBudget {
  return {
    spentUsd: 0,
    reservedUsd: 0,
    queries: 0,
    calls: {},
    global: null,
  };
}

export function isOpenJob(job: Job): boolean {
  return job.state === 'queued' || job.state === 'running';
}

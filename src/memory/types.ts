import { z } from 'zod';

export const ProjectId = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
export const ProjectInput = z.strictObject({
  name: z.string().trim().min(1).max(100),
});
export const LessonInput = z.strictObject({
  sourceInputId: z.string().min(1).max(150),
  quote: z.string().trim().min(1).max(4000),
  text: z.string().trim().min(1).max(1500),
  terms: z.array(z.string().trim().min(2).max(60)).min(1).max(8),
  confirmed: z.literal(true),
});
export const LessonEdit = z.strictObject({
  text: z.string().trim().min(1).max(1500),
  terms: z.array(z.string().trim().min(2).max(60)).min(1).max(8),
  expectedVersion: z.number().int().positive(),
  acknowledgeRedaction: z.literal(true),
});
export type LessonDraft = z.infer<typeof LessonInput>;
export type ProjectSpace = {
  id: string;
  name: string;
  memoryEnabled: boolean;
  upgradeStatus?: string;
};
export type SharedLesson = {
  id: string;
  sourceProjectId: string;
  sourceProjectName: string;
  sourceInputId: string;
  quote: string;
  text: string;
  terms: string[];
  version: number;
};
export type LessonUse = {
  callId: string;
  sessionId: string;
};

export class MemoryError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { LessonEdit, LessonInput, MemoryError, ProjectId, ProjectInput } from '../memory/types.js';
import type { ProjectMemoryStore } from '../memory/store.js';
import type { ServerConfig } from './config.js';

type Ports = {
  memory: ProjectMemoryStore;
  invalidate: (projectIds: string[]) => void;
};
const projectParams = z.strictObject({ projectId: ProjectId });
const lessonParams = z.strictObject({ lessonId: z.string().uuid() });
const removal = z.strictObject({
  expectedVersion: z.number().int().positive(),
  acknowledgeRedaction: z.literal(true),
});

export async function registerProjectRoutes(app: FastifyInstance, config: ServerConfig, ports: Ports) {
  await app.register(async api => {
    api.addHook('preValidation', async (request, reply) => {
      const cookie = request.cookies.sidethought;
      if (!cookie || request.unsignCookie(cookie).value !== 'authenticated') return reply.code(401).send();
      const origin = request.headers.origin;
      if ((request.method !== 'GET' && !origin) || (origin && !config.allowedOrigins.includes(origin))) {
        return reply.code(403).send();
      }
    });
    api.setErrorHandler((error, _request, reply) => {
      if (error instanceof MemoryError) return reply.code(error.status).send({ error: error.message });
      if (error instanceof z.ZodError) return reply.code(400).send({ error: 'Invalid project or lesson data' });
      // Do not expose SQL, provider, or filesystem diagnostics.
      return reply.code(500).send({ error: 'Project operation failed' });
    });
    api.get('/projects', async () => ({ projects: ports.memory.projects(), model: config.model }));
    api.post('/projects', async request => {
      const { name } = ProjectInput.parse(request.body);
      return { project: ports.memory.createProject(name) };
    });
    api.put('/projects/:projectId/memory', async request => {
      const { projectId } = projectParams.parse(request.params);
      const { enabled } = z.strictObject({ enabled: z.boolean() }).parse(request.body);
      return { project: ports.memory.setEnabled(projectId, enabled) };
    });
    api.get('/lessons', async () => ({ lessons: ports.memory.lessons() }));
    api.get('/projects/:projectId/inputs', async request => {
      const { projectId } = projectParams.parse(request.params);
      return { inputs: ports.memory.inputs(projectId).slice(-30)
        .map(input => ({ id: input.id, text: input.text.slice(0, 4000) })) };
    });
    api.get('/projects/:projectId/input-status', async request => {
      const { projectId } = projectParams.parse(request.params);
      const inputs = ports.memory.inputs(projectId);
      return {
        pending: inputs.filter(input => ['waiting', 'inflight'].includes(input.status)).length,
        failedCount: inputs.filter(input => input.status === 'needs_retry').length,
        needsRetry: inputs.filter(input => input.status === 'needs_retry').slice(0, 10)
          .map(input => ({ id: input.id, preview: input.text.slice(0, 120) })),
      };
    });
    api.get('/projects/:projectId/lesson-uses', async request => {
      const { projectId } = projectParams.parse(request.params);
      return { uses: ports.memory.recentUses(projectId) };
    });
    api.post('/projects/:projectId/lessons', async request => {
      const { projectId } = projectParams.parse(request.params);
      return { lesson: ports.memory.createLesson(projectId, LessonInput.parse(request.body)) };
    });
    api.put('/lessons/:lessonId', async request => {
      const { lessonId } = lessonParams.parse(request.params);
      const result = ports.memory.changeLesson(lessonId, LessonEdit.parse(request.body));
      ports.invalidate(result.affected);
      return { ...result, storageCleanupPending: ports.memory.storageCleanupPending };
    });
    api.delete('/lessons/:lessonId', async request => {
      const { lessonId } = lessonParams.parse(request.params);
      const { expectedVersion } = removal.parse(request.body);
      const affected = ports.memory.removeLesson(lessonId, expectedVersion);
      ports.invalidate(affected);
      return { affected, storageCleanupPending: ports.memory.storageCleanupPending };
    });
    api.post('/projects/:projectId/lesson-matches', async request => {
      const { projectId } = projectParams.parse(request.params);
      const { query } = z.strictObject({ query: z.string().max(4000) }).parse(request.body);
      return { lessons: ports.memory.retrieve(projectId, query) };
    });
  }, { prefix: '/api' });
}

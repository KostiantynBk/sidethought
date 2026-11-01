import type { FastifyInstance } from 'fastify';

export async function closeWebSockets(this: FastifyInstance): Promise<void> {
  const server = this.websocketServer;
  // Wait for ws close listeners before SQLite closes. A silent peer cannot hold shutdown open.
  const deadline = setTimeout(() => {
    for (const socket of server.clients) socket.terminate();
  }, 500);
  deadline.unref();
  try {
    await new Promise<void>((resolve, reject) => {
      // Stop accepting upgrades first; the callback runs after the tracked clients have closed.
      server.close(error => error ? reject(error) : resolve());
      for (const socket of server.clients) socket.close(1001, 'server shutting down');
    });
  } finally {
    clearTimeout(deadline);
  }
}

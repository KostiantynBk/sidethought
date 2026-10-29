import { serverConfig } from './config.js';
import { createRuntime } from './runtime.js';

async function main(): Promise<void> {
  const config = serverConfig(process.env);
  const runtime = await createRuntime(config);
  await runtime.app.listen({ host: '127.0.0.1', port: config.port });
  console.log(config.model === 'dev' ? 'dev model: no real AI' : 'meta model: Spark');
  const stop = () => {
    void runtime.close();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'unknown error';
  console.error(`server startup failed: ${message}`);
  process.exitCode = 1;
});

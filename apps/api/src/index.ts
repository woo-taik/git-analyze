import { loadConfig } from '@git-analyze/config';
import { buildApp } from './app.js';

async function main() {
  const config = loadConfig();
  const app = await buildApp(config);
  app.enableShutdownHooks();
  await app.listen(config.port, config.host);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'API startup failed');
  process.exitCode = 1;
});

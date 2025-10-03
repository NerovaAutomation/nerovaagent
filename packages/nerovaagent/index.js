import { createClient } from './lib/runtime.js';

const client = createClient();

export async function start() {
  await client.ensureServer();
  return client.config;
}

export { client };

if (import.meta.main) {
  start().then((config) => {
    console.log(`[nerovaagent] runtime listening on ${config.origin}`);
  }).catch((err) => {
    console.error('[nerovaagent] failed to start runtime', err);
    process.exit(1);
  });
}

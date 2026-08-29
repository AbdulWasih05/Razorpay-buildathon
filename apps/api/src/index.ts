import process from 'node:process';
import { loadRootEnv } from './env.js';
import { buildServer } from './server.js';

loadRootEnv();

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '0.0.0.0';

const app = buildServer({ logger: true });

app
  .listen({ port: PORT, host: HOST })
  .then(() => console.log(`praman api listening on http://localhost:${PORT}`))
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });

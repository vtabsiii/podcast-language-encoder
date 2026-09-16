import { writeFileSync } from 'node:fs';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const app = await buildApp({
  config: loadConfig({ ...process.env, NODE_ENV: 'test' }),
  logger: false,
});
await app.ready();
writeFileSync('openapi.json', JSON.stringify(app.swagger(), null, 2) + '\n');
await app.close();
console.log('wrote openapi.json');

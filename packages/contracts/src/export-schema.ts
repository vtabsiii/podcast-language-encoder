/**
 * Emits JSON Schema for the contracts consumed by the Python media worker.
 * Run via `pnpm --filter @polycast/contracts build`; output is committed under schema/.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { ErrorEnvelopeSchema } from './errors.js';
import { DomainEventSchema } from './events.js';
import { MediaMetadataSchema, WorkerTaskSchema } from './media.js';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'schema');
mkdirSync(outDir, { recursive: true });

const targets = {
  'error-envelope': ErrorEnvelopeSchema,
  'domain-event': DomainEventSchema,
  'media-metadata': MediaMetadataSchema,
  'worker-task': WorkerTaskSchema,
} as const;

for (const [name, schema] of Object.entries(targets)) {
  const json = zodToJsonSchema(schema, { name, $refStrategy: 'none' });
  writeFileSync(join(outDir, `${name}.schema.json`), JSON.stringify(json, null, 2) + '\n');
}

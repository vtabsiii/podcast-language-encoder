/**
 * Emits JSON Schema for the contracts consumed by the Python media worker.
 * Run via `pnpm --filter @polycast/contracts build`; output is committed under schema/.
 */
import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { ErrorEnvelopeSchema } from './errors.js';
import { DomainEventSchema } from './events.js';
import { MediaMetadataSchema } from './media.js';
import { ProvenanceManifestSchema, QcReportSchema } from './provenance.js';
import {
  AnalyzingOutputSchema,
  AnalyzingParamsSchema,
  EncodingOutputSchema,
  LipSyncOutputSchema,
  MixingOutputSchema,
  PackagingOutputSchema,
  SynthesizingOutputSchema,
  TargetParamsSchema,
  TargetQaOutputSchema,
  TaskResultSchema,
  TimingOutputSchema,
  TranslatingOutputSchema,
  ValidatingOutputSchema,
  ValidatingParamsSchema,
  WorkerTaskSchema,
} from './worker.js';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'schema');
mkdirSync(outDir, { recursive: true });
for (const f of readdirSync(outDir)) if (f.endsWith('.schema.json')) unlinkSync(join(outDir, f));

const targets = {
  'error-envelope': ErrorEnvelopeSchema,
  'domain-event': DomainEventSchema,
  'media-metadata': MediaMetadataSchema,
  'provenance-manifest': ProvenanceManifestSchema,
  'qc-report': QcReportSchema,
  'worker-task': WorkerTaskSchema,
  'task-result': TaskResultSchema,
  'params-validating': ValidatingParamsSchema,
  'params-analyzing': AnalyzingParamsSchema,
  'params-target': TargetParamsSchema,
  'output-validating': ValidatingOutputSchema,
  'output-analyzing': AnalyzingOutputSchema,
  'output-translating': TranslatingOutputSchema,
  'output-synthesizing': SynthesizingOutputSchema,
  'output-timing': TimingOutputSchema,
  'output-lipsync': LipSyncOutputSchema,
  'output-mixing': MixingOutputSchema,
  'output-encoding': EncodingOutputSchema,
  'output-target-qa': TargetQaOutputSchema,
  'output-packaging': PackagingOutputSchema,
} as const;

for (const [name, schema] of Object.entries(targets)) {
  const json = zodToJsonSchema(schema, { name, $refStrategy: 'none' });
  writeFileSync(join(outDir, `${name}.schema.json`), JSON.stringify(json, null, 2) + '\n');
}

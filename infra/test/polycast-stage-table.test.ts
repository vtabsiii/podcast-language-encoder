import * as fs from 'fs';
import * as path from 'path';
import { TARGET_STAGES } from '../lib/stage-table';

/**
 * `infra` (CommonJS) cannot import the ESM API workspace, so the stage order is duplicated in
 * `lib/stage-table.ts`. This test reads `apps/api/src/orchestrator/local.ts` as text and fails
 * when `TARGET_STAGE_ORDER` there lists different stages or a different order (A-08).
 */
describe('stage table stays in sync with the API orchestrator', () => {
  const apiSource = fs.readFileSync(
    path.join(__dirname, '..', '..', 'apps', 'api', 'src', 'orchestrator', 'local.ts'),
    'utf8',
  );

  test('TARGET_STAGE_ORDER exists in apps/api/src/orchestrator/local.ts', () => {
    expect(apiSource).toMatch(/export const TARGET_STAGE_ORDER\b/);
  });

  test('every stage appears in the same order inside TARGET_STAGE_ORDER', () => {
    const start = apiSource.indexOf('TARGET_STAGE_ORDER');
    const end = apiSource.indexOf('];', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = apiSource.slice(start, end);
    const quoted = [...block.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
    expect(quoted).toEqual([...TARGET_STAGES]);
  });
});

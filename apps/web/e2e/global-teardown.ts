import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const stateFile = join(__dirname, '.tmp/state.json');

export default async function globalTeardown(): Promise<void> {
  if (!existsSync(stateFile)) return;
  const state = JSON.parse(readFileSync(stateFile, 'utf8')) as {
    apiPid?: number;
    workerPid?: number;
    storageDir?: string;
  };
  for (const pid of [state.workerPid, state.apiPid]) {
    if (!pid) continue;
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        /* already gone */
      }
    }
  }
  if (state.storageDir) rmSync(state.storageDir, { recursive: true, force: true });
  rmSync(stateFile, { force: true });
}

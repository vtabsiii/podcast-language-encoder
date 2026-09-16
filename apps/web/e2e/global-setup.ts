import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { API_PORT } from '../playwright.config';

const root = resolve(__dirname, '../../..');
const apiDir = join(root, 'apps/api');
const workerDir = join(root, 'services/media-worker');
const stateFile = join(__dirname, '.tmp/state.json');

async function waitFor(url: string, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`timed out waiting for ${url}`);
}

function detached(
  cmd: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  log: string,
): ChildProcess {
  // Logs stream to e2e/.tmp/*.log for the whole run so a failed test can be diagnosed.
  const out = createWriteStream(log, { flags: 'w' });
  const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  child.stdout?.pipe(out);
  child.stderr?.pipe(out);
  return child;
}

/** A 12 s WAV (pure Node) or, when ffmpeg is available, a 10-minute test video (spec §16 DoD 2). */
async function makeFixture(dir: string): Promise<string> {
  const mp4 = join(dir, 'fixture-episode.mp4');
  const ffmpeg = await new Promise<boolean>((r) => {
    const p = spawn('ffmpeg', ['-version']);
    p.on('error', () => r(false));
    p.on('exit', (code) => r(code === 0));
  });
  if (ffmpeg && !process.env['E2E_SHORT_FIXTURE']) {
    await new Promise<void>((done, fail) => {
      const p = spawn('ffmpeg', [
        '-y',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc=size=320x240:rate=12',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:sample_rate=16000',
        '-t',
        '600',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '48k',
        '-shortest',
        mp4,
      ]);
      p.on('error', fail);
      p.on('exit', (code) => (code === 0 ? done() : fail(new Error(`ffmpeg exited ${code}`))));
    });
    return mp4;
  }
  const wav = join(dir, 'fixture-episode.wav');
  const rate = 16_000;
  const frames = rate * 12;
  const data = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++)
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 12_000), i * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  writeFileSync(wav, Buffer.concat([header, data]));
  return wav;
}

export default async function globalSetup(): Promise<void> {
  mkdirSync(join(__dirname, '.tmp'), { recursive: true });
  const storageDir = await mkdtemp(join(tmpdir(), 'polycast-e2e-'));
  const fixture = await makeFixture(join(__dirname, '.tmp'));
  const apiUrl = `http://127.0.0.1:${API_PORT}`;
  const env = {
    ...process.env,
    NODE_ENV: 'development',
    PORT: String(API_PORT),
    HOST: '127.0.0.1',
    PUBLIC_API_URL: apiUrl,
    CORS_ORIGINS: 'http://127.0.0.1:3100,http://localhost:3100',
    DATABASE_URL:
      process.env['DATABASE_URL'] ?? 'postgres://polycast:polycast@127.0.0.1:5432/polycast',
    DATABASE_APP_URL:
      process.env['DATABASE_APP_URL'] ??
      'postgres://polycast_app:polycast_app@127.0.0.1:5432/polycast',
    POLYCAST_RESET_SCHEMA: '1',
    STORAGE_DRIVER: 'local',
    LOCAL_STORAGE_DIR: storageDir,
    WORKER_TOKEN: 'e2e-worker-token',
    TASK_MAX_ATTEMPTS: '2',
  };
  const tsx = join(apiDir, 'node_modules/.bin/tsx');
  const api = detached(tsx, ['src/server.ts'], apiDir, env, join(__dirname, '.tmp/api.log'));
  await waitFor(`${apiUrl}/healthz`, 60_000);

  const python = process.env['WORKER_PYTHON'] ?? join(workerDir, '.venv/bin/python');
  if (!existsSync(python))
    throw new Error(
      `media worker python not found at ${python}; run pip install -e ".[dev]" in services/media-worker`,
    );
  const worker = detached(
    python,
    [
      '-m',
      'polycast_worker',
      '--api-url',
      apiUrl,
      '--poll-interval',
      '0.5',
      '--worker-id',
      'e2e-worker',
    ],
    workerDir,
    {
      ...process.env,
      WORKER_TOKEN: 'e2e-worker-token',
      STORAGE_DRIVER: 'local',
      LOCAL_STORAGE_DIR: storageDir,
      POLYCAST_ENV: 'test',
    },
    join(__dirname, '.tmp/worker.log'),
  );
  writeFileSync(
    stateFile,
    JSON.stringify({ apiPid: api.pid, workerPid: worker.pid, fixture, storageDir, apiUrl }),
  );
  process.env['E2E_FIXTURE'] = fixture;
  process.env['E2E_API_URL'] = apiUrl;
}

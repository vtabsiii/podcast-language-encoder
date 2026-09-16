import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { WorkerTask } from '@polycast/contracts';

/**
 * Drives the internal worker protocol from tests with fixture outputs shaped exactly like the
 * Python worker's (see services/media-worker). Lets the API suite exercise the orchestrator
 * end to end without ffmpeg or Python.
 */
export class SimulatedWorker {
  readonly processed: WorkerTask[] = [];
  constructor(
    private readonly app: FastifyInstance,
    private readonly token: string,
    private readonly opts: {
      failStage?: WorkerTask['stage'];
      failRetryable?: boolean;
      failTimes?: number;
    } = {},
  ) {}

  private failures = 0;

  async claim(): Promise<WorkerTask | null> {
    const res = await this.app.inject({
      method: 'POST',
      url: '/internal/v1/tasks/claim',
      headers: { 'x-worker-token': this.token },
      payload: { workerId: 'sim-1' },
    });
    if (res.statusCode === 204) return null;
    if (res.statusCode !== 200) throw new Error(`claim failed ${res.statusCode} ${res.body}`);
    return res.json() as WorkerTask;
  }

  async post(
    task: WorkerTask,
    body: unknown,
  ): Promise<{ accepted: boolean; nextState: string | null }> {
    const res = await this.app.inject({
      method: 'POST',
      url: `/internal/v1/tasks/${task.taskId}/result`,
      headers: { 'x-worker-token': this.token },
      payload: body,
    });
    if (res.statusCode !== 200) throw new Error(`result failed ${res.statusCode} ${res.body}`);
    return res.json() as { accepted: boolean; nextState: string | null };
  }

  /** Process every runnable task until the queue is empty. Returns stages processed. */
  async drain(max = 50): Promise<string[]> {
    const stages: string[] = [];
    for (let i = 0; i < max; i++) {
      const task = await this.claim();
      if (!task) break;
      this.processed.push(task);
      stages.push(task.stage);
      if (this.opts.failStage === task.stage && this.failures < (this.opts.failTimes ?? 1)) {
        this.failures += 1;
        await this.post(task, {
          status: 'failed',
          retryable: this.opts.failRetryable ?? true,
          error: { code: 'PROVIDER_TIMEOUT', message: 'simulated failure' },
          output: null,
          workerId: 'sim-1',
        });
        continue;
      }
      await this.post(task, {
        status: 'succeeded',
        output: fixtureOutput(task),
        workerId: 'sim-1',
      });
    }
    return stages;
  }
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export function fixtureOutput(task: WorkerTask): Record<string, unknown> {
  const p = task.parameters as Record<string, unknown>;
  const derived = task.storage.derivedPrefix;
  switch (task.stage) {
    case 'VALIDATING':
      return {
        metadata: {
          container: 'wav',
          durationUs: 12_000_000,
          audio: { codec: 'pcm_s16le', sampleRate: 16000, channels: 1, channelLayout: 'mono' },
        },
        sha256: sha('source'),
        byteSize: p['declaredByteSize'],
        source: task.storage.source,
      };
    case 'ANALYZING': {
      const seg = (i: number, key: string, text: string) => ({
        seq: i,
        speakerKey: key,
        range: { start: i * 4_000_000, end: i * 4_000_000 + 3_700_000 },
        text,
        language: 'en',
        confidence: 0.9,
        words: text
          .split(' ')
          .map((w, j) => ({
            text: w,
            range: { start: i * 4_000_000 + j * 300_000, end: i * 4_000_000 + (j + 1) * 300_000 },
            confidence: 0.9,
          }))
          .slice(0, 12)
          .map((w) => w),
      });
      return {
        detectedLocale: (p['declaredLocale'] as string | null) ?? 'en-US',
        detectionConfidence: 0.93,
        provider: 'mock-transcription',
        providerVersion: '0',
        hasVideo: false,
        proxy: `${derived}proxy.mp3`,
        waveform: `${derived}waveform.json`,
        speakers: [
          { key: 'A', label: 'Speaker A', onCamera: false, voicePolicy: 'stock', sampleRanges: [] },
          { key: 'B', label: 'Speaker B', onCamera: false, voicePolicy: 'stock', sampleRanges: [] },
        ],
        segments: [
          seg(0, 'A', 'Welcome back to the show'),
          seg(1, 'B', 'Today we talk about microphones'),
          seg(2, 'A', 'Thanks for listening'),
        ],
      };
    }
    case 'TRANSLATING': {
      const segments = p['segments'] as {
        id: string;
        text: string;
        range: { start: number; end: number };
      }[];
      const translations = p['translations'] as { segmentId: string; generation: number }[];
      const locale = p['targetLocale'] as string;
      return {
        provider: 'mock-translation',
        providerVersion: '0',
        promptVersion: 'mock-v1',
        translations: segments.map((s) => {
          const prev = translations.find((t) => t.segmentId === s.id);
          return {
            segmentId: s.id,
            adaptedText: prev
              ? `[${locale} v${prev.generation + 1}] ${s.text}`
              : `[${locale}] ${s.text}`,
            literalText: null,
            confidence: 0.8,
            timingBudgetUs: s.range.end - s.range.start,
          };
        }),
      };
    }
    case 'SYNTHESIZING': {
      const translations = p['translations'] as {
        translationVersionId: string;
        segmentId: string;
        adaptedText: string;
      }[];
      return {
        provider: 'mock-speech',
        providerVersion: '0',
        renders: translations.map((t) => ({
          segmentId: t.segmentId,
          translationVersionId: t.translationVersionId,
          voiceId: `mock-${p['targetLocale']}-1`,
          measuredDurationUs: t.adaptedText.split(' ').length * 400_000,
          audio: null,
        })),
      };
    }
    case 'TIMING': {
      const speech = p['speech'] as { segmentId: string }[];
      return {
        fits: speech.map((s) => ({
          segmentId: s.segmentId,
          strategy: 'rate',
          timeStretchRatio: 1.05,
          boundaryShiftUs: 0,
          fits: true,
        })),
      };
    }
    case 'LIP_SYNCING': {
      const segments = p['segments'] as { id: string }[];
      return {
        provider: 'mock-lipSync',
        providerVersion: '0',
        applied: false,
        renders: segments.map((s) => ({ segmentId: s.id, syncConfidence: 0, video: null })),
      };
    }
    case 'MIXING':
      return { mix: `${derived}mix.wav`, integratedLufs: -16.2, truePeakDbtp: -1.4 };
    case 'ENCODING':
      return { encode: `${derived}encode.mp3`, container: 'mp3', byteSize: 1234 };
    case 'TARGET_QA': {
      const segments = p['segments'] as {
        id: string;
        seq: number;
        range: { start: number; end: number };
      }[];
      const translations = p['translations'] as { segmentId: string; generation: number }[];
      const first = [...segments].sort((a, b) => a.seq - b.seq)[0];
      const gen = first ? (translations.find((t) => t.segmentId === first.id)?.generation ?? 1) : 1;
      const flag = first !== undefined && gen === 1;
      return {
        provider: 'mock-quality',
        checks: [
          { metric: 'dialogue-coverage', threshold: 300, value: 0, passed: true },
          { metric: 'loudness-integrated', threshold: -16, value: -16.2, passed: true },
          { metric: 'true-peak', threshold: -1, value: -1.4, passed: true },
          { metric: 'caption-timing', threshold: 100, value: 12, passed: true },
          { metric: 'entity-preservation', threshold: null, value: null, passed: !flag },
        ],
        issues:
          flag && first
            ? [
                {
                  metric: 'entity-preservation',
                  segmentId: first.id,
                  severity: 'warning',
                  range: first.range,
                  recommendation:
                    'Named entities may have been altered; regenerate the translation or accept.',
                },
              ]
            : [],
      };
    }
    case 'PACKAGING': {
      const prefix = task.storage.deliverablesPrefix as string;
      const locale = p['targetLocale'] as string;
      const prov = p['provenance'] as { translationVersionIds: string[] };
      const files = [
        { kind: 'media', fileName: `episode.${locale}.mp3`, contentType: 'audio/mpeg' },
        {
          kind: 'captions-srt',
          fileName: `captions.${locale}.srt`,
          contentType: 'application/x-subrip',
        },
        { kind: 'captions-vtt', fileName: `captions.${locale}.vtt`, contentType: 'text/vtt' },
        {
          kind: 'transcript-json',
          fileName: `transcript.${locale}.json`,
          contentType: 'application/json',
        },
        { kind: 'qc-report', fileName: 'qc-report.json', contentType: 'application/json' },
        {
          kind: 'provenance-manifest',
          fileName: 'provenance.json',
          contentType: 'application/json',
        },
        { kind: 'checksums', fileName: 'checksums.sha256', contentType: 'text/plain' },
      ].map((f) => ({
        ...f,
        byteSize: 100,
        sha256: sha(f.fileName),
        uri: `${prefix}${f.fileName}`,
      }));
      return {
        deliverables: files,
        manifest: {
          schemaVersion: 1,
          generator: 'simulated-worker',
          generatedAt: new Date().toISOString(),
          jobId: p['jobId'],
          targetJobId: p['targetJobId'],
          projectId: p['projectId'],
          sourceLocale: p['sourceLocale'],
          targetLocale: locale,
          sourceSha256: p['sourceSha256'],
          syntheticVoice: false,
          lipSyncApplied: false,
          mock: true,
          models: [
            {
              capability: 'translation',
              adapterId: 'mock-translation',
              version: '0',
              tier: 'unavailable',
              dataPolicy: 'no-training',
            },
          ],
          segmentCount: (p['segments'] as unknown[]).length,
          translationVersionIds: prov.translationVersionIds,
          files: files
            .filter((f) => f.kind !== 'provenance-manifest')
            .map((f) => ({ fileName: f.fileName, sha256: f.sha256, byteSize: f.byteSize })),
          disclosure:
            'Generated with mock providers: audio is the untranslated source; captions are pseudo-translations.',
        },
      };
    }
    default:
      throw new Error(`no fixture for ${task.stage}`);
  }
}

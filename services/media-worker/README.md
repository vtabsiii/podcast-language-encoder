# media-worker

Python worker for the media plane (`polycast_worker`). See `../../docs/architecture.md` §4–§7.

The worker never holds a database connection. It claims tasks from the API's internal
endpoints, does the work against object storage, and posts a typed result:

| Endpoint | Purpose |
|---|---|
| `POST {API}/internal/v1/tasks/claim` | body `{"workerId","stages"?}` → `200` WorkerTask JSON or `204` when nothing is queued |
| `POST {API}/internal/v1/tasks/{taskId}/heartbeat` | lease renewal, sent every `leaseSeconds / 3` while a task runs |
| `POST {API}/internal/v1/tasks/{taskId}/result` | TaskResult `{status, retryable, error, output, workerId}` |

Every request carries `X-Worker-Token`. Task, parameter and output shapes are the Zod
schemas in `packages/contracts/src/worker.ts` (exported as JSON Schema under
`packages/contracts/schema/`); `polycast_worker/models.py` mirrors them and the tests
validate every model against the schema files.

## Run

```bash
python -m venv .venv && . .venv/bin/activate
pip install -e ".[dev]"
ruff check . && mypy polycast_worker && pytest -q        # or: pnpm --filter @polycast/media-worker test:py

python -m polycast_worker --api-url http://127.0.0.1:4000            # poll forever
python -m polycast_worker --api-url http://127.0.0.1:4000 --once     # drain the queue, exit 0
# options: --poll-interval S (default 2) --worker-id ID (default host-pid) --verbose
```

`pnpm --filter @polycast/media-worker dev` runs the loop against `API_BASE_URL`
(default `http://127.0.0.1:4000`).

`ffmpeg`/`ffprobe` are used when present (`Tools.detect()`); without them the worker still
handles PCM WAV sources through the stdlib `wave` module so the M1 slice runs on a bare
CI image. Non-WAV sources without ffmpeg fail with a retryable `TOOL_UNAVAILABLE`.

## Environment

| Variable | Default | Notes |
|---|---|---|
| `POLYCAST_ENV` | `development` | `production` fails closed (see below) |
| `API_BASE_URL` | `http://127.0.0.1:4000` | default for `--api-url` |
| `WORKER_TOKEN` | `dev-worker-token` | shared secret for `X-Worker-Token`; required and must not be the default in production |
| `STORAGE_DRIVER` | `local` | `local` or `s3` |
| `LOCAL_STORAGE_DIR` | `.polycast-data/storage` | root for `local://bucket/key` → `{dir}/{bucket}/{key}`; same directory the API uses |
| `S3_ENDPOINT` | – | MinIO endpoint for docker compose; unset for AWS |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | – | static credentials for MinIO; omit to use the default AWS chain |
| `AWS_REGION` | `us-east-1` | |
| `PROVIDER_MODE` | `local` | must be `aws` in production |
| `WORKER_QUEUE_URL`, `MEDIA_BUCKET_SOURCE` | – | required in production |

Production (`POLYCAST_ENV=production`) refuses to start unless `PROVIDER_MODE=aws`,
`STORAGE_DRIVER=s3`, a non-default `WORKER_TOKEN`, `WORKER_QUEUE_URL` and
`MEDIA_BUCKET_SOURCE` are all set (`config.py`).

## Stages

Handlers live in `polycast_worker/stages/<stage>.py`; each is
`run(task, storage, tools) -> dict` and its output is validated against
`output-<stage>.schema.json` before it is posted. All ML/cloud capabilities are behind the
Protocols in `polycast_worker/providers`; the only adapters in M1 are `providers/mock.py`,
which register as tier `unavailable`.

| Stage | Params | Reads | Writes | Output / behaviour |
|---|---|---|---|---|
| `VALIDATING` | `params-validating` | quarantine object | `storage.source` (immutable copy) | probe (ffprobe, or `wave` for RIFF/WAVE); rejects with terminal `SIZE_MISMATCH`, `UNSUPPORTED_CONTAINER`, `NO_AUDIO_STREAM`, `DURATION_EXCEEDED`, `MALFORMED_MEDIA` |
| `ANALYZING` | `params-analyzing` | source | `{derivedPrefix}proxy.mp3` (64 kbps mono; `proxy.wav` without ffmpeg), `{derivedPrefix}waveform.json` (`{version:1, peaksPerSecond:50, durationUs, peaks[]}`) | mock fixture: `detectedLocale` = declared or `en-US` (0.93), speakers `A`/`B`, deterministic 3–7 s segments per `assetId` with 300 ms gaps |
| `TRANSLATING` | `params-target` | – | – | `MockTranslationProvider`: `[{locale}] text` or `[{locale} vN] text` on regeneration; a hint containing `shorter` drops the last word |
| `SYNTHESIZING` | `params-target` | – | – | `MockSpeechProvider`: `measuredDurationUs = words × 400 ms`, voice `mock-{locale}-1`, no audio |
| `TIMING` | `params-target` | – | – | ratio = measured / budget: `< 0.88` → `none`; `0.88–1.12` → `rate`; else boundary shift ≤ 120 ms, otherwise `retranslate` (fits = false) |
| `LIP_SYNCING` | `params-target` | – | – | mock, `applied: false`, confidence 0.0 (queued only for video with lip sync on) |
| `MIXING` | `params-target` | source | `{derivedPrefix}mix.wav` | stereo 48 kHz `loudnorm=I=-16:TP=-1`, measured with `ebur128`; fixture `-16 / -1` without ffmpeg. Mock renders carry no audio, so the mix is the untranslated source |
| `ENCODING` | `params-target` | source, `mix.wav` | `{derivedPrefix}encode.mp4` (video copied, AAC 128k) or `encode.mp3` (128k); source bytes without ffmpeg | `{encode, container, byteSize}` |
| `TARGET_QA` | `params-target` | `mix.wav` (loudness) | – | `MockQualityProvider` checks `dialogue-coverage`, `loudness-integrated`, `true-peak`, `caption-timing`, `entity-preservation`; flags exactly one `entity-preservation` warning while the lowest-seq segment's translation is generation 1, none once regenerated |
| `PACKAGING` | `params-target` (+ `packageVersion`, `provenance`) | `encode.*` | `episode.{locale}.{mp4,mp3}`, `captions.{locale}.srt/.vtt`, `transcript.{locale}.json`, `qc-report.json`, `provenance.json`, `checksums.sha256` under `deliverablesPrefix` | `PackagingOutput` with sha256/byteSize per file and the `ProvenanceManifest` (`mock: true`, tier `unavailable`) |

The API mints a per-stage `derivedPrefix` (`…/targets/{id}/{stage}/`). A stage that needs an
earlier artefact (`ENCODING` and `TARGET_QA` → `mix.wav`, `PACKAGING` → `encode.*`) looks
under its own prefix first and then under the sibling stage's prefix
(`stages/common.py::find_artifact`). `checksums.sha256` covers every other deliverable
including `provenance.json`; the manifest's `files` therefore lists everything except
`provenance.json` and `checksums.sha256` (the two cannot hash each other).

Failures inside a handler become a failed `TaskResult`; `retryable` is only set for
transient I/O (`STORAGE_IO`, `TRANSIENT_IO`, `TOOL_UNAVAILABLE`). Contract and validation
problems are terminal. One bad task never stops the loop.

## Logging

Log lines carry ids, stages, codes and durations only. `logsafe.RedactingFilter` drops any
record whose message contains a forbidden key (`transcript`, `adaptedText`, `hint`,
`signedUrl`, `X-Amz-`, `token`, …); `tests/test_logsafe.py` and the end-to-end test assert
this (A-17).

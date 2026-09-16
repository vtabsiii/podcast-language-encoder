# media-worker

Python worker for the media plane (`polycast_worker`). See `../../docs/architecture.md` §4–§7.

The worker never holds a database connection. It claims tasks from the API's internal
endpoints, does the work against object storage, and posts a typed result:

| Endpoint | Purpose |
|---|---|
| `POST {API}/internal/v1/tasks/claim` | body `{"workerId","stages"?}` → `200` WorkerTask JSON or `204` when nothing is queued |
| `POST {API}/internal/v1/tasks/{taskId}/heartbeat` | lease renewal, sent every `leaseSeconds / 3` while a task runs, and on every provider poll |
| `POST {API}/internal/v1/tasks/{taskId}/result` | TaskResult `{status, retryable, error, output, workerId}` |

Every request carries `X-Worker-Token`. Task, parameter and output shapes are the Zod
schemas in `packages/contracts/src/worker.ts` (exported as JSON Schema under
`packages/contracts/schema/`); `polycast_worker/models.py` mirrors them and the tests
validate every model against the schema files.

## Run

```bash
python -m venv .venv && . .venv/bin/activate
pip install -e ".[dev]"
ruff check . && ruff format --check . && mypy polycast_worker && pytest -q
# or: pnpm --filter @polycast/media-worker test:py

python -m polycast_worker --api-url http://127.0.0.1:4000            # poll forever
python -m polycast_worker --api-url http://127.0.0.1:4000 --once     # drain the queue, exit 0
# options: --poll-interval S (default 2) --worker-id ID (default host-pid) --verbose

python -m polycast_worker.notify --kind ready --to reviewer@example.test --ref <targetJobId>
```

`pnpm --filter @polycast/media-worker dev` runs the loop against `API_BASE_URL`
(default `http://127.0.0.1:4000`).

`ffmpeg`/`ffprobe` are used when present (`Tools.detect()`); without them the worker still
handles PCM WAV sources through the stdlib `wave` module so the M1 slice runs on a bare
CI image. Non-WAV sources without ffmpeg fail with a retryable `TOOL_UNAVAILABLE`. In aws
mode ffmpeg is required for TIMING (atempo) and MIXING (remix + loudnorm).

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
| `AWS_REGION` | `us-east-1` | region for every boto3 client |
| `PROVIDER_MODE` | `local` | `local` (mock adapters) or `aws` (adapters below); must be `aws` in production |
| `WORKER_QUEUE_URL`, `MEDIA_BUCKET_SOURCE` | – | required in production |
| `MEDIA_BUCKET_DERIVED` | `derived` | bucket for the in-app notification list (`notifications.json`) |

### `PROVIDER_MODE=aws`

| Variable | Default | Notes |
|---|---|---|
| `TRANSLATION_PROVIDER` | `translate` | `translate` (Amazon Translate) or `bedrock` (LLM adapter) |
| `BEDROCK_MODEL_ID` | `anthropic.claude-3-5-haiku-20241022-v1:0` | model for the `bedrock` translation adapter (`converse`) |
| `TRANSLATE_TERMINOLOGY_NAME` | – | Amazon Translate custom terminology passed as `TerminologyNames` (glossary hook) |
| `POLLY_ENGINE` | `neural` | `neural`, `long-form` or `generative` |
| `ENCODE_PROVIDER` | `ffmpeg` | `ffmpeg` (in-worker) or `mediaconvert` |
| `MEDIACONVERT_ROLE_ARN`, `MEDIACONVERT_QUEUE_ARN` | – | required when `ENCODE_PROVIDER=mediaconvert` |
| `SES_FROM_ADDRESS` | – | verified SES sender; required in production. Without it notifications fall back to the in-app list |
| `TRANSCRIBE_DATA_ACCESS_ROLE_ARN` | – | optional `JobExecutionSettings.DataAccessRoleArn` for Transcribe |

Production (`POLYCAST_ENV=production`) refuses to start unless `PROVIDER_MODE=aws`,
`STORAGE_DRIVER=s3`, a non-default `WORKER_TOKEN`, `WORKER_QUEUE_URL`, `MEDIA_BUCKET_SOURCE`
and `SES_FROM_ADDRESS` are all set (`config.py`). Enum values are validated in every
environment, and `ENCODE_PROVIDER=mediaconvert` without both ARNs is rejected.

Status: every AWS adapter is **contract-tested against recorded responses**
(`tests/fixtures/providers/`, driven through `botocore.stub.Stubber`); none has yet been run
against live AWS from this repository. All records register at tier `beta`; promotion to
`production` happens only through `docs/quality-benchmark.md`.

## Providers

`polycast_worker/providers/registry.py::build_providers(cfg, clients=None, *, storage, tools)`
returns a `ProviderSet` (`transcription, translation, speech, lip_sync, encode, quality,
notifier, timing, mixer`). Stage handlers receive it through `StageEnv` (with the lease
heartbeat and an injectable `sleep`) and never instantiate adapters themselves. boto3 clients
are created lazily by `providers/aws/clients.py::ClientFactory`, so tests inject stubbed ones.

| Capability | local | aws | Adapter id / tier | IAM actions |
|---|---|---|---|---|
| transcription | `MockTranscriptionProvider` | `providers/aws/transcribe.py` (batch job, speaker labels, `IdentifyLanguage` or the declared locale, output under the task's derived prefix) | `aws-transcribe` / beta | `transcribe:StartTranscriptionJob`, `transcribe:GetTranscriptionJob` |
| translation | `MockTranslationProvider` | `providers/aws/translate.py` (`TranslateText`, batched ≤ 10,000 bytes, formality where supported, terminology) or `providers/aws/bedrock.py` (`Converse`, entity-preserving prompt, per-segment `maxChars` from the timing budget; `promptVersion` = `bedrock-v1:<sha256[:8]>`) | `aws-translate` / `aws-bedrock` / beta | `translate:TranslateText` (+ `translate:GetTerminology` when configured); `bedrock:InvokeModel` (Converse) |
| speech | `MockSpeechProvider` | `providers/aws/polly.py` (`SynthesizeSpeech` PCM 16 kHz + word speech marks; duration from the PCM byte length) | `aws-polly` / beta, `unavailable` for locales without a neural voice | `polly:SynthesizeSpeech`, `polly:DescribeVoices` |
| lipSync | `MockLipSyncProvider` | same mock (vendor arrives in M4) | `mock-lipSync` / unavailable | – |
| encode | `FfmpegEncodeProvider` (tier unavailable in local mode) | `FfmpegEncodeProvider` or `providers/aws/mediaconvert.py` (`CreateJob` MP4 H.264 + AAC from source video + mix, MP3 for audio-only; `GetJob` polling) | `ffmpeg-encode` / `aws-mediaconvert` / beta | `mediaconvert:CreateJob`, `mediaconvert:GetJob`, `iam:PassRole` on the MediaConvert role |
| quality | `MockQualityProvider` (M1 "flag one segment" fixture) | `providers/quality.py::InHouseQualityProvider` | `inhouse-quality` / beta | – |
| notifier | `InAppNotifier` (JSON list under the derived bucket) | `providers/aws/ses.py::SesNotifier` (`SendEmail`, plain text) | `aws-ses` | `ses:SendEmail` |
| timing | `AtempoTimingFitter` | same (arithmetic in `timing_fit.py`, ffmpeg `atempo` chain 0.5–2.0) | – | – |
| mixer | `PassthroughMixer` (M1: loudnorm of the source) | `DubMixer` (ducked bed + `adelay`/`amix`, two-pass `loudnorm`, `ebur128` check) | – | – |

Storage access in aws mode needs `s3:GetObject`, `s3:PutObject` and `s3:ListBucket`
(`HeadObject`) on the quarantine, source, derived and deliverables buckets; Transcribe writes
its job output to the derived bucket, and MediaConvert (via its role) reads source/derived and
writes the encode there.

### Locale tables (`providers/aws/locales.py`)

Every table is total over the 22 seed locales in `packages/domain/src/capabilities/registry.ts`
and a test fails if a locale is missing.

| Locale | Translate | Transcribe hint | Polly voice (neural) |
|---|---|---|---|
| en-US | en | en-US | Joanna |
| en-GB | en | en-GB | Amy |
| es-419 | es | es-US | Lupe (es-US) |
| es-MX | es-MX | es-US | Mia |
| es-ES | es | es-ES | Lucia |
| zh-CN | zh | zh-CN | Zhiyu (cmn-CN) |
| hi-IN | hi | hi-IN | Kajal |
| ar-001 | ar | ar-SA | Hala (ar-AE) |
| ar-SA | ar | ar-SA | Hala (ar-AE) |
| pt-BR | pt | pt-BR | Camila |
| pt-PT | pt-PT | pt-PT | Ines |
| fr-FR | fr | fr-FR | Lea |
| fr-CA | fr-CA | fr-CA | Gabrielle |
| de-DE | de | de-DE | Vicki |
| ja-JP | ja | ja-JP | Takumi |
| ko-KR | ko | ko-KR | Seoyeon |
| id-ID | id | id-ID | — (speech unavailable) |
| bn-IN | bn | bn-IN | — (speech unavailable) |
| bn-BD | bn | bn-IN | — (speech unavailable) |
| ur-PK | ur | ur-IN | — (speech unavailable) |
| ru-RU | ru | ru-RU | — (standard engine only; speech unavailable) |
| tr-TR | tr | tr-TR | Burcu |

Translate `Settings.Formality` is only sent for `de, es, fr, fr-CA, hi, it, ja, ko, nl, pt-PT`
(`INFORMAL` by default, `FORMAL` when the reviewer hint says so). The Bedrock adapter derives
`maxChars` per segment from `timingBudgetUs × chars/s` (`SPEAKING_RATE_CPS`, e.g. es 16,
en 15, de 14, ja 8, zh 5) and shrinks it by 20% on a "shorter" hint.

## Stages

Handlers live in `polycast_worker/stages/<stage>.py`; each is
`run(task, storage, tools, env=None) -> dict` and its output is validated against
`output-<stage>.schema.json` before it is posted. `env` is a `StageEnv` (providers + lease
hooks); when omitted the local mock set is used, which is what the M1 tests exercise.

| Stage | Params | Reads | Writes | local (mock) | aws |
|---|---|---|---|---|---|
| `VALIDATING` | `params-validating` | quarantine object | `storage.source` (immutable copy) | probe (ffprobe, or `wave` for RIFF/WAVE); rejects with terminal `SIZE_MISMATCH`, `UNSUPPORTED_CONTAINER`, `NO_AUDIO_STREAM`, `DURATION_EXCEEDED`, `MALFORMED_MEDIA` | same |
| `ANALYZING` | `params-analyzing` | source | `{derivedPrefix}proxy.mp3` (64 kbps mono; `proxy.wav` without ffmpeg), `{derivedPrefix}waveform.json`; aws: `{derivedPrefix}transcribe/<job>.json` | fixture: `detectedLocale` = declared or `en-US` (0.93), speakers `A`/`B`, deterministic 3–7 s segments per `assetId` | Transcribe job started first, proxy/waveform built while it runs, then polled every 5 s with a heartbeat per poll; words merged into ≤ 8 s segments split on ≥ 600 ms silence, `spk_N` → `A, B, …` |
| `TRANSLATING` | `params-target` | – | – | `[{locale}] text` / `[{locale} vN] text`; a hint containing `shorter` drops the last word | Translate or Bedrock; the entity check (`qc/entity_check.py`) runs once here and logs a count only |
| `SYNTHESIZING` | `params-target` | – | aws: `{derivedPrefix}speech/<segmentId>.wav` | `measuredDurationUs = words × 400 ms`, voice `mock-{locale}-1`, no audio | Polly PCM 16 kHz; `VOICE_UNAVAILABLE` (terminal) for locales without a voice |
| `TIMING` | `params-target` | `speech/<id>.wav` (SYNTHESIZING) | `{derivedPrefix}speech/<segmentId>.fit.wav` | ratio = measured / budget: `< 0.88` → `none`; `0.88–1.12` → `rate`; else boundary shift ≤ 120 ms, otherwise `retranslate` (fits = false) | same arithmetic, plus ffmpeg `atempo` applied to the render when it exists |
| `LIP_SYNCING` | `params-target` | – | – | mock, `applied: false`, confidence 0.0 | same mock until M4 |
| `MIXING` | `params-target` | source, fitted/raw speech WAVs | `{derivedPrefix}mix.wav` | stereo 48 kHz `loudnorm=I=-16:TP=-1` of the source (mock renders carry no audio); fixture `-16 / -1` without ffmpeg | speech placed at each segment start over the bed ducked to 0.15 during dialogue, two-pass `loudnorm` to −16 LUFS stereo / −19 mono, TP −1, measured with `ebur128` |
| `ENCODING` | `params-target` | source, `mix.wav` | `{derivedPrefix}encode.mp4` / `.mp3` | ffmpeg (video copied + AAC 128k, or MP3 128k); source bytes without ffmpeg | ffmpeg, or MediaConvert polled every 5 s |
| `TARGET_QA` | `params-target` | `mix.wav`, `speech/<id>.fit.wav` | – | mock: `dialogue-coverage`, `loudness-integrated`, `true-peak`, `caption-timing`, `entity-preservation`; flags exactly one `entity-preservation` warning while the lowest-seq segment's translation is generation 1 | in-house: coverage (missing translation/speech or > 300 ms overrun → critical), `boundary-drift` (> 120 ms → warning), loudness ± 1 LU, true peak ≤ −1 dBTP, `caption-timing` (≤ 2 × 42 chars), entity preservation, `frame-preservation` for video (passes: lip sync is not applied) |
| `PACKAGING` | `params-target` (+ `packageVersion`, `provenance`) | `encode.*` | `episode.{locale}.{mp4,mp3}`, `captions.{locale}.srt/.vtt`, `transcript.{locale}.json`, `qc-report.json`, `provenance.json`, `checksums.sha256` | manifest `mock: true`, tier `unavailable` | manifest `mock: false`, `syntheticVoice: true`, models = the registry's records for the target locale (all `beta`) |

The API mints a per-stage `derivedPrefix` (`…/targets/{id}/{stage}/`). A stage that needs an
earlier artefact (`ENCODING` and `TARGET_QA` → `mix.wav`, `PACKAGING` → `encode.*`,
`TIMING`/`MIXING`/`TARGET_QA` → `speech/*.wav`) looks under its own prefix first and then under
the sibling stage's prefix (`stages/common.py::find_artifact`). `checksums.sha256` covers every
other deliverable including `provenance.json`; the manifest's `files` therefore lists everything
except `provenance.json` and `checksums.sha256` (the two cannot hash each other).

Failures inside a handler become a failed `TaskResult`; `retryable` is only set for
transient I/O (`STORAGE_IO`, `TRANSIENT_IO`, `TOOL_UNAVAILABLE`) and provider throttling /
outages (`PROVIDER_THROTTLED`, `PROVIDER_UNAVAILABLE`, `PROVIDER_BAD_OUTPUT`, `PROVIDER_TIMEOUT`).
Contract and validation problems, `TRANSCRIPTION_FAILED`, `ENCODE_FAILED`, `VOICE_UNAVAILABLE`
and `PROVIDER_ERROR` are terminal. One bad task never stops the loop.

## Tests

`tests/fixtures/providers/<service>/<operation>[.<variant>].json` hold recorded-response style
fixtures (`{"service","operation","expected_params"?,"response"}`; streaming blobs are stored
as `{"__blob_base64__": …}`) plus `transcribe/output.json`, a Transcribe job output in the real
schema. `tests/aws_stubs.py` loads them into `botocore.stub.Stubber`s and provides an
in-memory `Storage` so adapters see realistic `s3://` URIs. `tests/test_aws_e2e_loop.py` drives
the whole aws-mode stage sequence through the FakeApi with those stubs and the real ffmpeg.

## Logging

Log lines carry ids, stages, codes and durations only. `logsafe.RedactingFilter` drops any
record whose message contains a forbidden key (`transcript`, `adaptedText`, `hint`,
`signedUrl`, `X-Amz-`, `token`, …); `tests/test_logsafe.py` and both end-to-end tests assert
this (A-17).

# Quality benchmark

The benchmark is the only path from `beta` to `production` for a (source, target, capability)
triple in the capability registry. It runs in M4 for the first time; until then every locale is
`beta` (assumption A-02).

## 1. Benchmark corpus requirements

| Requirement | Detail |
|---|---|
| Ownership | Licensed or produced by us; never customer content (no-training policy) |
| Size per source language | ≥ 10 episodes, ≥ 6 h total, ≥ 30 distinct speakers |
| Mix | 50% audio-only, 50% video with on-camera speakers; ≥ 3 episodes with ≥ 3 speakers; ≥ 2 with crosstalk; ≥ 2 with music beds; ≥ 1 with heavy accent |
| Video | ≥ 1080p; ≥ 20% of shots with profile angle, occlusion, or small face (<120 px) to exercise FR-033 |
| Ground truth | Human-verified transcript with word timestamps (±20 ms), diarization, named entities; human reference translation per target locale; shot boundaries; active-speaker labels per shot |
| Storage | Separate AWS account/bucket, read-only to CI; versioned as `corpus-vN` |
| Refresh | Add ≥ 2 episodes per year; retired episodes stay for regression comparability |

## 2. Metrics

| Metric | Definition | Stage |
|---|---|---|
| WER | Word error rate vs ground truth, normalized text | TRANSCRIBING |
| DER | Diarization error rate | TRANSCRIBING |
| Word timestamp MAE | Mean absolute error of word start times (µs) | TRANSCRIBING |
| Entity preservation | Share of ground-truth entities present in translation | TRANSLATING |
| Translation adequacy | COMET (reference-based) plus human rating 1–5 on a 200-segment sample | TRANSLATING |
| Duration fit | Share of segments whose rendered duration is within slot ± 120 ms before rate adjustment | TIMING |
| Rate adjustment | Share of segments needing > ±8% atempo | TIMING |
| Dialogue coverage | Missing or duplicated dialogue spans > 300 ms per hour | MIXING/QC |
| A/V offset | Median and p95 offset between mouth movement and rendered speech on lip-synced segments (SyncNet-style measure) | LIP_SYNCING |
| Sync confidence | Model confidence distribution; share below gate | LIP_SYNCING |
| Frame preservation | Share of pixels outside mouth region byte-identical to source | LIP_SYNCING |
| Loudness | Integrated LUFS and true peak per deliverable | MIXING |
| Caption timing | MAE between caption cue and rendered speech (ms) | PACKAGING |
| Naturalness (MOS) | Blind native-speaker rating 1–5 on 100 segments | SYNTHESIZING |
| Cost and latency | $ and wall-clock per source hour per target | all |

## 3. Thresholds

A triple is eligible for `production` only if every row passes on the current corpus.

| Metric | Production threshold | Beta floor (else `unavailable`) |
|---|---|---|
| WER | ≤ 8% | ≤ 20% |
| DER | ≤ 10% | ≤ 25% |
| Word timestamp MAE | ≤ 40 ms | ≤ 120 ms |
| Entity preservation | ≥ 98% | ≥ 90% |
| Translation adequacy (human) | ≥ 4.0 mean, ≤ 2% rated 1–2 | ≥ 3.3 |
| Duration fit | ≥ 85% | ≥ 60% |
| Rate adjustment > ±8% | ≤ 10% of segments | ≤ 30% |
| Dialogue coverage defects | 0 per hour | ≤ 2 per hour |
| A/V offset | median ≤ 45 ms, p95 ≤ 100 ms | median ≤ 80 ms |
| Sync confidence below gate | ≤ 10% of segments | ≤ 35% |
| Frame preservation | 100% (byte-identical) | 100% |
| Loudness | 100% of deliverables within ±1 LU, TP ≤ −1 dBTP | same |
| Caption timing MAE | ≤ 100 ms | ≤ 250 ms |
| Naturalness MOS | ≥ 3.8 | ≥ 3.0 |
| Cost | ≤ plan target per source hour | reported only |

Audio-only capability triples skip the lip-sync rows. Frame preservation has no beta floor: a
lip-sync adapter that changes pixels outside the mouth region is never enabled at any tier.

## 4. Promotion rules beta → production

1. Full benchmark run on the latest corpus version with the exact adapter version, model version
   and prompt hash pinned; results written to `ProviderCapability.benchmark` with the run id.
2. All production thresholds met; human rating panel of ≥ 3 native speakers for the target locale.
3. Data-processing descriptor complete and provider contract signed (privacy §4–5).
4. Runbook `provider-outage.md` has a tested fallback for the provider.
5. Two Admin-level engineers approve the promotion PR; the change is an `audit.recorded` event.
6. Promotion applies to one (source, target, capability) triple; sibling locales (es-MX vs es-419)
   are promoted separately.

Demotion: any release that breaks a production threshold on the regression run auto-demotes the
triple to `beta` (customers see the badge; SLA suspended) until fixed.

## 5. Regression policy

- The benchmark subset ("smoke corpus", 1 episode per source language, ~30 min) runs in CI on
  every change to `services/media-worker/**`, `packages/contracts/**`, adapter configuration or
  model pins. Must not regress any metric by more than the noise band (measured over 5 runs; stored
  with the corpus).
- The full corpus runs nightly on `main` for production triples and weekly for beta triples.
- Provider or model upgrades (including silent vendor updates detected by response version
  headers) require a full run before the new version is used for production triples; until then
  the previous pinned version stays routed.
- Results are kept 2 years and charted per triple; a sustained 3-run downward trend opens an issue
  even if thresholds still pass.
- Customer-reported defects that the benchmark missed become new corpus items (synthetic
  reproduction, never the customer's media).

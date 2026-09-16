/**
 * Step 3 of the pipeline. Given a completed Amazon Transcribe job:
 *   1. download the transcript JSON and pull out the plain text
 *   2. translate it into every TARGET_LANGUAGES entry (skipping the source language)
 *   3. write <episode>/<lang>/transcript.txt to the output bucket
 *   4. start one async Polly synthesis task per language (chunked if very long)
 *   5. write <episode>/manifest.json and return the Polly task ids for the
 *      state machine to poll
 */
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { TranslateClient, TranslateTextCommand } from '@aws-sdk/client-translate';
import {
  PollyClient,
  StartSpeechSynthesisTaskCommand,
  Engine,
  VoiceId,
  LanguageCode,
} from '@aws-sdk/client-polly';

const s3 = new S3Client({});
const translate = new TranslateClient({});
const polly = new PollyClient({});

const OUTPUT_BUCKET = process.env.OUTPUT_BUCKET!;
const TARGET_LANGUAGES = (process.env.TARGET_LANGUAGES ?? 'es,fr,de,pt')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

// Translate accepts up to 10,000 bytes per request; stay under that with headroom.
const TRANSLATE_CHUNK_BYTES = 9_000;
// Polly async tasks accept up to 200,000 characters (100,000 billed); stay well under.
const POLLY_CHUNK_CHARS = 90_000;

/** Voices per ISO 639-1 language. Neural voices where available. */
const VOICES: Record<string, { voice: VoiceId; language: LanguageCode; engine: Engine }> = {
  en: { voice: 'Joanna', language: 'en-US', engine: 'neural' },
  es: { voice: 'Lupe', language: 'es-US', engine: 'neural' },
  fr: { voice: 'Lea', language: 'fr-FR', engine: 'neural' },
  de: { voice: 'Vicki', language: 'de-DE', engine: 'neural' },
  pt: { voice: 'Camila', language: 'pt-BR', engine: 'neural' },
  it: { voice: 'Bianca', language: 'it-IT', engine: 'neural' },
  ja: { voice: 'Takumi', language: 'ja-JP', engine: 'neural' },
  ko: { voice: 'Seoyeon', language: 'ko-KR', engine: 'neural' },
  zh: { voice: 'Zhiyu', language: 'cmn-CN', engine: 'neural' },
  hi: { voice: 'Kajal', language: 'hi-IN', engine: 'neural' },
  ar: { voice: 'Hala', language: 'ar-AE', engine: 'neural' },
  nl: { voice: 'Laura', language: 'nl-NL', engine: 'neural' },
  pl: { voice: 'Ola', language: 'pl-PL', engine: 'neural' },
  sv: { voice: 'Elin', language: 'sv-SE', engine: 'neural' },
  tr: { voice: 'Burcu', language: 'tr-TR', engine: 'neural' },
};

export interface ProcessTranscriptEvent {
  episodeId: string;
  sourceKey: string;
  /** Presigned or S3-path HTTPS URL Transcribe wrote the job output to. */
  transcriptUri: string;
  /** e.g. "en-US" as detected by Transcribe. */
  sourceLanguageCode: string;
}

export interface PollyTaskRef {
  taskId: string;
  language: string;
  part: number;
  outputUri: string;
}

export interface ProcessTranscriptResult {
  episodeId: string;
  sourceLanguage: string;
  languages: string[];
  manifestKey: string;
  pollyTasks: PollyTaskRef[];
}

export async function handler(event: ProcessTranscriptEvent): Promise<ProcessTranscriptResult> {
  console.log('event', JSON.stringify(event));

  const { bucket, key } = parseTranscriptUri(event.transcriptUri);
  const transcriptJson = await readS3Text(bucket, key);
  const sourceText = extractTranscriptText(transcriptJson);
  const sourceLanguage = event.sourceLanguageCode.slice(0, 2).toLowerCase();

  const prefix = `${event.episodeId}`;
  await putText(`${prefix}/${sourceLanguage}/transcript.txt`, sourceText);

  const pollyTasks: PollyTaskRef[] = [];
  const languages: string[] = [];

  for (const lang of TARGET_LANGUAGES) {
    if (lang === sourceLanguage) continue;
    const voice = VOICES[lang];
    if (!voice) {
      console.warn(`No Polly voice configured for "${lang}", skipping`);
      continue;
    }

    const translated = await translateText(sourceText, sourceLanguage, lang);
    await putText(`${prefix}/${lang}/transcript.txt`, translated);
    languages.push(lang);

    const chunks = chunkByChars(translated, POLLY_CHUNK_CHARS);
    for (let i = 0; i < chunks.length; i++) {
      const res = await polly.send(
        new StartSpeechSynthesisTaskCommand({
          Engine: voice.engine,
          VoiceId: voice.voice,
          LanguageCode: voice.language,
          OutputFormat: 'mp3',
          OutputS3BucketName: OUTPUT_BUCKET,
          OutputS3KeyPrefix: `${prefix}/${lang}/audio-part${String(i + 1).padStart(3, '0')}-`,
          Text: chunks[i],
          TextType: 'text',
        }),
      );
      if (!res.SynthesisTask?.TaskId)
        throw new Error(`Polly returned no TaskId for ${lang} part ${i + 1}`);
      pollyTasks.push({
        taskId: res.SynthesisTask.TaskId,
        language: lang,
        part: i + 1,
        outputUri: res.SynthesisTask.OutputUri ?? '',
      });
    }
  }

  const manifestKey = `${prefix}/manifest.json`;
  const result: ProcessTranscriptResult = {
    episodeId: event.episodeId,
    sourceLanguage,
    languages,
    manifestKey,
    pollyTasks,
  };
  await putText(
    manifestKey,
    JSON.stringify(
      { ...result, sourceKey: event.sourceKey, createdAt: new Date().toISOString() },
      null,
      2,
    ),
    'application/json',
  );
  return result;
}

// ------------------------------------------------------------------ helpers

function parseTranscriptUri(uri: string): { bucket: string; key: string } {
  // Transcribe returns https://s3.<region>.amazonaws.com/<bucket>/<key> for customer buckets.
  const u = new URL(uri);
  const parts = u.pathname.replace(/^\//, '').split('/');
  const bucket = parts.shift();
  if (!bucket || parts.length === 0) throw new Error(`Unrecognised transcript URI: ${uri}`);
  return { bucket, key: decodeURIComponent(parts.join('/')) };
}

async function readS3Text(bucket: string, key: string): Promise<string> {
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return (await res.Body!.transformToString('utf-8')) as string;
}

async function putText(
  key: string,
  body: string,
  contentType = 'text/plain; charset=utf-8',
): Promise<void> {
  await s3.send(
    new PutObjectCommand({ Bucket: OUTPUT_BUCKET, Key: key, Body: body, ContentType: contentType }),
  );
}

/** Pulls the full transcript string out of an Amazon Transcribe job output document. */
export function extractTranscriptText(json: string): string {
  const doc = JSON.parse(json) as { results?: { transcripts?: { transcript?: string }[] } };
  const text = doc.results?.transcripts
    ?.map((t) => t.transcript ?? '')
    .join(' ')
    .trim();
  if (!text) throw new Error('Transcript document contained no text');
  return text;
}

async function translateText(text: string, from: string, to: string): Promise<string> {
  const out: string[] = [];
  for (const chunk of chunkByBytes(text, TRANSLATE_CHUNK_BYTES)) {
    const res = await translate.send(
      new TranslateTextCommand({ Text: chunk, SourceLanguageCode: from, TargetLanguageCode: to }),
    );
    out.push(res.TranslatedText ?? '');
  }
  return out.join(' ');
}

/** Split on sentence boundaries so no piece exceeds maxBytes (UTF-8). */
export function chunkByBytes(text: string, maxBytes: number): string[] {
  const sentences = text.match(/[^.!?]+[.!?]*\s*/g) ?? [text];
  const chunks: string[] = [];
  let current = '';
  for (const s of sentences) {
    if (Buffer.byteLength(current + s, 'utf8') > maxBytes && current) {
      chunks.push(current.trim());
      current = '';
    }
    // A single sentence longer than the limit is split hard by characters.
    if (Buffer.byteLength(s, 'utf8') > maxBytes) {
      for (const piece of hardSplit(s, maxBytes)) chunks.push(piece.trim());
      continue;
    }
    current += s;
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

export function chunkByChars(text: string, maxChars: number): string[] {
  // Character limits map onto the same byte splitter with a generous factor for multibyte text.
  return chunkByBytes(text, maxChars);
}

function hardSplit(s: string, maxBytes: number): string[] {
  const out: string[] = [];
  let buf = '';
  for (const ch of s) {
    if (Buffer.byteLength(buf + ch, 'utf8') > maxBytes) {
      out.push(buf);
      buf = '';
    }
    buf += ch;
  }
  if (buf) out.push(buf);
  return out;
}

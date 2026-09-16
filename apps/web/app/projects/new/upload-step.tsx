'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  SUPPORTED_SOURCE_TYPES,
  type AssetSummary,
  type InitUploadRequest,
  type Project,
} from '@polycast/contracts';
import type { CreateProjectRequest } from '@/lib/contract-types';
import { Button, Field, ProgressBar, describedBy } from '@polycast/ui';
import { api } from '@/lib/client-api';
import { describeError } from '@/lib/errors';
import { formatBytes } from '@/lib/format';
import {
  MultipartUploader,
  readUploadRecord,
  type UploadProgress,
  type UploadRecord,
} from '@/lib/upload';
import { JobStateBadge } from '@/components/state-badge';

const EXT_TO_TYPE: Record<string, InitUploadRequest['contentType']> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  wav: 'audio/wav',
  flac: 'audio/flac',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
};

function contentTypeFor(file: File): InitUploadRequest['contentType'] | null {
  const declared = file.type as InitUploadRequest['contentType'];
  if ((SUPPORTED_SOURCE_TYPES as readonly string[]).includes(declared)) return declared;
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  return EXT_TO_TYPE[ext] ?? null;
}

export interface UploadStepProps {
  projectId: string | null;
  existingAsset: AssetSummary | null;
  onProjectCreated: (projectId: string) => void;
  onUploaded: (projectId: string) => Promise<void> | void;
}

export function UploadStep({
  projectId,
  existingAsset,
  onProjectCreated,
  onUploaded,
}: UploadStepProps) {
  const [title, setTitle] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<{ title?: string; file?: string }>({});
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [pending, setPending] = useState<UploadRecord | null>(null);
  const uploader = useRef<MultipartUploader | null>(null);

  // On reload, surface the interrupted upload so the user can pick the same file to resume.
  useEffect(() => {
    if (!projectId) return;
    setPending(
      readUploadRecord(typeof localStorage === 'undefined' ? null : localStorage, projectId),
    );
  }, [projectId]);

  useEffect(() => () => uploader.current?.pause(), []);

  const busy = progress !== null && !['completed', 'failed', 'aborted'].includes(progress.phase);

  async function start(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const errors: { title?: string; file?: string } = {};
    if (!projectId && title.trim().length === 0) errors.title = 'Give the localization a title.';
    if (!file) errors.file = 'Choose a source media file.';
    const contentType = file ? contentTypeFor(file) : null;
    if (file && !contentType)
      errors.file = 'Unsupported type. Use MP4, MOV, WebM, WAV, FLAC, MP3 or M4A.';
    if (pending && file && (file.name !== pending.fileName || file.size !== pending.byteSize)) {
      errors.file = `Pick "${pending.fileName}" (${formatBytes(pending.byteSize)}) to resume, or discard the interrupted upload.`;
    }
    setFieldError(errors);
    if (Object.keys(errors).length > 0 || !file || !contentType) return;

    let id = projectId;
    try {
      if (!id) {
        const body: CreateProjectRequest = { title: title.trim() };
        const res = await api<{ project: Project }>('/api/v1/projects', { method: 'POST', body });
        id = res.project.id;
        onProjectCreated(id);
      }
      const up = new MultipartUploader({
        projectId: id,
        file,
        fileName: file.name,
        contentType,
        onProgress: setProgress,
      });
      uploader.current = up;
      await up.run();
      setPending(null);
      await onUploaded(id);
    } catch (err) {
      if (err instanceof Error && err.name === 'UploadAbortedError') return;
      setError(describeError(err));
    }
  }

  const pct = progress ? progress.fraction : 0;
  const phaseText = progress
    ? {
        idle: 'Idle',
        initializing: 'Starting upload…',
        uploading: `Uploading ${progress.uploadedParts} of ${progress.partCount} parts`,
        paused: `Paused at ${progress.uploadedParts} of ${progress.partCount} parts`,
        completing: 'Finalizing…',
        completed: 'Upload complete',
        aborted: 'Upload cancelled',
        failed: `Upload failed: ${progress.error ?? 'unknown error'}`,
      }[progress.phase]
    : '';

  return (
    <form className="card" onSubmit={start} aria-labelledby="upload-heading" noValidate>
      <h2 id="upload-heading">Step 1: Upload source</h2>
      {error && (
        <div className="alert" role="alert">
          {error}
        </div>
      )}

      {existingAsset && (
        <p className="notice">
          This project already has a source file <strong>{existingAsset.fileName}</strong> (
          <JobStateBadge state={existingAsset.status} />
          ). Uploading again replaces it.
        </p>
      )}

      {pending && !busy && (
        <p className="notice">
          An upload of <strong>{pending.fileName}</strong> ({pending.parts.length}/
          {pending.partCount} parts) was interrupted. Choose the same file to resume, or{' '}
          <button
            type="button"
            className="link-button"
            onClick={() => {
              localStorage.removeItem(`pc.upload.${pending.projectId}`);
              setPending(null);
            }}
          >
            discard it
          </button>
          .
        </p>
      )}

      {!projectId && (
        <Field id="title" label="Title" required error={fieldError.title}>
          <input
            id="title"
            type="text"
            maxLength={200}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            disabled={busy}
            aria-invalid={fieldError.title ? true : undefined}
            aria-describedby={describedBy('title', { error: Boolean(fieldError.title) })}
          />
        </Field>
      )}

      <Field
        id="file"
        label="Source media"
        required
        description="MP4, MOV, WebM video or WAV, FLAC, MP3, M4A audio. Uploads resume after a reload."
        error={fieldError.file}
      >
        <input
          id="file"
          type="file"
          accept={[
            ...SUPPORTED_SOURCE_TYPES,
            '.mp4',
            '.mov',
            '.webm',
            '.wav',
            '.flac',
            '.mp3',
            '.m4a',
          ].join(',')}
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          disabled={busy}
          aria-invalid={fieldError.file ? true : undefined}
          aria-describedby={describedBy('file', {
            description: true,
            error: Boolean(fieldError.file),
          })}
        />
      </Field>
      {file && (
        <p className="muted small">
          {file.name} · {formatBytes(file.size)}
        </p>
      )}

      {progress && (
        <div className="stack" aria-live="polite">
          <ProgressBar value={pct} label="Upload progress" />
          <p className="small" role="status">
            {phaseText}
            {progress.totalBytes > 0 && progress.phase === 'uploading' && (
              <span className="muted">
                {' '}
                · {formatBytes(progress.uploadedBytes)} of {formatBytes(progress.totalBytes)}
              </span>
            )}
          </p>
        </div>
      )}

      <div className="actions">
        {!busy && (
          <Button type="submit">
            {pending ? 'Resume upload' : projectId ? 'Upload' : 'Create project and upload'}
          </Button>
        )}
        {busy && progress?.phase === 'uploading' && (
          <Button type="button" variant="secondary" onClick={() => uploader.current?.pause()}>
            Pause
          </Button>
        )}
        {busy && progress?.phase === 'paused' && (
          <Button type="button" onClick={() => uploader.current?.resume()}>
            Resume
          </Button>
        )}
        {busy && (
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              void uploader.current?.abort();
              setPending(null);
            }}
          >
            Cancel upload
          </Button>
        )}
      </div>
    </form>
  );
}

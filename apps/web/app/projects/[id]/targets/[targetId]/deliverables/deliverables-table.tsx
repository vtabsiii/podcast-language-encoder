'use client';

import { useState } from 'react';
import type { Deliverable, ProvenanceManifest } from '@polycast/contracts';
import type { DownloadLink } from '@/lib/contract-types';
import { Button, Table } from '@polycast/ui';
import { api } from '@/lib/client-api';
import { describeError } from '@/lib/errors';
import { formatBytes, formatDateTime, truncateHash } from '@/lib/format';

const KIND_LABEL: Record<Deliverable['kind'], string> = {
  media: 'Localized media',
  'captions-srt': 'Captions (SRT)',
  'captions-vtt': 'Captions (VTT)',
  'transcript-json': 'Transcript (JSON)',
  'qc-report': 'QC report',
  'provenance-manifest': 'Provenance manifest',
  checksums: 'Checksums',
};

export function DeliverablesTable({
  targetId,
  deliverables,
}: {
  targetId: string;
  deliverables: Deliverable[];
}) {
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [disclosure, setDisclosure] = useState<string | null>(null);
  const manifest = deliverables.find((d) => d.kind === 'provenance-manifest');

  async function link(d: Deliverable): Promise<DownloadLink> {
    return api<DownloadLink>(`/api/v1/target-jobs/${targetId}/deliverables/${d.id}/download`);
  }

  async function download(d: Deliverable) {
    setBusy(d.id);
    setError(null);
    try {
      const l = await link(d);
      setStatus(`Downloading ${l.fileName}. The link expires at ${formatDateTime(l.expiresAt)}.`);
      window.location.assign(l.url);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(null);
    }
  }

  async function copy(d: Deliverable) {
    try {
      await navigator.clipboard.writeText(d.sha256);
      setStatus(`Copied SHA-256 for ${d.fileName}.`);
    } catch {
      setStatus(`Could not access the clipboard. SHA-256: ${d.sha256}`);
    }
  }

  async function showDisclosure() {
    if (!manifest) return;
    setBusy('manifest');
    setError(null);
    try {
      const l = await link(manifest);
      const res = await fetch(l.url);
      if (!res.ok) throw new Error(`Manifest fetch failed with HTTP ${res.status}`);
      const json = (await res.json()) as Partial<ProvenanceManifest>;
      setDisclosure(json.disclosure ?? 'The manifest carries no disclosure text.');
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="card stack">
      {error && (
        <div className="alert" role="alert">
          {error}
        </div>
      )}
      <p role="status" aria-live="polite" className="muted small">
        {status ?? ''}
      </p>
      {deliverables.length === 0 ? (
        <p className="muted">No deliverables have been packaged yet.</p>
      ) : (
        <Table caption="Files in this deliverable package" hideCaption>
          <thead>
            <tr>
              <th scope="col">Kind</th>
              <th scope="col">File</th>
              <th scope="col">Size</th>
              <th scope="col">SHA-256</th>
              <th scope="col">Version</th>
              <th scope="col">Download</th>
            </tr>
          </thead>
          <tbody>
            {deliverables.map((d) => (
              <tr key={d.id}>
                <td>{KIND_LABEL[d.kind] ?? d.kind}</td>
                <th scope="row" style={{ fontWeight: 500 }}>
                  {d.fileName}
                  <div className="muted small">{d.contentType}</div>
                </th>
                <td>{formatBytes(d.byteSize)}</td>
                <td>
                  <code className="mono" title={d.sha256}>
                    {truncateHash(d.sha256)}
                  </code>{' '}
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => copy(d)}
                    aria-label={`Copy SHA-256 for ${d.fileName}`}
                  >
                    Copy
                  </button>
                </td>
                <td>{d.packageVersion}</td>
                <td>
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => download(d)}
                    disabled={busy !== null}
                    aria-label={`Download ${d.fileName}`}
                  >
                    Download
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {manifest && (
        <section aria-labelledby="provenance-heading">
          <h2 id="provenance-heading">Provenance</h2>
          <p className="muted small">
            Every package embeds a provenance manifest listing the models used. The disclosure text
            below is what customers may show on screen.
          </p>
          {disclosure ? (
            <blockquote className="notice" style={{ margin: 0 }}>
              {disclosure}
            </blockquote>
          ) : (
            <Button
              type="button"
              variant="secondary"
              onClick={showDisclosure}
              disabled={busy !== null}
            >
              Show disclosure text
            </Button>
          )}
        </section>
      )}
    </div>
  );
}

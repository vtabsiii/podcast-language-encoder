'use client';

import { useEffect, useRef, useState } from 'react';
import { formatMediaTime } from '@/lib/time';

export interface WaveformProps {
  url: string | null;
  durationUs: number;
  positionUs: number;
  selection: { start: number; end: number } | null;
  onSeek: (us: number) => void;
}

/**
 * Accepts the waveform JSON in any of these shapes: `number[]`, `{ peaks: number[] }`,
 * `{ samples: number[] }`, `{ data: number[] }`. Values may be in [-1, 1] or [0, 1].
 */
export function normalizePeaks(raw: unknown): number[] {
  const arr = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object'
      ? ((raw as Record<string, unknown>).peaks ??
        (raw as Record<string, unknown>).samples ??
        (raw as Record<string, unknown>).data)
      : null;
  if (!Array.isArray(arr)) return [];
  const nums = arr
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
    .map(Math.abs);
  const max = nums.reduce((m, v) => Math.max(m, v), 0) || 1;
  return nums.map((v) => v / max);
}

export function Waveform({ url, durationUs, positionUs, selection, onSeek }: WaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [peaks, setPeaks] = useState<number[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!url) return;
    const controller = new AbortController();
    fetch(url, { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((json: unknown) => setPeaks(normalizePeaks(json)))
      .catch(() => setFailed(true));
    return () => controller.abort();
  }, [url]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !peaks) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);
    const styles = getComputedStyle(canvas);
    const accent = styles.getPropertyValue('--pc-color-accent').trim() || '#1f5fbf';
    const muted = styles.getPropertyValue('--pc-color-text-muted').trim() || '#5f5f5a';
    if (selection && durationUs > 0) {
      ctx.fillStyle = 'rgba(255, 138, 0, 0.18)';
      const x0 = (selection.start / durationUs) * w;
      const x1 = (selection.end / durationUs) * w;
      ctx.fillRect(x0, 0, Math.max(1, x1 - x0), h);
    }
    ctx.fillStyle = muted;
    const n = peaks.length;
    for (let x = 0; x < w; x += 1) {
      const p = peaks[Math.floor((x / w) * n)] ?? 0;
      const bar = Math.max(1, p * (h - 4));
      ctx.fillRect(x, (h - bar) / 2, 1, bar);
    }
    if (durationUs > 0) {
      ctx.fillStyle = accent;
      ctx.fillRect((positionUs / durationUs) * w, 0, 2, h);
    }
  }, [peaks, durationUs, positionUs, selection]);

  if (!url) return <p className="muted small">No waveform available.</p>;
  if (failed) return <p className="muted small">Waveform could not be loaded.</p>;
  const label = `Waveform. Playhead at ${formatMediaTime(positionUs)}${selection ? `, selected ${formatMediaTime(selection.start)} to ${formatMediaTime(selection.end)}` : ''}. Click to seek.`;
  return (
    <canvas
      ref={canvasRef}
      className="waveform"
      role="img"
      aria-label={label}
      onClick={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        if (rect.width > 0 && durationUs > 0)
          onSeek(Math.round(((e.clientX - rect.left) / rect.width) * durationUs));
      }}
    >
      {label}
    </canvas>
  );
}

import type { StatusTone } from './status-badge.js';

/**
 * Shared tone mappings so every screen renders the same state with the same icon + colour.
 * Inputs are plain strings so this package stays free of domain dependencies; unknown
 * values fall back to a neutral tone rather than throwing.
 */
export function toneForTier(tier: string | undefined): StatusTone {
  switch (tier) {
    case 'production':
      return 'ok';
    case 'beta':
      return 'warn';
    default:
      return 'queued';
  }
}

export function toneForJobState(state: string | undefined): StatusTone {
  switch (state) {
    case 'COMPLETE':
    case 'READY':
      return 'ok';
    case 'NEEDS_REVIEW':
    case 'RETRY_WAIT':
    case 'CANCEL_REQUESTED':
      return 'warn';
    case 'FAILED':
    case 'CANCELLED':
      return 'error';
    case 'UPLOADING':
    case 'QUEUED':
    case 'READY_TO_CONFIGURE':
    case undefined:
      return 'queued';
    default:
      return 'info';
  }
}

export function toneForProjectState(state: string | undefined): StatusTone {
  switch (state) {
    case 'complete':
    case 'ready':
      return 'ok';
    case 'analyzing':
    case 'processing':
      return 'info';
    default:
      return 'queued';
  }
}

export function toneForSeverity(severity: string | undefined): StatusTone {
  switch (severity) {
    case 'critical':
      return 'error';
    case 'warning':
      return 'warn';
    default:
      return 'info';
  }
}

export function toneForResolution(resolution: string | undefined): StatusTone {
  switch (resolution) {
    case 'open':
      return 'warn';
    case 'accepted':
    case 'regenerated':
      return 'ok';
    case 'dismissed':
      return 'queued';
    default:
      return 'info';
  }
}

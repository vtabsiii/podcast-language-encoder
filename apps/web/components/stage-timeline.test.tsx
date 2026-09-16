import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StageTimeline, targetStages } from './stage-timeline';

describe('targetStages', () => {
  it('lists target-side happy-path stages and drops lip sync for audio-only', () => {
    const withLip = targetStages(true, 'TRANSLATING');
    expect(withLip[0]).toBe('TRANSLATING');
    expect(withLip).toContain('LIP_SYNCING');
    expect(withLip.at(-1)).toBe('COMPLETE');
    expect(withLip).not.toContain('UPLOADING');
    expect(targetStages(false, 'TRANSLATING')).not.toContain('LIP_SYNCING');
  });
  it('shows NEEDS_REVIEW as a gate only while in it', () => {
    expect(targetStages(false, 'NEEDS_REVIEW')).toContain('NEEDS_REVIEW');
    expect(targetStages(false, 'READY')).not.toContain('NEEDS_REVIEW');
  });
});

describe('StageTimeline', () => {
  it('marks the current stage and earlier ones as done', () => {
    render(<StageTimeline state="MIXING" lipSync={false} label="Stages for es-419" />);
    const list = screen.getByRole('list', { name: 'Stages for es-419' });
    const current = list.querySelector('[aria-current="step"]');
    expect(current?.textContent).toContain('Mixing');
    expect(list.querySelectorAll('[data-stage="done"]').length).toBe(3); // translating, synthesizing, timing
  });
  it('renders exception states as an extra error item', () => {
    render(<StageTimeline state="FAILED" lipSync={false} label="Stages for fr-FR" />);
    const err = screen
      .getByRole('list', { name: 'Stages for fr-FR' })
      .querySelector('[data-stage="error"]');
    expect(err?.textContent).toBe('Failed');
  });
});

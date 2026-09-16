import { describe, expect, it } from 'vitest';
import {
  describeOpenIssueProgress,
  nextOpenIssueIndex,
  openIssueCount,
  openIssueProgress,
} from './review-issues';

const seg = (...resolutions: string[]) => ({
  issues: resolutions.map((resolution) => ({ resolution })),
});

describe('nextOpenIssueIndex', () => {
  const segments = [seg('open'), seg(), seg('accepted'), seg('open', 'open'), seg()];

  it('finds the next flagged segment after the selection', () => {
    expect(nextOpenIssueIndex(segments, 0)).toBe(3);
    expect(nextOpenIssueIndex(segments, 1)).toBe(3);
  });
  it('wraps around the end of the list', () => {
    expect(nextOpenIssueIndex(segments, 3)).toBe(0);
    expect(nextOpenIssueIndex(segments, 4)).toBe(0);
  });
  it('returns the selection itself when it is the only flagged segment', () => {
    expect(nextOpenIssueIndex([seg(), seg('open'), seg('dismissed')], 1)).toBe(1);
  });
  it('returns -1 when nothing is open', () => {
    expect(nextOpenIssueIndex([seg(), seg('accepted')], 0)).toBe(-1);
    expect(nextOpenIssueIndex([], 0)).toBe(-1);
  });
  it('treats an invalid selection as "before the first segment"', () => {
    expect(nextOpenIssueIndex(segments, Number.NaN)).toBe(0);
    expect(nextOpenIssueIndex(segments, -1)).toBe(0);
  });
});

describe('openIssueProgress', () => {
  const segments = [seg('open'), seg(), seg('accepted'), seg('open', 'open'), seg('open')];

  it('counts open issues and positions the selection among them', () => {
    expect(openIssueCount(segments[3]!)).toBe(2);
    expect(openIssueProgress(segments, 0)).toEqual({ total: 4, position: 1 });
    expect(openIssueProgress(segments, 3)).toEqual({ total: 4, position: 2 });
    expect(openIssueProgress(segments, 4)).toEqual({ total: 4, position: 4 });
  });
  it('has no position when the selected segment is clean', () => {
    expect(openIssueProgress(segments, 1)).toEqual({ total: 4, position: null });
    expect(openIssueProgress(segments, 2)).toEqual({ total: 4, position: null });
  });
  it('describes progress for the toolbar', () => {
    expect(describeOpenIssueProgress({ total: 8, position: 3 })).toBe('Open issue 3 of 8');
    expect(describeOpenIssueProgress({ total: 8, position: null })).toBe(
      'Open issues remaining: 8',
    );
    expect(describeOpenIssueProgress({ total: 0, position: null })).toBe('');
  });
});

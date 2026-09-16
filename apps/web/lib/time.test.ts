import { describe, expect, it } from 'vitest';
import {
  budgetUsePercent,
  formatDuration,
  formatMediaTime,
  formatRange,
  toPlayerSeconds,
} from './time';

describe('formatMediaTime', () => {
  it('formats integer microseconds as mm:ss.mmm', () => {
    expect(formatMediaTime(0)).toBe('00:00.000');
    expect(formatMediaTime(1_500)).toBe('00:00.002'); // rounds to nearest ms
    expect(formatMediaTime(65_123_456)).toBe('01:05.123');
    expect(formatMediaTime(3_599_999_500)).toBe('1:00:00.000');
  });
  it('adds hours past one hour', () => {
    expect(formatMediaTime(3_600_000_000 + 61_001_000)).toBe('1:01:01.001');
  });
  it('is defensive about bad input', () => {
    expect(formatMediaTime(-5)).toBe('00:00.000');
    expect(formatMediaTime(Number.NaN)).toBe('00:00.000');
  });
});

describe('formatDuration / formatRange / helpers', () => {
  it('renders whole-second durations', () => {
    expect(formatDuration(59_000_000)).toBe('59s');
    expect(formatDuration(600_000_000)).toBe('10m 00s');
    expect(formatDuration(3_723_000_000)).toBe('1h 02m 03s');
  });
  it('renders ranges', () => {
    expect(formatRange({ start: 0, end: 2_000_000 })).toBe('00:00.000 – 00:02.000');
  });
  it('converts to player seconds only at the boundary', () => {
    expect(toPlayerSeconds(2_500_000)).toBe(2.5);
  });
  it('computes budget usage', () => {
    expect(budgetUsePercent(1_100_000, 1_000_000)).toBe(110);
    expect(budgetUsePercent(1, 0)).toBe(0);
  });
});

import { describe, expect, it } from 'vitest';
import { parseRps } from '../src/ui/rps';

describe('parseRps', () => {
  it.each([
    ['2000', 2000],
    ['2k', 2000],
    ['1.5k', 1500],
    ['1M', 1_000_000],
    ['5M', 1_000_000],
    ['250 rps', 250],
    ['12,500', 12500],
    [' 3K ', 3000],
  ])('reads %s as %d', (input, expected) => {
    expect(parseRps(input)).toBe(expected);
  });

  it.each(['', 'abc', '0', '-5', '2kk', '1e3'])('rejects %s', (input) => {
    expect(parseRps(input)).toBeNull();
  });
});

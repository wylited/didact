import { describe, expect, it } from 'vitest';
import { parseBabelHeaders } from '../src/babel';

describe('parseBabelHeaders', () => {
  it('parses :session name', () => {
    expect(parseBabelHeaders(':session demo')).toEqual({ session: 'demo' });
  });

  it('parses a session header after other leading headers', () => {
    expect(parseBabelHeaders('-n :session a')).toEqual({ session: 'a' });
  });

  it('parses a session header before other trailing options', () => {
    expect(parseBabelHeaders(':session a :results output')).toEqual({ session: 'a' });
  });

  it('is case-insensitive', () => {
    expect(parseBabelHeaders(':SESSION Demo')).toEqual({ session: 'Demo' });
    expect(parseBabelHeaders('-n :Session a')).toEqual({ session: 'a' });
  });

  it('returns {} when there is no session option', () => {
    expect(parseBabelHeaders('')).toEqual({});
    expect(parseBabelHeaders('-n :results output')).toEqual({});
  });

  it('returns {} when :session has no name', () => {
    expect(parseBabelHeaders(':session')).toEqual({});
    expect(parseBabelHeaders(':session ')).toEqual({});
  });
});

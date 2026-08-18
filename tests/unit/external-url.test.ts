import { describe, expect, it } from 'vitest';
import { isExternalUrl } from '../../src/main/lib/external-url';

describe('isExternalUrl', () => {
  it.each([
    ['http://example.com', true],
    ['https://example.com', true],
    ['https://github.com/foo/bar', true],
    ['mailto:foo@bar.com', true],
    ['MAILTO:foo@bar.com', true],
    ['file:///etc/passwd', false],
    ['javascript:alert(1)', false],
    ['data:text/plain,foo', false],
    ['/workspace/.lorra/skills/x.md', false],
    ['', false],
  ])('%s → %s', (url, expected) => {
    expect(isExternalUrl(url)).toBe(expected);
  });
});

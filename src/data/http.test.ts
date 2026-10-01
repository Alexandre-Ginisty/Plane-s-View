import { describe, expect, it } from 'vitest';

import { httpsUrl } from './http';

describe('httpsUrl', () => {
  it('keeps an https link', () => {
    expect(httpsUrl('https://www.planespotters.net/photo/123')).toBe('https://www.planespotters.net/photo/123');
  });

  it('refuses anything that could run or leak in href or src', () => {
    for (const hostile of [
      'javascript:alert(1)',
      ' javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'http://insecure.example/photo.jpg',
      'https://user:pass@example.com/',
      '//example.com/x',
      42,
      null,
      `https://example.com/${'a'.repeat(3000)}`,
    ]) {
      expect(httpsUrl(hostile), String(hostile).slice(0, 40)).toBeNull();
    }
  });
});

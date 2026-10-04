import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchPhotoByRegistration } from './commons';

function page(title: string, licence: string, artist = 'Jane Doe') {
  return {
    title,
    imageinfo: [
      {
        thumburl: `https://thumb.wikimedia.org/wikipedia/commons/thumb/${encodeURIComponent(title)}.jpg`,
        descriptionurl: `https://commons.wikimedia.org/wiki/${encodeURIComponent(title)}`,
        extmetadata: { LicenseShortName: { value: licence }, Artist: { value: artist } },
      },
    ],
  };
}

function answer(...pages: ReturnType<typeof page>[]): void {
  vi.stubGlobal('fetch', () =>
    Promise.resolve(
      new Response(JSON.stringify({ query: { pages: Object.fromEntries(pages.map((p, i) => [i, p])) } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('aircraft photographs from Commons', () => {
  it('takes a free-licence photograph whose name carries the registration', async () => {
    answer(page('File:HOP!, F-HBLE, Embraer ERJ-190LR.jpg', 'CC BY-SA 2.0', '<a href="x">Anna &amp; Co</a>'));
    const photo = await fetchPhotoByRegistration('F-HBLE');
    expect(photo?.license).toBe('CC BY-SA 2.0');
    expect(photo?.photographer).toBe('Anna & Co');
    expect(photo?.link.startsWith('https://commons.wikimedia.org/')).toBe(true);
  });

  it('matches the registration with or without its dash', async () => {
    answer(page('File:FHBLE at Paris.jpg', 'CC BY 4.0'));
    expect(await fetchPhotoByRegistration('F-HBLE')).not.toBeNull();
  });

  it('skips a photograph of some other aircraft', async () => {
    answer(page('File:Brit Air CRJ-700, F-GRZA.jpg', 'CC BY 2.0'));
    expect(await fetchPhotoByRegistration('F-HBLE')).toBeNull();
  });

  it('skips licences that do not allow commercial use', async () => {
    for (const licence of ['CC BY-NC 2.0', 'CC BY-NC-SA 4.0', 'GFDL 1.2', 'All rights reserved', 'Copyrighted free use']) {
      answer(page('File:F-HBLE.jpg', licence));
      expect(await fetchPhotoByRegistration('F-HBLE'), licence).toBeNull();
    }
  });

  it('accepts the licences that do', async () => {
    for (const licence of ['CC BY 2.0', 'CC BY-SA 3.0', 'CC BY 4.0', 'CC0', 'Public domain']) {
      answer(page('File:F-HBLE.jpg', licence));
      expect(await fetchPhotoByRegistration('F-HBLE'), licence).not.toBeNull();
    }
  });

  it('never loads an image from anywhere but Wikimedia', async () => {
    const hostile = page('File:F-HBLE.jpg', 'CC BY 4.0');
    hostile.imageinfo[0]!.thumburl = 'https://evil.example/x.jpg';
    answer(hostile);
    expect(await fetchPhotoByRegistration('F-HBLE')).toBeNull();
  });

  it('does not search for a registration too short to mean anything', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    expect(await fetchPhotoByRegistration('N1')).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
});

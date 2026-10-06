import { describe, expect, it } from 'vitest';

import { parseMetar } from './metar';

/** As the Aviation Weather Center sent it, trimmed. */
const LFPG = {
  icaoId: 'LFPG',
  obsTime: 1791277200,
  temp: 18,
  dewp: 9,
  wdir: 50,
  wspd: 5,
  visib: '6+',
  altim: 1019,
  rawOb: 'METAR LFPG 060900Z 05005KT 020V090 CAVOK 18/09 Q1019 NOSIG',
  cover: 'CAVOK',
  clouds: [],
  fltCat: 'VFR',
};

describe('parseMetar', () => {
  it('reads what a pilot reads first', () => {
    expect(parseMetar(LFPG)).toEqual({
      icao: 'LFPG',
      raw: LFPG.rawOb,
      observedAt: 1791277200000,
      tempC: 18,
      dewC: 9,
      windDirDeg: 50,
      windVariable: false,
      windKt: 5,
      gustKt: null,
      visibility: '6+',
      qnhHpa: 1019,
      ceilingFt: null,
      cover: 'CAVOK',
      category: 'VFR',
    });
  });

  it('takes the lowest broken or overcast layer as the ceiling, not a few clouds below it', () => {
    const m = parseMetar({
      ...LFPG,
      clouds: [
        { cover: 'FEW', base: 800 },
        { cover: 'BKN', base: 2500 },
        { cover: 'OVC', base: 1200 },
      ],
      fltCat: 'MVFR',
    });
    expect(m?.ceilingFt).toBe(1200);
    expect(m?.category).toBe('MVFR');
  });

  it('knows a variable wind and a numeric visibility', () => {
    const m = parseMetar({ ...LFPG, wdir: 'VRB', wspd: 2, visib: 3 });
    expect(m?.windDirDeg).toBeNull();
    expect(m?.windVariable).toBe(true);
    expect(m?.visibility).toBe('3');
  });

  it('refuses what is not a report', () => {
    for (const bad of [null, 'METAR', {}, { icaoId: 'LFPG' }, { ...LFPG, icaoId: 'LF' }, { ...LFPG, rawOb: '' }]) {
      expect(parseMetar(bad)).toBeNull();
    }
  });

  it('drops a flight category it does not know rather than guess', () => {
    expect(parseMetar({ ...LFPG, fltCat: 'UNK' })?.category).toBeNull();
  });
});

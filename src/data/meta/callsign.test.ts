import { describe, expect, it } from 'vitest';

import { isRegistrationCallsign, routelessReason } from './callsign';

describe('why a flight has no route', () => {
  it('recognises aircraft flying under their registration', () => {
    for (const cs of ['FHSAB', 'N649SR', 'N38945', 'SEMMK', 'GFRGP', 'DEABC']) {
      expect(isRegistrationCallsign(cs), cs).toBe(true);
    }
    expect(isRegistrationCallsign('OOABC', 'OO-ABC')).toBe(true);
  });

  it('leaves airline, charter and military callsigns alone', () => {
    for (const cs of ['EZY39MG', 'UAL848', 'NJE640L', 'BOXER44', 'GAF979', 'JNY8', 'SJX032']) {
      expect(isRegistrationCallsign(cs), cs).toBe(false);
      expect(routelessReason(cs)).toBe('unpublished');
    }
  });
});

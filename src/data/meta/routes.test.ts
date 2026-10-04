import { describe, expect, it } from 'vitest';

import { parseCallsign } from './routes';

describe('parseCallsign', () => {
  it('splits an airline code from its flight number', () => {
    expect(parseCallsign('AFR1234')).toEqual({ airline: 'AFR', number: '1234' });
    expect(parseCallsign('ezy39mg')).toEqual({ airline: 'EZY', number: '39MG' });
  });

  it('drops leading zeros, as the route data does', () => {
    expect(parseCallsign('AFR0012')).toEqual({ airline: 'AFR', number: '12' });
    expect(parseCallsign('BAW007')).toEqual({ airline: 'BAW', number: '7' });
    expect(parseCallsign('KLM0')).toEqual({ airline: 'KLM', number: '0' });
  });

  it('is not fooled by things that are not flight numbers', () => {
    for (const cs of ['FHSAB', 'N649SR', 'BOXER44', 'AFR', '', 'AF1234', 'AFR12345678']) {
      expect(parseCallsign(cs), cs).toBeNull();
    }
  });
});

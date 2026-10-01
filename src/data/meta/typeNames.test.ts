import { describe, expect, it } from 'vitest';
import { typeName } from './typeNames';

describe('type names', () => {
  it('names the common designators, whatever their case or padding', () => {
    expect(typeName('A20N')).toBe('Airbus A320neo');
    expect(typeName(' b38m ')).toBe('Boeing 737 MAX 8');
    expect(typeName('E295')).toBe('Embraer E195-E2');
  });
  it('says nothing rather than guess', () => {
    expect(typeName('ZZZZ')).toBeNull();
    expect(typeName(null)).toBeNull();
  });
});

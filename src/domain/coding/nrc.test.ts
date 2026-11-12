import { describe, expect, it } from 'vitest';
import { explainNrc } from './nrc.ts';

describe('explainNrc', () => {
  it('never puts the code (or any hex) in the message', () => {
    for (const c of [
      '13',
      '22',
      '31',
      '33',
      '35',
      '36',
      '37',
      '72',
      '7E',
      '7F',
      '83',
      '88',
      '92',
      '93',
      '99',
    ]) {
      const text = explainNrc(c);
      expect(text).not.toMatch(/code [0-9A-F]|\(code|0x|\b[0-9A-F]{2}\b/);
      expect(text).toMatch(/^Your car didn't accept the change\./);
    }
  });
  it('tells the owner what to do when the car says it is running or moving', () => {
    expect(explainNrc('88')).toMatch(/engine off/i);
    expect(explainNrc('83')).toMatch(/engine off/i);
  });
  it('normalises case and padding, and stays generic for unknown codes', () => {
    expect(explainNrc('7f')).toBe(explainNrc('7F'));
    expect(explainNrc('5')).toBe("Your car didn't accept the change.");
    expect(explainNrc('EE')).toBe("Your car didn't accept the change.");
  });
});

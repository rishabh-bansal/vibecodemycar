import { describe, expect, it } from 'vitest';
import { nextCardIndex } from './grid-nav.ts';

// Three columns: 0 1 2 / 3 4 5 / 6
const grid = [0, 1, 2, 3, 4, 5, 6].map((n) => ({
  top: Math.floor(n / 3) * 100,
  left: (n % 3) * 200,
  width: 180,
  height: 90,
}));

describe('grid arrow-key navigation', () => {
  it('moves by row for Up/Down, keeping the column', () => {
    expect(nextCardIndex(grid, 1, 'ArrowDown')).toBe(4);
    expect(nextCardIndex(grid, 4, 'ArrowUp')).toBe(1);
    expect(nextCardIndex(grid, 5, 'ArrowDown')).toBe(6); // last row is short: nearest card
    expect(nextCardIndex(grid, 6, 'ArrowDown')).toBe(6);
  });
  it('steps in order for Left/Right, within bounds', () => {
    expect(nextCardIndex(grid, 2, 'ArrowRight')).toBe(3);
    expect(nextCardIndex(grid, 0, 'ArrowLeft')).toBe(0);
  });
  it('without layout, Up/Down step one card', () => {
    const empty = grid.map(() => ({ top: 0, left: 0, width: 0, height: 0 }));
    expect(nextCardIndex(empty, 1, 'ArrowDown')).toBe(2);
  });
});

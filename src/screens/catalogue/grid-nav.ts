/** Where a card sits on screen (from getBoundingClientRect). */
export interface CardBox {
  top: number;
  left: number;
  width: number;
  height: number;
}

/**
 * The card arrow keys move to in a wrapping grid. Left/Right step through the cards in order; Up/Down go
 * to the card in the row above/below that is nearest horizontally. Without layout (all boxes empty, e.g.
 * in tests) Up/Down step like Left/Right.
 */
export function nextCardIndex(boxes: readonly CardBox[], i: number, key: string): number {
  const clamp = (n: number) => Math.max(0, Math.min(boxes.length - 1, n));
  if (key === 'ArrowLeft') return clamp(i - 1);
  if (key === 'ArrowRight') return clamp(i + 1);
  const here = boxes[i];
  const laidOut = boxes.some((b) => b.width > 0 && b.height > 0);
  if (!here || !laidOut) return clamp(key === 'ArrowUp' ? i - 1 : i + 1);
  const down = key === 'ArrowDown';
  const rows = boxes
    .map((b, index) => ({ b, index }))
    .filter(({ b }) => (down ? b.top > here.top + 1 : b.top < here.top - 1));
  if (!rows.length) return i;
  // the nearest row in that direction, then the card in it closest to this one's centre
  const rowTop = down ? Math.min(...rows.map(({ b }) => b.top)) : Math.max(...rows.map(({ b }) => b.top));
  const centre = here.left + here.width / 2;
  const row = rows.filter(({ b }) => Math.abs(b.top - rowTop) <= 1);
  row.sort(
    (a, b) => Math.abs(a.b.left + a.b.width / 2 - centre) - Math.abs(b.b.left + b.b.width / 2 - centre),
  );
  return row[0]?.index ?? i;
}

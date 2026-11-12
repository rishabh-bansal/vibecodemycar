import '@testing-library/jest-dom/vitest';
import 'fake-indexeddb/auto';
import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => cleanup());

// The default 1 s for findBy*/waitFor fails correct screens when the machine is busy (the catalogue's
// first lazy load alone can exceed it). A real regression still fails, only later.
configure({ asyncUtilTimeout: 5000 });

// jsdom does not implement scrolling; the router calls it on navigation.
window.scrollTo = () => {};

// jsdom does not implement ResizeObserver; Radix primitives on the car screen measure with it.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

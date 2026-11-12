import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { sanitizeSelection, withBrand, withDetected, withModel } from '../domain/catalog/selection.ts';
import type { Brand, CarSelection, DetectedCar } from '../domain/catalog/types.ts';
import { defaultSelection } from '../domain/catalog/vehicles.ts';
import { LOCAL_KEYS } from '../domain/storage-keys.ts';

/** The car this browser is set up for. Only a fingerprint + mask of the VIN are kept, never the VIN. */
export interface Pairing {
  fingerprint: string;
  masked: string;
}

interface CarState {
  selection: CarSelection;
  pairing?: Pairing;
  setBrand(brand: Brand): void;
  setModel(model: string): void;
  /** What the connected car reported about itself (cluster, model year), read on connect. */
  setDetected(detected: DetectedCar): void;
  pair(pairing: Pairing): void;
  unpair(): void;
}

export const useCarStore = create<CarState>()(
  persist(
    (set) => ({
      selection: defaultSelection(),
      pairing: undefined,
      // A different brand or model is a different car: what was read from the old one and its VIN pairing go. Picking the
      // one already set up (a Landing tile, "Set up this car") changes nothing.
      setBrand: (brand) =>
        set((s) =>
          s.selection.brand === brand ? s : { selection: withBrand(s.selection, brand), pairing: undefined },
        ),
      setModel: (model) =>
        set((s) =>
          s.selection.model === model ? s : { selection: withModel(s.selection, model), pairing: undefined },
        ),
      setDetected: (detected) => set((s) => ({ selection: withDetected(s.selection, detected) })),
      pair: (pairing) => set({ pairing }),
      unpair: () => set({ pairing: undefined }),
    }),
    {
      name: LOCAL_KEYS.car,
      storage: createJSONStorage(() => localStorage),
      // v1 stored the variant, year, build period and cluster the old picker asked for. Those selections load
      // as they are: sanitizeSelection keeps brand and model and whichever details still name something. A photo
      // colour saved by an earlier version is dropped with the other unknown keys.
      version: 2,
      migrate: (persisted) => persisted as Pick<CarState, 'selection' | 'pairing'>,
      partialize: (s) => ({ selection: s.selection, pairing: s.pairing }),
      // Stored data is untrusted: the car list may have changed since it was written.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<Pick<CarState, 'selection' | 'pairing'>>;
        const pairing =
          p.pairing && typeof p.pairing.fingerprint === 'string' && typeof p.pairing.masked === 'string'
            ? p.pairing
            : undefined;
        return { ...current, selection: sanitizeSelection(p.selection), pairing };
      },
    },
  ),
);

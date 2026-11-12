import { useEffect, useState } from 'react';
import { loadCatalogue } from '../../domain/catalogue/data.ts';
import type { CatalogueModel } from '../../domain/catalogue/types.ts';

export type CatalogueState =
  | { status: 'loading' }
  | { status: 'ready'; models: CatalogueModel[] }
  | { status: 'error'; retry: () => void };

let cached: Promise<CatalogueModel[]> | undefined;

/** All 8 models load once, up front, so switching cars is instant. The first boot shows skeletons. */
export function useCatalogue(): CatalogueState {
  const [state, setState] = useState<CatalogueState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` re-runs the load on retry
  useEffect(() => {
    let live = true;
    cached ??= loadCatalogue();
    cached.then(
      (models) => live && setState({ status: 'ready', models }),
      () => {
        cached = undefined; // allow a retry to try again
        if (live)
          setState({
            status: 'error',
            retry: () => {
              setState({ status: 'loading' });
              setAttempt((n) => n + 1);
            },
          });
      },
    );
    return () => {
      live = false;
    };
  }, [attempt]);
  return state;
}

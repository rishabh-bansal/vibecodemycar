import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
  type RouterHistory,
  RouterProvider,
  redirect,
} from '@tanstack/react-router';
import { Landing } from '../screens/Landing.tsx';
import { NotFound } from '../screens/NotFound.tsx';
import { RouteError } from '../screens/RouteError.tsx';

// Screens load on demand: the landing page ships without the app's Bluetooth, storage and form code.

/**
 * A free-text search param. The router parses `?q=123` as the number 123: that is still what the
 * user typed, so numbers and booleans become text. Anything else malformed is dropped, never thrown.
 * (Plain functions, not zod: the router is on the landing page's critical path.)
 */
const text = (v: unknown): string | undefined =>
  typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : undefined;
const oneOf =
  <T extends string>(...allowed: T[]) =>
  (v: unknown): T | undefined =>
    allowed.includes(v as T) ? (v as T) : undefined;
const action = oneOf('restore', 'recheck');
const tab = oneOf('unlocks', 'service');

/** Keeps only the params that are present, so every param stays optional for links and navigation. */
function present<T extends Record<string, unknown>>(
  values: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
}

export function createAppRouter(history?: RouterHistory) {
  const rootRoute = createRootRoute({
    component: Outlet,
    notFoundComponent: NotFound,
    errorComponent: RouteError,
  });

  const landing = createRoute({ getParentRoute: () => rootRoute, path: '/', component: Landing });
  const car = createRoute({
    getParentRoute: () => rootRoute,
    path: '/car',
    component: lazyRouteComponent(() => import('../screens/CarScreen.tsx'), 'CarScreen'),
  });
  // Backups are kept per car in the background; an old bookmark to the list lands on the features.
  const oldBackups = createRoute({
    getParentRoute: () => rootRoute,
    path: '/backups',
    beforeLoad: () => {
      throw redirect({ to: '/features', replace: true });
    },
  });
  const done = createRoute({
    getParentRoute: () => rootRoute,
    path: '/done',
    component: lazyRouteComponent(() => import('../screens/DoneScreen.tsx'), 'DoneScreen'),
  });
  const coding = createRoute({
    getParentRoute: () => rootRoute,
    path: '/coding',
    component: lazyRouteComponent(() => import('../screens/CodingScreen.tsx'), 'CodingScreen'),
  });

  const connect = createRoute({
    getParentRoute: () => rootRoute,
    path: '/connect',
    component: lazyRouteComponent(() => import('../screens/ConnectScreen.tsx'), 'ConnectScreen'),
    validateSearch: (s: Record<string, unknown>) =>
      present({
        feature: text(s.feature),
        setting: text(s.setting),
        backup: text(s.backup),
        action: action(s.action),
        inspect: text(s.inspect),
      }),
  });

  const features = createRoute({
    getParentRoute: () => rootRoute,
    path: '/features',
    component: lazyRouteComponent(
      () => import('../screens/catalogue/CatalogueScreen.tsx'),
      'CatalogueScreen',
    ),
    validateSearch: (s: Record<string, unknown>) =>
      present({ car: text(s.car), tab: tab(s.tab), g: text(s.g), q: text(s.q), f: text(s.f) }),
  });

  const routeTree = rootRoute.addChildren([landing, car, oldBackups, done, coding, connect, features]);

  return createRouter({ routeTree, history, defaultPreload: 'intent', scrollRestoration: true });
}

export const router = createAppRouter();

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

export const AppRouter = ({ instance = router }: { instance?: typeof router }) => (
  <RouterProvider router={instance} />
);

import { activeConnectionLoggers } from './connection-log.ts';
import { kickCloudSync, sendOnExit } from './outbox.ts';

/**
 * Ties the private log's upload to the page's life, so nothing waits for the next Bluetooth connection:
 *  - app start: anything still queued (or failed) from earlier visits uploads now;
 *  - the page becomes visible again: sync;
 *  - the page is hidden: the open connection-log chunk is saved and a sync starts;
 *  - the page is unloaded (pagehide, not kept in the back/forward cache): each running connection log is ended
 *    and its last chunk sent with a keepalive request when small enough; otherwise it uploads on the next start.
 * Only logs are touched here — never the link or the car.
 */
let installed = false;

export function installCloudLifecycle(
  target: Pick<Window, 'addEventListener'> | undefined = globalThis.window,
): void {
  if (installed || !target) return;
  installed = true;
  kickCloudSync();
  target.addEventListener('visibilitychange', () => {
    if (globalThis.document?.visibilityState === 'hidden')
      for (const l of activeConnectionLoggers()) l.flush();
    kickCloudSync();
  });
  target.addEventListener('pagehide', (e) => {
    const persisted = (e as PageTransitionEvent).persisted;
    for (const logger of activeConnectionLoggers()) {
      if (persisted) {
        logger.flush();
        continue;
      }
      const last = logger.end('page closed');
      if (last) sendOnExit('session', last);
    }
  });
}

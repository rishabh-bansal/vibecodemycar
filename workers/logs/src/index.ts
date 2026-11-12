/**
 * The Worker's entry module. It exports only the handler: the Workers runtime treats every named export of the
 * entry module as an entrypoint and refuses to start when one is a plain value (`RETENTION_DAYS`, …). The
 * implementation and its testable exports live in worker.ts.
 */
export { default } from './worker.ts';

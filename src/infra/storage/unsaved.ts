import type { ExperimentRecord } from '../../domain/coding/audit.ts';

/**
 * Downloadable copies of experiments IndexedDB failed to save. A Map that tells subscribers when it
 * changes, so the history shows a record the moment it could not be saved.
 */
class UnsavedExperiments extends Map<string, ExperimentRecord> {
  private readonly listeners = new Set<() => void>();
  private version = 0;
  override set(id: string, record: ExperimentRecord): this {
    super.set(id, record);
    this.changed();
    return this;
  }
  override delete(id: string): boolean {
    const had = super.delete(id);
    if (had) this.changed();
    return had;
  }
  override clear(): void {
    super.clear();
    this.changed();
  }
  /** For `useSyncExternalStore`: bumps on every change. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  readonly snapshot = (): number => this.version;
  private changed(): void {
    this.version++;
    for (const l of this.listeners) l();
  }
}

// Retains a downloadable copy if IndexedDB fails after transmission.
export const unsavedExperiments = new UnsavedExperiments();

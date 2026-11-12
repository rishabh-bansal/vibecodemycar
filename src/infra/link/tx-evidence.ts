import type { TxFrame, UdsRequestOptions } from '@obdcraft/obd-core';
import type { TxFrameRecord, WriteOptions } from '../../domain/coding/types.ts';

const hexOf = (bytes: readonly number[]): string =>
  bytes.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join('');

/**
 * Collects the frames of a whole write sequence, numbering them across its exchanges, and forwards
 * each one to the session as soon as it is handed to the adapter and again when its stage is known.
 * Exchanges on one channel never overlap, so an exchange's frames follow the previous one's.
 */
export function txRecorder(options: Pick<WriteOptions, 'onTxFrame'>) {
  const frames: TxFrameRecord[] = [];
  return {
    frames,
    /** Options for the next exchange; call immediately before it. */
    exchange(): Pick<UdsRequestOptions, 'onTxFrame'> {
      const base = frames.length;
      return {
        onTxFrame: (index: number, f: TxFrame) => {
          const record: TxFrameRecord = {
            can: f.can,
            data: hexOf(f.bytes),
            stage: f.stage,
            // An STPX command carries the whole PDU: kept to what a journal entry holds.
            ...(f.sent ? { sent: f.sent.length > 200 ? `${f.sent.slice(0, 199)}…` : f.sent } : {}),
          };
          frames[base + index] = record;
          options.onTxFrame?.(base + index, record);
        },
      };
    },
  };
}

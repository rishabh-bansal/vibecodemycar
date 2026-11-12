import type { ChooserFilters } from '@obdcraft/obd-core';
import { fullUuid, LIKELY_SERVICES } from '../../domain/adapters/likely.ts';

/**
 * Name prefixes adapters advertise. Web Bluetooth matches a name prefix case-sensitively, so each common
 * spelling is listed. "OBD" covers the owner's "OBDBLE", "OBDII", "OBD2" and "OBDLink".
 */
export const ADAPTER_NAME_PREFIXES: readonly string[] = [
  'OBD',
  'Obd',
  'obd',
  'ELM',
  'Elm',
  'elm',
  'Vgate',
  'VGATE',
  'vgate',
  'Veepeak',
  'VEEPEAK',
  'VeePeak',
  'vLinker',
  'VLinker',
  'Vlinker',
  'VLINKER',
  'IOS-Vlink',
  'Android-Vlink',
  'V-LINK',
  'V-Link',
  'v-link',
  'iCar',
  'ICAR',
  'Icar',
  'KONNWEI',
  'Konnwei',
  'KW9',
  'iOBD',
  'IOBD',
];

/**
 * What the browser's chooser lists.
 *  - `adapters` (the first try): devices that advertise an adapter serial service (FFF0, FFE0, 18F0) or whose
 *    name starts like an adapter's.
 *  - `all`: every nearby device, as before. For clones that advertise neither (the chooser then shows them by
 *    name or as "Unknown device"); offered when the filtered chooser found nothing or was closed.
 */
export type ChooserScope = 'adapters' | 'all';

export function chooserFor(scope: ChooserScope): ChooserFilters | undefined {
  if (scope === 'all') return undefined;
  return {
    filters: [
      ...LIKELY_SERVICES.map((s) => ({ services: [fullUuid(s)] })),
      ...ADAPTER_NAME_PREFIXES.map((namePrefix) => ({ namePrefix })),
    ],
  };
}

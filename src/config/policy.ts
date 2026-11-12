/**
 * Product policy — the few switches that shape what the app does. Owner directive (2026-11-01): users accept the
 * risk, so nothing here withholds a feature or refuses a write. What remains is functional: a write is read
 * first, backed up durably, written, read back, and restorable onto the same car/module/DID.
 */
export const POLICY = {
  /**
   * Usual vehicle state for coding, used ONLY to word a readiness WARNING — the engine measures engine speed,
   * road speed and supply voltage before a write, journals them, and warns when they are outside this band or
   * unreadable. It never refuses on them (the control unit answers NRC 0x22 / 0x93 itself when it won't code).
   */
  writeReadiness: { minVoltage: 11.0, maxVoltage: 15.2 },

  /** Affiliate link for the "no adapter?" button — config value, not hard-coded UI. */
  adapterShopUrl: import.meta.env?.VITE_ADAPTER_URL ?? 'https://www.amazon.in/s?k=elm327+bluetooth+obd2',
} as const;

import { describe, expect, it } from 'vitest';
import {
  adapterService,
  chipText,
  deviceClassFromAppearance,
  deviceClassFromMajorClass,
  isLikelyObdAdapter,
  otherHint,
  type ScannedDevice,
  shortUuid,
  signalBars,
  signalText,
  subline,
} from './likely.ts';

const dev = (over: Partial<ScannedDevice> = {}): ScannedDevice => ({ id: 'x', serviceUuids: [], ...over });
const full = (s: string) => `0000${s}-0000-1000-8000-00805f9b34fb`;

describe('isLikelyObdAdapter', () => {
  it.each([
    'OBDBLE',
    'OBDII',
    'obd2',
    'OBDLink CX',
    'ELM327 v1.5',
    'Vgate iCar Pro',
    'VEEPEAK',
    'vLinker MC-IOS',
    'V-LINK',
    'iCar2',
    'KONNWEI KW902',
  ])('a known adapter name: %s', (name) => {
    expect(isLikelyObdAdapter(dev({ name }))).toBe(true);
  });

  it('follows the owner rule exactly: "IOS-Vlink" is not a name match (no "v-link"), only by its service', () => {
    expect(isLikelyObdAdapter(dev({ name: 'IOS-Vlink' }))).toBe(false);
    expect(isLikelyObdAdapter(dev({ name: 'IOS-Vlink', serviceUuids: ['18f0'] }))).toBe(true);
  });

  it.each(['fff0', 'ffe0', '18f0', 'FFF0', '0xFFE0'])('an advertised adapter service (short %s)', (u) => {
    expect(isLikelyObdAdapter(dev({ serviceUuids: [u] }))).toBe(true);
  });

  it.each(['fff0', 'ffe0', '18f0'])('an advertised adapter service (128-bit %s), even unnamed', (u) => {
    expect(isLikelyObdAdapter(dev({ serviceUuids: [full(u).toUpperCase()] }))).toBe(true);
  });

  it('other names and services do not qualify', () => {
    expect(isLikelyObdAdapter(dev({ name: 'Mi TV Stick' }))).toBe(false);
    expect(isLikelyObdAdapter(dev())).toBe(false);
    expect(
      isLikelyObdAdapter(dev({ serviceUuids: [full('180d'), 'e7810a71-73ae-499d-8c15-faa9aef0c3f2'] })),
    ).toBe(false);
  });

  it('audio and wearable devices never qualify, even when the name or a service matches', () => {
    expect(isLikelyObdAdapter(dev({ name: 'OBD Speaker', deviceClass: 'audio' }))).toBe(false);
    expect(isLikelyObdAdapter(dev({ name: 'Galaxy Watch (OBD7)', deviceClass: 'wearable' }))).toBe(false);
    expect(isLikelyObdAdapter(dev({ serviceUuids: ['fff0'], deviceClass: 'audio' }))).toBe(false);
    // No advertised class: an audio or wearable name still excludes it.
    expect(isLikelyObdAdapter(dev({ name: 'Galaxy Watch5 (OBD7)' }))).toBe(false);
    expect(isLikelyObdAdapter(dev({ name: 'JBL Flip ELM speaker', serviceUuids: ['fff0'] }))).toBe(false);
    expect(isLikelyObdAdapter(dev({ name: 'boAt Rockerz OBD' }))).toBe(false);
    expect(isLikelyObdAdapter(dev({ name: 'OBDBLE' }))).toBe(true);
    expect(isLikelyObdAdapter(dev({ name: 'OBDBLE', deviceClass: 'other' }))).toBe(true);
  });
});

describe('device classes', () => {
  it('reads audio and wearable categories from the GAP appearance', () => {
    expect(deviceClassFromAppearance(0x0941)).toBe('audio'); // earbud
    expect(deviceClassFromAppearance(0x0841)).toBe('audio'); // standalone speaker
    expect(deviceClassFromAppearance(0x0a41)).toBe('audio'); // hearing aid
    expect(deviceClassFromAppearance(0x00c1)).toBe('wearable'); // sports watch
    expect(deviceClassFromAppearance(0x0340)).toBe('wearable'); // heart rate sensor
    expect(deviceClassFromAppearance(0x0080)).toBe('other'); // computer
    expect(deviceClassFromAppearance(0)).toBeUndefined();
    expect(deviceClassFromAppearance(undefined)).toBeUndefined();
  });

  it('reads the Classic major class', () => {
    expect(deviceClassFromMajorClass(0x04)).toBe('audio');
    expect(deviceClassFromMajorClass(0x07)).toBe('wearable');
    expect(deviceClassFromMajorClass(0x01)).toBe('other');
  });
});

describe('signal', () => {
  it('3 bars at -60 dBm or stronger, 2 at -75 or stronger, else 1', () => {
    expect([-40, -60, -61, -75, -76, -95].map(signalBars)).toEqual([3, 3, 2, 2, 1, 1]);
    expect(signalBars(undefined)).toBe(1);
  });

  it('asks to move closer only below -80 dBm', () => {
    expect(signalText(-80)).toBe('weak signal');
    expect(signalText(-81)).toBe('weak signal · move closer');
    expect(signalText(-55)).toBe('strong signal');
    expect(signalText(undefined)).toBe('signal unknown');
  });
});

describe('the lines under a device', () => {
  it('subline: chip/protocol · BLE · signal', () => {
    expect(subline(dev({ name: 'OBDBLE', rssi: -58, serviceUuids: ['fff0'] }))).toBe(
      'ELM327 · BLE · strong signal',
    );
    expect(subline(dev({ name: 'vLinker MC', rssi: -70 }))).toBe('STN chip · BLE · good signal');
    expect(subline(dev({ serviceUuids: [full('ffe0')], rssi: -85 }))).toBe(
      'FFE0 serial · BLE · weak signal · move closer',
    );
    expect(subline(dev({ name: 'Mi TV', rssi: -70 }))).toBe('BLE · good signal');
    // An excluded device never gets an adapter chip label, whatever its name says.
    expect(subline(dev({ name: 'Watch (OBD7)', deviceClass: 'wearable', rssi: -64 }))).toBe(
      'BLE · good signal',
    );
  });

  it('hints why a device sits under OTHER DEVICES', () => {
    expect(otherHint(dev({ name: 'boAt Airdopes', deviceClass: 'audio' }))).toBe('not an adapter');
    expect(otherHint(dev({ name: 'JBL Flip 5' }))).toBe('not an adapter');
    expect(otherHint(dev())).toBe('try only if nothing above works');
    expect(otherHint(dev({ name: '  ' }))).toBe('try only if nothing above works');
    expect(otherHint(dev({ name: 'Mi TV Stick' }))).toBe('try only if nothing above works');
  });

  it('UUID helpers', () => {
    expect(shortUuid('FFF0')).toBe(0xfff0);
    expect(shortUuid(full('18f0'))).toBe(0x18f0);
    expect(shortUuid('e7810a71-73ae-499d-8c15-faa9aef0c3f2')).toBeUndefined();
    expect(adapterService(dev({ serviceUuids: ['180d', full('ffe0')] }))).toBe(0xffe0);
    expect(chipText(dev())).toBeUndefined();
  });
});

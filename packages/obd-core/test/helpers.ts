import { VirtualClock, runVirtual } from '../src/util/clock.ts';
import { Elm327Emulator, type EmulatorOptions } from '../src/emulator/elm327.ts';
import { kushaqLikeEcus } from '../src/emulator/presets.ts';
import { ElmSession, type WireEvent } from '../src/elm/session.ts';

/** Seeded PRNG so fault injection is reproducible. */
export function seeded(seed = 1): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function rig(opts: Partial<EmulatorOptions> = {}) {
  const clock = new VirtualClock();
  const emu = new Elm327Emulator({ clock, ecus: kushaqLikeEcus(), random: seeded(7), ...opts });
  const wire: WireEvent[] = [];
  const session = new ElmSession(emu, { clock, onWire: (e) => wire.push(e) });
  const run = <T>(p: Promise<T>) => runVirtual(clock, p);
  return { clock, emu, session, wire, run };
}

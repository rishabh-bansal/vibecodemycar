import { OBD, MODE06, fieldByKey } from './index.ts';
import { midName, tidName } from './mode06.ts';
import type { FieldDef, PidDef } from './types.ts';

export interface BeginnerInfo {
  key: string;
  title: string;
  meaning: string;
  why: string;
  context: string;
  range: { min: number; max: number; unit: string; source: string } | null;
  terms: string[];
  confidence: string;
}

export const GLOSSARY = [
  ['rpm', 'RPM', 'Revolutions per minute: how quickly the engine turns. RPM is not road speed.'],
  ['ecu', 'ECU', 'An electronic control unit: one of the small computers in the car. Engine, gearbox, brakes and body equipment can each have one.'],
  ['pid', 'PID', 'A parameter identifier: the number used to request a specific OBD reading.'],
  ['dtc', 'DTC', 'A diagnostic trouble code saved by a control unit. It identifies a detected condition, not necessarily the part that must be replaced.'],
  ['mil', 'Check-engine light', 'The malfunction indicator lamp. A flashing lamp may need urgent attention; follow the vehicle handbook.'],
  ['stft', 'Short-term fuel trim', 'The engine’s immediate correction to its fuel mixture. Positive adds fuel; negative removes fuel.'],
  ['ltft', 'Long-term fuel trim', 'The learned fuel correction built up over time. Interpret it with short-term trim on a warm engine in closed loop.'],
  ['closed-loop', 'Closed loop', 'The engine adjusts fuel using oxygen-sensor feedback. It may deliberately leave this mode when cold, accelerating hard or coasting.'],
  ['maf', 'MAF', 'Mass air flow: the measured mass of air entering the engine, usually grams per second.'],
  ['map', 'MAP', 'Manifold absolute pressure: air pressure inside the intake. Absolute pressure includes atmospheric pressure; it is not the same as boost.'],
  ['boost', 'Boost', 'Intake pressure above the surrounding air pressure. Approximate boost is manifold absolute pressure minus barometric pressure.'],
  ['iat', 'Intake temperature', 'The temperature of air entering the engine. It can rise while stationary because of heat under the bonnet.'],
  ['lambda', 'Lambda', 'Air/fuel ratio relative to the fuel’s chemically balanced mixture. One is balanced; higher is leaner, lower is richer. Operating conditions matter.'],
  ['readiness', 'Readiness', 'Whether an emissions monitor has completed its tests since codes were cleared. Incomplete does not by itself mean the part is faulty.'],
  ['freeze', 'Freeze frame', 'A snapshot of a few readings saved when a fault was detected. It can belong to a different code than the one currently selected.'],
  ['pending', 'Pending code', 'A condition detected but not yet confirmed. It may disappear or become a stored code after another drive.'],
  ['permanent', 'Permanent code', 'An emissions code the car itself removes after confirming a repair. A normal clear-codes command cannot erase it.'],
  ['vin', 'VIN', 'The vehicle identification number. It identifies the individual car and should be treated as private.'],
  ['can', 'CAN bus', 'A communication network linking the car’s control units. Generic OBD exposes only part of its information.'],
  ['uds', 'UDS', 'Unified Diagnostic Services: diagnostic requests used by many modern control units for identification, tests and configuration.'],
  ['coding', 'Coding and adaptation', 'Configuration stored in a control unit. The correct procedure depends on its exact hardware, software and the car’s fitted equipment.'],
  ['sfd', 'Secure diagnostic gateway', 'Authorization used by some newer vehicles to protect configuration changes. It requires a legitimate, supported authorization process.'],
  ['egr', 'EGR', 'Exhaust-gas recirculation. The car routes a controlled amount of exhaust back into the intake to manage combustion and emissions.'],
  ['dpf', 'DPF', 'Diesel particulate filter. It collects soot and periodically regenerates. A temperature or pressure reading alone does not prove a blockage.'],
  ['evap', 'EVAP', 'The fuel-vapour recovery system. Purge is the controlled flow of collected vapour into the engine.'],
  ['catalyst', 'Catalyst', 'An exhaust component that reduces harmful emissions. High exhaust temperatures can be normal under load.'],
  ['bank', 'Bank and sensor', 'A bank is a group of cylinders. Sensor numbers identify positions in the exhaust; layouts vary by engine.'],
  ['volumetric-efficiency', 'Volumetric efficiency', 'How much air fills the cylinders compared with their geometric capacity. An assumed value makes speed-density fuel use an estimate.'],
  ['speed-density', 'Speed-density estimate', 'An estimate of air/fuel use from RPM, pressure, intake temperature and engine size. Fill-up calibration is needed for useful accuracy.'],
  ['hysteresis', 'Hysteresis', 'Using a different threshold to clear a warning than to trigger it, preventing flickering near a boundary.'],
] .map(([id, title, meaning]) => ({ id: id!, title: title!, meaning: meaning! }));

const common: Record<string, Partial<BeginnerInfo>> = {
  rpm: { title: 'Engine speed', meaning: 'How fast the engine is turning.', why: 'Useful for seeing warm-up, idling and gear changes.', context: 'Cold idle is often faster. Hybrid engines can switch off while moving.', terms: ['rpm'] },
  speed: { title: 'Road speed', meaning: 'The speed reported by the car.', why: 'Used to calculate distance and identify driving conditions.', context: 'This can differ from GPS and the dashboard. Small errors affect calculated mileage.' },
  coolant_temp: { title: 'Coolant temperature', meaning: 'How hot the liquid cooling the engine is.', why: 'Shows warm-up and whether temperature settles during a drive.', context: 'Only compare a fully warm engine under similar load. Follow the dashboard warning and handbook first.', range: { min: 75, max: 110, unit: '°C', source: 'Broad Vibecode my car guidance for a warm conventional engine; not an OEM limit.' } },
  iat: { title: 'Air entering the engine', meaning: 'Temperature of intake air at the sensor.', why: 'Warm air and boost affect engine behavior and fuel estimates.', context: 'Heat soak when stationary is normal; compare with outside temperature and vehicle speed.', terms: ['iat'] },
  map: { title: 'Intake air pressure', meaning: 'Absolute air pressure in the intake manifold.', why: 'Helps describe engine load and, with barometric pressure, approximate boost.', context: 'A turbo engine can exceed atmospheric pressure normally. There is no universal healthy range.', terms: ['map', 'boost'] },
  maf: { title: 'Air flowing into the engine', meaning: 'The mass of intake air measured each second.', why: 'Can support a petrol fuel-use estimate when the mixture is known.', context: 'It rises with engine speed and load. Diesel air flow alone does not establish fuel consumption.', terms: ['maf'] },
  module_voltage: { title: 'Electrical supply', meaning: 'Voltage measured by the control unit.', why: 'Helps spot a sustained very low supply.', context: 'Smart charging intentionally varies voltage. This is not a battery-capacity or alternator test.', range: { min: 11.5, max: 15.5, unit: 'V', source: 'Broad 12 V system operating guidance. Temperature and charging strategy matter.' } },
  throttle: { title: 'Throttle opening', meaning: 'The reported opening of the air-control valve.', why: 'Shows how engine control responds to load and driver requests.', context: 'It is not necessarily the accelerator pedal position or a true zero-to-100 mechanical measurement.' },
  engine_load: { title: 'Engine workload', meaning: 'How much of the engine’s calculated capacity is being used.', why: 'Provides context for fuel, pressure and temperature readings.', context: 'High load during acceleration or climbing is expected; it is not a fault by itself.' },
  fuel_level: { title: 'Fuel left in the tank', meaning: 'The tank sensor’s percentage reading.', why: 'Useful for a rough remaining-fuel trend.', context: 'Tank shape, slopes and fuel movement affect this value. Do not use it alone to calculate fill-up mileage.' },
  fuel_rate: { title: 'Fuel used per hour', meaning: 'The fuel consumption rate reported by the engine.', why: 'Combining it with speed gives an instantaneous mileage estimate.', context: 'At a standstill, litres per hour is useful; kilometres per litre is not.' },
  oil_temp: { title: 'Engine oil temperature', meaning: 'How hot the engine oil is at its sensor.', why: 'Oil often takes longer to warm than coolant.', context: 'Compare with your handbook. Sensor placement, load and ambient temperature change the expected value.' },
  distance_since_clear: { title: 'Distance since codes were cleared', meaning: 'Whole kilometres accumulated since fault memory was cleared.', why: 'Provides context for readiness and can calibrate integrated distance over a long enough drive.', context: 'It can reset after clearing or a battery event; its one-kilometre steps make short-trip calibration unreliable.', terms: ['readiness'] },
  lambda_commanded: { title: 'Requested fuel mixture', meaning: 'The air/fuel mixture the engine asks for, relative to its balanced mixture.', why: 'Distinguishes normal rich acceleration and lean overrun from readings worth reviewing.', context: 'A value away from one can be intentional. Extreme values during fuel cut are excluded from fuel estimates.', terms: ['lambda', 'closed-loop'] },
  run_time: { title: 'Time since engine start', meaning: 'Elapsed running time reported by the car.', why: 'Helps distinguish cold starts from steady running.', context: 'Stop/start behavior and resets depend on the vehicle.' },
};

function explainField(pid: PidDef, field: FieldDef): BeginnerInfo {
  const numeric = field.kind === 'numeric';
  let meaning = `${field.name} is reported by the car’s ${pid.category.replace(/_/g, ' ')} monitoring.`;
  let why = numeric ? 'Compare its trend under similar driving conditions; a single reading rarely identifies a fault.' : 'Provides context about what the car supports or what its computer is currently doing.';
  let context = numeric ? 'No universal normal range is established for this reading. The decoder’s measurement limits are not healthy operating limits.' : 'Unavailable or unsupported is different from zero, off or a failed component.';
  let terms: string[] = [];
  if (/^(stft|ltft)_|short_term_trim/.test(field.key)) {
    meaning = `${/ltft/.test(field.key) ? 'Learned' : 'Immediate'} fuel correction: positive adds fuel, negative removes it.`;
    why = 'Read short- and long-term correction together on a warm engine in closed loop.';
    context = 'Cold start, overrun and heavy load can make isolated trim readings misleading. A sensor can report “not used” rather than a valid percentage.';
    terms = ['stft', 'ltft', 'closed-loop'];
  } else if (pid.category === 'oxygen_sensor') {
    meaning = `${field.name} describes an exhaust oxygen sensor or its control circuit.`;
    why = 'It helps the engine control fuel mixture or check the catalyst.';
    context = 'Wide-band and narrow-band sensors behave differently. Sensor location, warm-up and fuel cut matter; a fixed reading is not automatically a fault.';
    terms = ['lambda', 'bank', 'closed-loop'];
  } else if (field.kind === 'readiness' || /monitor_status|monitor_drive/.test(field.key)) {
    meaning = `${field.name} describes the car’s own emissions checks.`;
    context = 'Tests need specific driving conditions and can become incomplete after codes are cleared. Incomplete does not mean failed.';
    terms = ['readiness', 'mil'];
  } else if (field.kind === 'support_bitmap') {
    meaning = 'A list of readings this control unit says it can provide.';
    context = 'Support does not guarantee a reading is available in every operating condition.';
    terms = ['ecu', 'pid'];
  } else if (/egr|evap|cat_temp|nox|dpf|scr/.test(field.key)) {
    why = 'Provides context for the car’s emissions controls and self-check results.';
    context = 'Temperature, load, regeneration and the manufacturer’s strategy affect this reading. There is no universal replacement threshold.';
    terms = ['egr', 'dpf', 'evap', 'catalyst'];
  }
  return { key: field.key, title: field.name, meaning, why, context, range: null, terms, confidence: `${pid.confidence}: ${pid.source}`, ...common[field.key] };
}

let metadata: Map<string, BeginnerInfo> | undefined;
export function beginnerInfo(key: string): BeginnerInfo | null {
  metadata ??= new Map(OBD.pids.flatMap(pid => pid.fields.map(field => [field.key, explainField(pid, field)] as const)));
  return metadata.get(key) ?? null;
}

export function isSimpleReading(key: string): boolean {
  const field = fieldByKey(key)?.field;
  return !!field && field.kind !== 'raw' && field.kind !== 'support_bitmap';
}

/** Plain-language Mode 06 labels; the same rules as `midName`/`tidName` (standard test names only where they apply). */
export function monitorInfo(mid: string, tid: string): { title: string; meaning: string; context: string } {
  const m = Number.parseInt(mid, 16);
  const t = Number.parseInt(tid, 16);
  const monitor = midName(MODE06, m);
  const test = tidName(MODE06, m, t);
  const named = test.standard && MODE06.tids[tid.toUpperCase()] === test.name;
  return {
    title: monitor.endsWith('(not in table)') ? 'Manufacturer self-check' : monitor,
    meaning: named ? test.name : 'The manufacturer defines what this particular test measures.',
    context: 'Compare the measured result with the limits returned by this same control unit. Saturated values can indicate a test that has not run. These results are not a universal service specification.',
  };
}

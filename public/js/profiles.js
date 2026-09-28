// Machine, resin and print-parameter profiles + persistence. Safe to import from Node (no DOM at import time).

export const MACHINES = [
  {
    id: 's4u-16k',
    name: 'Elegoo Saturn 4 Ultra 16K',
    gooName: 'ELEGOO Saturn 4 Ultra 16K',
    gooType: 'MSLA',
    resX: 15120, resY: 6230, // from the firmware string on the printer: V1.5.6B-LCDC/15120*6230
    width: 211.68, depth: 118.37, height: 220, // 14 x 19 micron pixels
    mirrorX: true, mirrorY: false,
    tiltSeconds: 6,
  },
  {
    id: 's4u-12k',
    name: 'Elegoo Saturn 4 Ultra (12K)',
    gooName: 'ELEGOO Saturn 4 Ultra',
    gooType: 'MSLA',
    resX: 11520, resY: 5120,
    width: 218.88, depth: 122.88, height: 220, // 19 x 24 micron pixels
    mirrorX: true, mirrorY: false,
    tiltSeconds: 6,
  },
];

/** How the peel move is described in the file. See README "Release settings" for the evidence behind these. */
export const RELEASE_PRESETS = {
  lift: {
    label: 'Standard Z lift (safe default)',
    hint: 'Writes a normal two-stage lift. Works on any firmware; on tilt-only firmware it is simply ignored or slower.',
    values: {
      bottomLiftHeight: 3, bottomLiftSpeed: 65, bottomLiftHeight2: 4, bottomLiftSpeed2: 180,
      liftHeight: 3, liftSpeed: 65, liftHeight2: 4, liftSpeed2: 180,
      bottomRetractHeight: 5.5, bottomRetractSpeed: 180, bottomRetractHeight2: 1.5, bottomRetractSpeed2: 65,
      retractHeight: 5.5, retractSpeed: 180, retractHeight2: 1.5, retractSpeed2: 65,
    },
  },
  tilt005: {
    label: 'Tilt marker (all 0.05)',
    hint: 'Every lift distance and speed set to 0.05 — the values the stock Saturn 4 Ultra profile is reported to write.',
    values: Object.fromEntries(
      ['bottomLiftHeight', 'bottomLiftSpeed', 'bottomLiftHeight2', 'bottomLiftSpeed2', 'liftHeight', 'liftSpeed', 'liftHeight2',
        'liftSpeed2', 'bottomRetractHeight', 'bottomRetractSpeed', 'bottomRetractHeight2', 'bottomRetractSpeed2', 'retractHeight',
        'retractSpeed', 'retractHeight2', 'retractSpeed2'].map((k) => [k, 0.05]),
    ),
  },
  zero: {
    label: 'All zero',
    hint: 'Lift fields zeroed. Reported to work on 12K firmware; reported to leave Z stationary on some 16K firmware.',
    values: Object.fromEntries(
      ['bottomLiftHeight', 'bottomLiftSpeed', 'bottomLiftHeight2', 'bottomLiftSpeed2', 'liftHeight', 'liftSpeed', 'liftHeight2',
        'liftSpeed2', 'bottomRetractHeight', 'bottomRetractSpeed', 'bottomRetractHeight2', 'bottomRetractSpeed2', 'retractHeight',
        'retractSpeed', 'retractHeight2', 'retractSpeed2'].map((k) => [k, 0]),
    ),
  },
};

export const DEFAULT_PRINT = {
  layerHeight: 0.05,
  exposureTime: 2.5,
  bottomExposureTime: 30,
  bottomLayerCount: 5,
  transitionLayerCount: 6,
  delayMode: 1,
  lightOffDelay: 0,
  bottomWaitAfterCure: 0, bottomWaitAfterLift: 0, bottomWaitBeforeCure: 1,
  waitAfterCure: 0, waitAfterLift: 0, waitBeforeCure: 0.5,
  ...RELEASE_PRESETS.lift.values,
  bottomLightPWM: 255,
  lightPWM: 255,
  perLayerSettings: 0,
  // slicer-side options (not file fields)
  releasePreset: 'lift',
  aa: 4,
  detectIslands: true,
};

export const RESINS = [
  { id: 'std', name: 'Standard photopolymer', exposureTime: 2.5, bottomExposureTime: 30, density: 1.1, pricePerKg: 35 },
  { id: 'abs', name: 'ABS-like', exposureTime: 2.8, bottomExposureTime: 32, density: 1.12, pricePerKg: 40 },
  { id: 'ww', name: 'Water-washable', exposureTime: 2.6, bottomExposureTime: 32, density: 1.1, pricePerKg: 38 },
  { id: 'tough', name: 'Tough / flexible blend', exposureTime: 3.2, bottomExposureTime: 38, density: 1.15, pricePerKg: 55 },
  { id: '8k', name: 'High-detail 8K/16K grey', exposureTime: 2.3, bottomExposureTime: 28, density: 1.1, pricePerKg: 45 },
];

const KEY = 'vatworks.v1';

export function loadState() {
  const base = {
    machineId: 's4u-16k',
    machineOverrides: {}, // id -> partial machine (mirror flags, goo strings)
    resinId: 'std',
    resin: { ...RESINS[0] },
    print: { ...DEFAULT_PRINT },
    supports: null,
    hollow: null,
    printerIp: '192.168.0.29',
    currency: '$',
  };
  try {
    if (typeof localStorage === 'undefined') return base;
    const saved = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (!saved) return base;
    return {
      ...base, ...saved,
      print: { ...base.print, ...(saved.print || {}) },
      resin: { ...base.resin, ...(saved.resin || {}) },
    };
  } catch {
    return base;
  }
}

export function saveState(s) {
  try {
    if (typeof localStorage === 'undefined') return;
    const { machineId, machineOverrides, resinId, resin, print, supports, hollow, printerIp, currency } = s;
    localStorage.setItem(KEY, JSON.stringify({ machineId, machineOverrides, resinId, resin, print, supports, hollow, printerIp, currency }));
  } catch { /* storage unavailable: settings simply do not persist */ }
}

export function getMachine(state) {
  const m = MACHINES.find((x) => x.id === state.machineId) || MACHINES[0];
  return { ...m, ...(state.machineOverrides?.[m.id] || {}) };
}

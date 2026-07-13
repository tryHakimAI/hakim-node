/**
 * SDK version. Keep in sync with `package.json`.
 *
 * We duplicate this literal here (rather than importing from
 * `package.json`) because bundlers + Node ESM disagree on JSON module
 * imports, and we want the SDK to work identically under tsc emit,
 * bundlers, and direct `node --experimental-strip-types` runs.
 *
 * A release script (future) will sync both.
 */
export const SDK_VERSION = '1.0.0';
export const SDK_NAME = '@tryhakim/voice';

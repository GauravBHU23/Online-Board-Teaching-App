/**
 * ESM shim around JSZip's UMD build.
 *
 * JSZip ships UMD only, and pptxgenjs imports it as a default ESM export.
 * The UMD wrapper picks a global to attach to at load time — `window` when one
 * exists, otherwise `global`/`self`/`this` — so we check each candidate rather
 * than assuming `globalThis`. In a browser these are the same object; under a
 * DOM shim (jsdom in tests) they are not.
 *
 * The vendored jszip.umd.js is byte-identical to the published build so it can
 * be re-copied verbatim on upgrade.
 */
import './jszip.umd.js';

const JSZip = globalThis.JSZip
  ?? globalThis.window?.JSZip
  ?? globalThis.self?.JSZip;

if (!JSZip) {
  throw new Error('JSZip failed to load — public/vendor/jszip.umd.js may be missing.');
}

export default JSZip;

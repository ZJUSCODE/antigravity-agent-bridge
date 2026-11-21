import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const shimUrl = pathToFileURL(join(__dirname, 'sidecar_sdk_shim.mjs')).href;

export function resolve(specifier, context, nextResolve) {
  if (specifier === 'sidecar_sdk') {
    return { url: shimUrl, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

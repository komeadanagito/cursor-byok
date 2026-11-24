// Fails when the extension version drifts from the desktop app version: the
// release assets and the desktop status check key on the tauri.conf.json
// version, so the packaged VSIX must carry that exact version.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const [packageJson, tauriJson] = process.argv.slice(2);
const packagePath = packageJson ?? join(here, '..', 'package.json');
const tauriPath = tauriJson ?? join(here, '..', '..', 'desktop', 'src-tauri', 'tauri.conf.json');

const extensionVersion = JSON.parse(readFileSync(packagePath, 'utf8')).version;
const appVersion = JSON.parse(readFileSync(tauriPath, 'utf8')).version;

if (extensionVersion !== appVersion) {
  console.error(
    `workspace-symbols version ${extensionVersion} must equal desktop app version ${appVersion}` +
    ` (${tauriPath}); the desktop app installs the VSIX built for its own version.`,
  );
  process.exit(1);
}
console.log(`workspace-symbols version ${extensionVersion} matches desktop app version`);

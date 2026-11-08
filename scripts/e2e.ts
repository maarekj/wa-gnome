// Tests de bout en bout (e2e/test_*.py, pytest + dogtail) : l'application est construite puis
// pilotée par l'accessibilité sur un écran virtuel, avec un bus D-Bus et un bus d'accessibilité
// privés (rien ne touche la session ni le compte WhatsApp de l'utilisateur). Seul le démon est
// simulé (scripts/fake-daemon.ts, un par test, avec son port de pilotage).
// Usage : node scripts/e2e.ts [arguments pytest, ex. -k envoi]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from './build.ts';

const root = path.resolve(import.meta.dirname, '..');
await buildApp();

// posé par devenv.nix (at-spi2-core)
const libexec = process.env['ATSPI_LIBEXEC'];
if (libexec === undefined) throw new Error('ATSPI_LIBEXEC absent : lance `pnpm e2e` dans le shell devenv');
const quote = (a: string): string => `'${a.replaceAll("'", String.raw`'\''`)}'`;
const pytest = ['python3', '-B', '-m', 'pytest', '-p', 'no:cacheprovider', '-q', '-W', 'ignore::DeprecationWarning', path.join(root, 'e2e'), ...process.argv.slice(2)].map((a) => quote(a)).join(' ');
const script = [
  // accessibilité activée (désactivée dans les autres tests), son coupé, pas de portails
  'export GDK_BACKEND=x11 GSK_RENDERER=cairo GTK_A11Y=atspi GDK_DEBUG=no-portals GIO_USE_VFS=local NO_AT_BRIDGE=0 GSETTINGS_BACKEND=memory',
  'export WA_GNOME_SILENT=1 PULSE_SERVER=unix:/nonexistent PIPEWIRE_REMOTE=wa-gnome-none',
  // bus d'accessibilité et registre AT-SPI lancés à la main (pas de systemd dans le bus privé)
  `${quote(`${libexec}/at-spi-bus-launcher`)} --launch-immediately & sleep 0.5`,
  `${quote(`${libexec}/at-spi2-registryd`)} --use-gnome-session=false & sleep 0.5`,
  // code de pytest conservé : les démons AT-SPI tués à la fin ne doivent pas le masquer
  `${pytest}; code=$?`,
  'kill $(jobs -p) 2>/dev/null; wait 2>/dev/null',
  'exit $code',
].join('\n');
// dossier d'exécution privé, posé avant le bus D-Bus : aucun service qu'il active ne touche
// /run/user de l'utilisateur
const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-e2e-run-'));
const res = spawnSync('xvfb-run', ['-a', '-s', '-screen 0 1280x800x24', 'dbus-run-session', '--', 'bash', '-c', script], {
  stdio: 'inherit',
  cwd: root,
  env: { ...process.env, XDG_RUNTIME_DIR: runtime, GIO_USE_VFS: 'local', GSETTINGS_BACKEND: 'memory' },
});
fs.rmSync(runtime, { recursive: true, force: true });
process.exit(res.status ?? 1);

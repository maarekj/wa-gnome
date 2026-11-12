// Lance l'application sur un écran X virtuel (Xvfb), branchée sur le faux démon, et en prend
// une capture, sans rien afficher à l'écran.
// Usage : node scripts/screenshot.ts [sortie.png] [--state open|qr|connecting]
// Variables : SCREENSHOT_DELAY (s, défaut 4), SCREENSHOT_SIZE (défaut 1100x720),
// SCREENSHOT_XDOTOOL : commandes xdotool jouées avant la capture, séparées par « ; »
// (ex. « mousemove 200 150 click 1; sleep 1; type bonjour; key Return; sleep 2 » ;
// « sh: commande » exécute une commande shell, ex. xclip pour remplir le presse-papier, ou
// curl -XPOST localhost:$WA_GNOME_CONTROL/call pour piloter le faux démon).
import { execFileSync, spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { buildApp } from './build.ts';

const root = path.resolve(import.meta.dirname, '..');
const { values, positionals } = parseArgs({ allowPositionals: true, options: { state: { type: 'string', default: 'open' } } });
const out = path.resolve(positionals[0] ?? path.join(root, 'dist', 'screenshot.png'));
const delay = process.env['SCREENSHOT_DELAY'] ?? '4';
const [w = '1100', h = '720'] = (process.env['SCREENSHOT_SIZE'] ?? '1100x720').split('x');
/** Port libre (attribué par le système), en texte. */
const freePort = (): Promise<string> =>
  new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      srv.close(() => resolve(typeof addr === 'object' && addr !== null ? String(addr.port) : '4797'));
    });
  });
const port = await freePort();
/** pilotage du faux démon (« sh: curl localhost:$WA_GNOME_CONTROL/incoming… ») */
const control = await freePort();
const dir = path.join(os.tmpdir(), 'wa-gnome-screenshot');

await buildApp();
const fake = spawn(process.execPath, [path.join(root, 'scripts', 'fake-daemon.ts'), '--state', values.state, '--port', port, '--dir', dir, '--control', control], { stdio: 'inherit' });
await new Promise((resolve) => {
  setTimeout(resolve, 800);
});
const quote = (s: string): string => `'${s.replaceAll("'", String.raw`'\''`)}'`;
const script = [
  // bus D-Bus privé (pas de contact avec une instance déjà ouverte), sans accessibilité ni portails
  `export WA_GNOME_CONTROL=${control}`,
  `export GDK_BACKEND=x11 GSK_RENDERER=cairo GTK_A11Y=none GDK_DEBUG=no-portals GIO_USE_VFS=local`,
  // son coupé : aucune lecture sur les haut-parleurs de l'utilisateur
  `export WA_GNOME_SILENT=1 PULSE_SERVER=unix:/nonexistent PIPEWIRE_REMOTE=wa-gnome-none`,
  `export WA_GNOME_URL=http://127.0.0.1:${port} WA_GNOME_DATA_DIR=${quote(dir)} WA_GNOME_APP_ID=io.github.maarekj.WaGnome.Screenshot`,
  `timeout ${Number(delay) + (process.env['SCREENSHOT_XDOTOOL'] === undefined ? 3 : 120)} dbus-run-session -- gjs -m ${quote(path.join(root, 'dist', 'app', 'main.js'))} > >(grep -v -e '^dbus-daemon' -e 'DRI3') 2>&1 &`,
  'app=$!',
  `sleep ${delay}`,
  // fenêtre à la taille de l'écran (pas de gestionnaire de fenêtres sous Xvfb)
  `xdotool search --sync --onlyvisible --name WhatsApp windowsize ${w} ${h} windowmove 0 0 || true`,
  'sleep 1',
  ...(process.env['SCREENSHOT_XDOTOOL'] ?? '')
    .split(';')
    .map((c) => c.trim())
    .filter((c) => c !== '')
    .map((c) => (c.startsWith('sleep ') ? c : c.startsWith('sh:') ? c.slice(3) : `xdotool ${c}`)),
  'sleep 1',
  `import -window root ${quote(out)}`,
  'kill $app 2>/dev/null || true',
  'wait',
].join('\n');
try {
  execFileSync('xvfb-run', ['-a', '-s', `-screen 0 ${w}x${h}x24`, 'bash', '-c', script], { stdio: 'inherit' });
} finally {
  fake.kill();
}
console.log(out);

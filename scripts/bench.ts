// Mesures de performance de l'app sur des données réelles, sans WhatsApp ni écran visible.
// Usage : node scripts/bench.ts [--chat "nom"] [--runs 5] [--launches 3] [--size 1920x1080] [--screen] [--db chemin/wa.db | --demo]
//   Copie cohérente (lecture seule) de la base (défaut : celle du démon,
//   $XDG_DATA_HOME/wa-gnome/wa.db), servie par le faux démon ; l'app tourne sur un écran virtuel
//   (Xvfb) et écrit ses chronos (src/app/Perf.ts) : temps jusqu'à l'affichage de la liste, puis
//   de chaque ouverture de la discussion choisie (`--launches` lancements pour la liste, les
//   ouvertures au dernier). Copies effacées à la fin.
//   --demo : discussions de démonstration seules (défaut de --chat alors : « Claire »).
//   --screen : sur l'écran de la session (vrai rendu, carte graphique) au lieu de l'écran virtuel
//   (rendu logiciel, plus lent) : une fenêtre s'ouvre le temps de la mesure. À lancer par
//   l'utilisateur lui-même, jamais par un agent. Toujours sur la copie : rien n'est envoyé.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { buildApp } from './build.ts';

const root = path.resolve(import.meta.dirname, '..');
const { values } = parseArgs({
  options: {
    chat: { type: 'string' },
    runs: { type: 'string', default: '5' },
    launches: { type: 'string', default: '3' },
    // taille de la fenêtre (écran virtuel à la même taille)
    size: { type: 'string', default: '1400x900' },
    db: { type: 'string' },
    demo: { type: 'boolean', default: false },
    screen: { type: 'boolean', default: false },
  },
});
const dataHome = process.env['XDG_DATA_HOME'] ?? path.join(os.homedir(), '.local', 'share');
const source = values.demo ? null : (values.db ?? path.join(dataHome, 'wa-gnome', 'wa.db'));
const launches = Math.max(1, Number(values.launches) || 3);
const chat = values.chat ?? (values.demo ? 'Claire' : 'ERETZ HEMDA');

/** Port libre (attribué par le système). */
const freePort = (): Promise<string> =>
  new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      srv.close(() => resolve(typeof addr === 'object' && addr !== null ? String(addr.port) : '4797'));
    });
  });

const median = (xs: readonly number[]): number => {
  const s = xs.toSorted((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
};

// dossier privé : la copie contient les messages de l'utilisateur
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-gnome-bench-'));
const copy = path.join(work, 'source.db');
const dir = path.join(work, 'data');
let fake: ReturnType<typeof spawn> | null = null;
try {
  if (source !== null) {
    if (!fs.existsSync(source)) throw new Error(`base introuvable : ${source} (--db ou --demo)`);
    // instantané cohérent même pendant que le démon écrit (journal WAL compris)
    const db = new DatabaseSync(source, { readOnly: true });
    db.prepare('VACUUM INTO ?').run(copy);
    db.close();
  }
  await buildApp();
  const port = await freePort();
  fake = spawn(process.execPath, [path.join(root, 'scripts', 'fake-daemon.ts'), '--port', port, '--dir', dir, '--no-replies', ...(source === null ? [] : ['--db', copy])], { stdio: 'ignore' });
  // le faux démon est prêt quand son jeton est écrit et qu'il répond
  for (let i = 0; i < 100; i += 1) {
    // oxlint-disable-next-line no-await-in-loop -- attente, une tentative après l'autre
    const up = await fetch(`http://127.0.0.1:${port}/status`, { headers: { Authorization: 'Bearer fake-token' } }).then(
      (r) => r.ok,
      () => false,
    );
    if (up) break;
    // oxlint-disable-next-line no-await-in-loop -- attente, une tentative après l'autre
    await new Promise((resolve) => {
      setTimeout(resolve, 200);
    });
  }
  const script = [
    // écran virtuel : X11, rendu logiciel ; écran de la session : réglages de la session
    values.screen ? `export GTK_A11Y=none GIO_USE_VFS=local` : `export GDK_BACKEND=x11 GSK_RENDERER=cairo GTK_A11Y=none GDK_DEBUG=no-portals GIO_USE_VFS=local`,
    `export WA_GNOME_SILENT=1 PULSE_SERVER=unix:/nonexistent PIPEWIRE_REMOTE=wa-gnome-none`,
    `export WA_GNOME_URL=http://127.0.0.1:${port} WA_GNOME_DATA_DIR="$BENCH_DIR" WA_GNOME_APP_ID=io.github.maarekj.WaGnome.Bench`,
    `export WA_GNOME_PERF=1 WA_GNOME_PERF_CHAT="$BENCH_CHAT" WA_GNOME_PERF_SIZE=${values.size}`,
    // lancements successifs : liste mesurée à chacun, ouvertures au dernier seulement
    `for i in $(seq 1 ${launches}); do`,
    `  if [ "$i" = "$BENCH_LAUNCHES" ]; then export WA_GNOME_PERF_RUNS=${Number(values.runs) || 5}; else export WA_GNOME_PERF_RUNS=0; fi`,
    `  timeout 300 dbus-run-session -- gjs -m "$BENCH_MAIN" 2>&1 | grep --line-buffered '^PERF'`,
    'done',
  ].join('\n');
  const [command, args] = values.screen ? ['bash', ['-c', script]] : ['xvfb-run', ['-a', '-s', `-screen 0 ${values.size}x24`, 'bash', '-c', script]];
  const out = execFileSync(command, args, {
    encoding: 'utf8',
    env: { ...process.env, BENCH_LAUNCHES: String(launches), BENCH_DIR: dir, BENCH_CHAT: chat, BENCH_MAIN: path.join(root, 'dist', 'app', 'main.js') },
  });
  const timings = (label: string): number[] =>
    out
      .split('\n')
      .filter((l) => l.startsWith(`PERF ${label} `))
      .map((l) => Number(l.split(' ')[2]));
  for (const l of out.split('\n').filter((x) => x.startsWith('PERF erreur'))) console.error(l);
  const list = timings('liste');
  const opens = timings('ouverture');
  const complete = timings('complète');
  const shifted = timings('décalées');
  const blocked = timings('bloquée');
  console.log(`base : ${source ?? 'démonstration'} · ${values.screen ? 'écran de la session' : 'écran virtuel (rendu logiciel)'} · fenêtre ${values.size}`);
  console.log(`liste des discussions affichée : ${list.join(', ')} ms (médiane ${median(list)} ms)`);
  console.log(`ouverture de « ${chat} » : ${opens.join(', ')} ms (médiane ${median(opens)} ms, ${opens.length} passes)`);
  console.log(`  tous ses messages affichés : ${complete.join(', ')} ms (médiane ${median(complete)} ms)`);
  console.log(`  plus longue image (app bloquée) : ${blocked.join(', ')} ms (médiane ${median(blocked)} ms)`);
  // doit rester à 0 : sinon la conversation « saute » à l'ouverture
  console.log(`  images décalées (sauts visibles) : ${shifted.join(', ')}`);
  if (out.split('\n').filter((l) => l === 'PERF fin').length < launches) process.exitCode = 1;
} finally {
  fake?.kill();
  fs.rmSync(work, { recursive: true, force: true });
}

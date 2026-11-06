// Démon wa-gnome : connexion WhatsApp (Baileys) et API locale pour l'application.
// Exécuté directement par Node 24 (`node src/daemon/main.ts`), en service systemd utilisateur.
// Environnement :
//   WA_GNOME_DATA_DIR  dossier des données (défaut : $XDG_DATA_HOME/wa-gnome)
//   WA_GNOME_HOST      adresse d'écoute (défaut : 127.0.0.1)
//   WA_GNOME_PORT      port (défaut : 4180)
//   WA_GNOME_LOG       niveau de journal de Baileys (défaut : warn)
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_PORT, TOKEN_FILE } from '../shared/api.ts';
import { type Server, startServer } from './server.ts';
import { Store } from './store.ts';
import { WhatsApp } from './whatsapp.ts';

const dataDir = process.env['WA_GNOME_DATA_DIR'] ?? path.join(process.env['XDG_DATA_HOME'] ?? path.join(os.homedir(), '.local', 'share'), 'wa-gnome');
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });

/** Jeton d'accès à l'API : créé au premier lancement, lisible par l'utilisateur seul. */
function token(): string {
  const file = path.join(dataDir, TOKEN_FILE);
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing !== '') return existing;
  } catch {
    // absent : créé ci-dessous
  }
  const fresh = randomBytes(32).toString('hex');
  fs.writeFileSync(file, `${fresh}\n`, { mode: 0o600 });
  return fresh;
}

const store = new Store(path.join(dataDir, 'wa.db'));
let server: Server | null = null;
const wa = new WhatsApp(store, dataDir, (e) => server?.emit(e));
if (store.needsMediaBackfill) wa.backfillMedia();
wa.backfillQuoted();
wa.backfillReactions();
server = await startServer({
  host: process.env['WA_GNOME_HOST'] ?? '127.0.0.1',
  port: Number(process.env['WA_GNOME_PORT'] ?? DEFAULT_PORT),
  token: token(),
  store,
  wa: () => wa,
});
console.log(`wa-gnome : démon prêt (${dataDir})`);
await wa.start();

const shutdown = (): void => {
  wa.stop();
  const s = server;
  server = null;
  void s?.close().finally(() => {
    store.close();
    process.exit(0);
  });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

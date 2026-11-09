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
import { DEFAULT_ACCOUNT, DEFAULT_PORT, TOKEN_FILE } from '../shared/api.ts';
import { type Account, type Accounts, type Server, startServer } from './server.ts';
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

/** Comptes ajoutés : un dossier chacun (le compte par défaut occupe le dossier racine). */
const accountsDir = path.join(dataDir, 'accounts');
const dirOf = (id: string): string => (id === DEFAULT_ACCOUNT ? dataDir : path.join(accountsDir, id));
const live = new Map<string, Account & { wa: WhatsApp }>();
let server: Server | null = null;

/** Ouvre la base et la connexion d'un compte (démarrée par l'appelant). */
function load(id: string): WhatsApp {
  const dir = dirOf(id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const store = new Store(path.join(dir, 'wa.db'));
  const wa = new WhatsApp(store, dir, (e) => server?.emit(id, e));
  if (store.needsMediaBackfill) wa.backfillMedia();
  wa.backfillQuoted();
  wa.backfillReactions();
  wa.backfillReceipts();
  wa.moveBroadcasts();
  live.set(id, { store, wa });
  return wa;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const accounts: Accounts = {
  get: (id) => live.get(id),
  ids: () => [...live.keys()],
  add: () => {
    // identifiant croissant : les comptes restent dans l'ordre d'ajout
    const id = Date.now().toString(36);
    const wa = load(id);
    wa.start().catch((error: unknown) => console.error(`compte ${id} :`, error));
    return Promise.resolve(id);
  },
  remove: async (id) => {
    const a = live.get(id);
    if (a === undefined || id === DEFAULT_ACCOUNT) return;
    // appairé mais hors ligne : impossible de le déconnecter du téléphone, retrait refusé
    if (a.wa.status.me !== null && a.wa.status.state !== 'open') throw new Error('compte hors ligne : attendre sa reconnexion pour le déconnecter de ce poste');
    // retiré tout de suite : un second retrait ou une requête ne le trouve plus
    live.delete(id);
    a.wa.retire();
    if (a.wa.status.state === 'open') {
      await a.wa.logout().catch((error: unknown) => console.error(`déconnexion du compte ${id} :`, error));
      // fermeture de la session (effacement par Baileys) avant de fermer la base
      for (let i = 0; i < 25 && a.wa.status.state === 'open'; i += 1) await sleep(200); // oxlint-disable-line no-await-in-loop -- attente bornée de la fermeture
    }
    a.wa.stop();
    // base fermée un peu plus tard : événements et requêtes en cours terminés
    setTimeout(() => {
      a.store.close();
      fs.rmSync(dirOf(id), { recursive: true, force: true });
    }, 5000);
  },
};

const saved = (() => {
  try {
    return fs.readdirSync(accountsDir).filter((d) => fs.statSync(path.join(accountsDir, d)).isDirectory()).toSorted();
  } catch {
    return [];
  }
})();
for (const id of [DEFAULT_ACCOUNT, ...saved]) load(id);
server = await startServer({
  host: process.env['WA_GNOME_HOST'] ?? '127.0.0.1',
  port: Number(process.env['WA_GNOME_PORT'] ?? DEFAULT_PORT),
  token: token(),
  accounts,
});
console.log(`wa-gnome : démon prêt (${dataDir}, ${live.size} compte(s))`);
await Promise.all([...live].map(([id, a]) => a.wa.start().catch((error: unknown) => console.error(`compte ${id} :`, error))));

const shutdown = (): void => {
  for (const a of live.values()) a.wa.stop();
  const s = server;
  server = null;
  void s?.close().finally(() => {
    for (const a of live.values()) a.store.close();
    process.exit(0);
  });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

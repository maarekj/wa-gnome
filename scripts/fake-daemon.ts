// Faux démon : même API que src/daemon (vrai serveur HTTP, vrai Store SQLite), sans WhatsApp.
// Discussions de démonstration, réponses automatiques. Pour les captures et les tests de l'app.
// Usage : node scripts/fake-daemon.ts [--state open|qr|connecting] [--port 4798] [--dir /tmp/…]
// Le jeton est écrit dans <dir>/token : lancer l'app avec WA_GNOME_DATA_DIR=<dir> WA_GNOME_URL=….
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { ConnectionState, type Event, type Message, TOKEN_FILE, type Status } from '../src/shared/api.ts';
import { type Backend, type Server, startServer } from '../src/daemon/server.ts';
import { Store } from '../src/daemon/store.ts';

const { values } = parseArgs({
  options: {
    state: { type: 'string', default: 'open' },
    port: { type: 'string', default: '4798' },
    dir: { type: 'string', default: path.join(os.tmpdir(), 'wa-gnome-fake') },
  },
});
const dir = values.dir;
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
const token = 'fake-token';
fs.writeFileSync(path.join(dir, TOKEN_FILE), token);

const store = new Store(path.join(dir, 'wa.db'));
const now = Math.floor(Date.now() / 1000);
const H = 3600;
let seq = 0;
const add = (chatId: string, fromMe: boolean, text: string, ago: number, sender: string | null = null, senderName: string | null = null): Message => {
  seq += 1;
  const m: Message = { id: `fake${seq}`, chatId, fromMe, sender, senderName, timestamp: now - ago, kind: 'text', text };
  store.upsertMessage(m, '{}');
  return m;
};
const ALICE = '33600000001@s.whatsapp.net';
const BOB = '33600000002@s.whatsapp.net';
const GROUP = '120363000000000001@g.us';
store.upsertContact(ALICE, 'Alice Martin');
store.upsertContact(BOB, 'Bob');
store.upsertChat({ id: GROUP, name: 'Famille' });
add(ALICE, false, 'Salut ! Tu es dispo ce soir ?', 30 * H);
add(ALICE, true, 'Oui, vers 20h ça te va ?', 29 * H);
add(ALICE, false, 'Parfait, à tout à l’heure', 2 * H);
add(GROUP, false, 'Qui vient dimanche ?', 3 * H, BOB, 'Bob');
add(GROUP, true, 'Moi !', 3 * H - 60);
add(GROUP, false, 'Je ramène le dessert', 50 * 60, ALICE, 'Alice');
store.upsertChat({ id: GROUP, unread: 1 });
add(BOB, false, 'Tu as vu le match hier ?', 9 * 24 * H);

let server: Server | null = null;
const emit = (e: Event): void => server?.emit(e);
let status: Status = { state: ConnectionState.parse(values.state), qr: values.state === 'qr' ? 'https://wa.me/settings/linked_devices#fake-qr-code' : null, me: values.state === 'open' ? { id: '33600000000@s.whatsapp.net', name: 'Moi' } : null, error: null };

const backend: Backend = {
  get status() {
    return status;
  },
  send: (chatId, text) => {
    const m = add(chatId, true, text, 0);
    emit({ type: 'message', message: m });
    emit({ type: 'chats', chats: [store.chat(chatId)].filter((c) => c !== null) });
    // réponse automatique
    setTimeout(() => {
      const r = add(chatId, false, `Bien reçu : « ${text} »`, 0);
      if (chatId === GROUP) store.incrementUnread(chatId);
      emit({ type: 'message', message: r });
      emit({ type: 'chats', chats: [store.chat(chatId)].filter((c) => c !== null) });
    }, 1500);
    return Promise.resolve();
  },
  markRead: (chatId) => {
    store.markRead(chatId);
    emit({ type: 'chats', chats: [store.chat(chatId)].filter((c) => c !== null) });
    return Promise.resolve();
  },
  logout: () => {
    store.clear();
    status = { state: 'qr', qr: 'https://wa.me/settings/linked_devices#fake-after-logout', me: null, error: null };
    emit({ type: 'status', status });
    return Promise.resolve();
  },
};

server = await startServer({ host: '127.0.0.1', port: Number(values.port), token, store, wa: () => backend });
console.log(`faux démon : http://127.0.0.1:${values.port} (WA_GNOME_DATA_DIR=${dir})`);

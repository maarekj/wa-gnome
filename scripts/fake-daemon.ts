// Faux démon : même API que src/daemon (vrai serveur HTTP, vrai Store SQLite), sans WhatsApp.
// Discussions de démonstration, réponses automatiques. Pour les captures et les tests de l'app.
// Usage : node scripts/fake-daemon.ts [--state open|qr|connecting] [--port 4798] [--dir /tmp/…]
// Le jeton est écrit dans <dir>/token : lancer l'app avec WA_GNOME_DATA_DIR=<dir> WA_GNOME_URL=….
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { deflateSync } from 'node:zlib';
import { ConnectionState, type Event, type Media, type Message, type MessageKind, TOKEN_FILE, type Status, uploadKind } from '../src/shared/api.ts';
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
// ---------------------------------------------------------------- images de démonstration (PNG)

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = (c & 1) === 1 ? 0xed_b8_83_20 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf: Buffer): number => {
  let c = 0xff_ff_ff_ff;
  for (const b of buf) c = (CRC[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xff_ff_ff_ff) >>> 0;
};
const chunk = (type: string, data: Buffer): Buffer => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
/** PNG RVBA généré pixel par pixel. */
const png = (w: number, h: number, pixel: (x: number, y: number) => [number, number, number, number]): Buffer => {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y += 1) {
    raw[y * (w * 4 + 1)] = 0;
    for (let x = 0; x < w; x += 1) raw.set(pixel(x, y), y * (w * 4 + 1) + 1 + x * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
};
/** Paysage : ciel en dégradé, soleil, collines. */
const landscape = (w: number, h: number): Buffer =>
  png(w, h, (x, y) => {
    const u = x / w;
    const v = y / h;
    const hill = 0.62 + 0.08 * Math.sin(u * 7) + 0.05 * Math.sin(u * 17 + 1);
    if (v > hill) return [40 + 30 * v, 120 + 40 * Math.sin(u * 5), 60, 255];
    if ((u - 0.72) ** 2 + ((v - 0.3) * (h / w)) ** 2 < 0.006) return [255, 220, 90, 255];
    return [90 + 120 * v, 150 + 80 * v, 235, 255];
  });
/** Autocollant : disque souriant sur fond transparent. */
const sticker = (s: number): Buffer =>
  png(s, s, (x, y) => {
    const dx = x / s - 0.5;
    const dy = y / s - 0.5;
    const r = Math.hypot(dx, dy);
    if (r > 0.45) return [0, 0, 0, 0];
    const eye = Math.hypot(Math.abs(dx) - 0.15, dy + 0.1) < 0.05;
    const mouth = dy > 0.05 && Math.abs(r - 0.25) < 0.03;
    return eye || mouth ? [60, 40, 20, 255] : [255, 200, 40, 255];
  });

/** Son WAV (PCM 16 bits mono) : petite mélodie. */
const wav = (seconds: number): Buffer => {
  const rate = 16_000;
  const n = rate * seconds;
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i += 1) {
    const f = [440, 554, 659][Math.floor((i / rate) * 2) % 3] ?? 440;
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * f * i) / rate) * 8000 * Math.min(1, (n - i) / 2000)), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
};

/** PDF d'une page avec un texte. */
const pdf = (text: string): Buffer => {
  const stream = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
};

/** Courte vidéo WebM générée par GStreamer s'il est installé (shell devenv), sinon vide. */
const video = (): Buffer => {
  const file = path.join(os.tmpdir(), `wa-gnome-fake-${process.pid}.webm`);
  const res = spawnSync('gst-launch-1.0', ['-q', 'videotestsrc', 'num-buffers=90', 'pattern=ball', '!', 'video/x-raw,width=480,height=320', '!', 'vp8enc', '!', 'webmmux', '!', 'filesink', `location=${file}`]);
  if (res.status !== 0) return Buffer.alloc(0);
  const data = fs.readFileSync(file);
  fs.rmSync(file, { force: true });
  return data;
};

/** Médias des messages de démonstration (id → contenu). */
const media = new Map<string, { mimetype: string; data: Buffer }>();

const add = (chatId: string, fromMe: boolean, text: string, ago: number, sender: string | null = null, senderName: string | null = null, attached: { kind: MessageKind; media: Media; data: Buffer } | null = null): Message => {
  seq += 1;
  const id = `fake${seq}`;
  if (attached !== null) media.set(id, { mimetype: attached.media.mimetype, data: attached.data });
  const m: Message = { id, chatId, fromMe, sender, senderName, timestamp: now - ago, kind: attached?.kind ?? 'text', text, media: attached?.media ?? null };
  store.upsertMessage(m, '{}');
  return m;
};
const ALICE = '33600000001@s.whatsapp.net';
const BOB = '33600000002@s.whatsapp.net';
const GROUP = '120363000000000001@g.us';
store.upsertContact(ALICE, { name: 'Alice Martin' });
// absent du carnet : nom public seulement (« ~ Bob »)
store.upsertContact(BOB, { notify: 'Bob' });
store.upsertChat({ id: GROUP, name: 'Famille' });
add(ALICE, false, 'Salut ! Tu es dispo ce soir ?', 30 * H);
add(ALICE, true, 'Oui, vers 20h ça te va ?', 29 * H);
add(ALICE, false, 'Parfait, à tout à l’heure', 2 * H);
const photo = { mimetype: 'image/png', width: 960, height: 600, thumbnail: landscape(48, 30).toString('base64'), fileName: null, size: null, seconds: null };
add(ALICE, false, 'La vue depuis le chalet', 2 * H - 120, null, null, { kind: 'image', media: photo, data: landscape(960, 600) });
add(ALICE, true, '', 2 * H - 60, null, null, { kind: 'image', media: { ...photo, width: 400, height: 700, thumbnail: null }, data: landscape(400, 700) });
add(GROUP, false, 'Qui vient dimanche ?', 3 * H, BOB, 'Bob');
add(GROUP, true, 'Moi !', 3 * H - 60);
add(GROUP, false, 'Je ramène le dessert', 50 * 60, ALICE, 'Alice');
add(GROUP, false, '', 49 * 60, BOB, 'Bob', { kind: 'sticker', media: { mimetype: 'image/png', width: 512, height: 512, thumbnail: null, fileName: null, size: null, seconds: null }, data: sticker(512) });
store.upsertChat({ id: GROUP, unread: 1 });
add(BOB, false, 'Tu as vu le match hier ?', 9 * 24 * H);
const none = { width: null, height: null, thumbnail: null, fileName: null, size: null, seconds: null };
const doc = pdf('Menu du dimanche');
add(GROUP, false, '', 40 * 60, ALICE, 'Alice', { kind: 'document', media: { ...none, mimetype: 'application/pdf', fileName: 'Menu du dimanche.pdf', size: doc.length }, data: doc });
const voice = wav(4);
add(GROUP, false, '', 30 * 60, BOB, 'Bob', { kind: 'audio', media: { ...none, mimetype: 'audio/wav', seconds: 4 }, data: voice });
add(GROUP, false, 'Le chat du voisin', 20 * 60, BOB, 'Bob', { kind: 'video', media: { ...none, mimetype: 'video/webm', width: 480, height: 320, seconds: 3, thumbnail: landscape(48, 32).toString('base64') }, data: video() });
const SHOP = '33600000004@s.whatsapp.net';
const NEWS = '120363000000000002@g.us';
store.upsertContact(SHOP, { name: 'Boulangerie' });
add(SHOP, false, 'Votre commande est prête', 20 * 24 * H);
store.upsertChat({ id: SHOP, archived: true });
store.upsertChat({ id: NEWS, name: 'Voisins', mutedUntil: -1 });
add(NEWS, false, 'Ramassage des encombrants jeudi', 5 * H, BOB, 'Bob');
add(NEWS, false, 'Merci pour l’info', 4 * H, ALICE, 'Alice');
store.upsertChat({ id: NEWS, unread: 2 });
store.upsertChat({ id: ALICE, pinned: Date.now() });
// listes, comme celles de WhatsApp : filtres prédéfinis et une liste personnalisée
for (const [i, [name, type]] of ([['Non lues', 1], ['Favoris', 3], ['Groupes', 2], ['Voisinage', 5]] as const).entries()) store.upsertLabel({ id: String(i + 1), name, listType: type, orderIndex: i });
store.setChatLabel(NEWS, '4', true);
store.setChatLabel(BOB, '4', true);
store.setFavorites([GROUP]);

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
  chatAction: (chatId, a) => {
    switch (a.action) {
      case 'archive':
        store.upsertChat({ id: chatId, archived: a.value });
        break;
      case 'mute':
        store.upsertChat({ id: chatId, mutedUntil: a.until ?? 0 });
        break;
      case 'pin':
        store.upsertChat({ id: chatId, pinned: a.value ? Date.now() : 0 });
        break;
      case 'unread':
        if (a.value) store.upsertChat({ id: chatId, markedUnread: true });
        else store.markRead(chatId);
        break;
      case 'clear':
        store.clearMessages(chatId);
        emit({ type: 'chat.cleared', id: chatId });
        break;
      case 'delete':
        store.deleteChats([chatId]);
        emit({ type: 'chats.delete', ids: [chatId] });
        return Promise.resolve();
      case 'leave':
        break;
      case 'favorite': {
        const ids = store.favorites().filter((id) => id !== chatId);
        store.setFavorites(a.value ? [...ids, chatId] : ids);
        break;
      }
      case 'label':
        store.setChatLabel(chatId, a.labelId, a.value);
        break;
      default:
        a satisfies never;
    }
    emit({ type: 'chats', chats: [store.chat(chatId)].filter((c) => c !== null) });
    return Promise.resolve();
  },
  // photo : Alice (paysage) et le groupe Famille (autocollant) ; les autres n'en ont pas
  picture: (chatId) => Promise.resolve(chatId === ALICE ? landscape(96, 96) : chatId === GROUP ? sticker(96) : null),
  sendMedia: (chatId, f) => {
    const kind = uploadKind(f.mimetype, f.asDocument);
    const m = add(chatId, true, f.caption, 0, null, null, {
      kind,
      media: { mimetype: f.mimetype, width: null, height: null, thumbnail: null, fileName: kind === 'document' ? f.fileName : null, size: f.data.length, seconds: null },
      data: f.data,
    });
    emit({ type: 'message', message: m });
    emit({ type: 'chats', chats: [store.chat(chatId)].filter((c) => c !== null) });
    return Promise.resolve();
  },
  media: (_chatId, id) => {
    const found = media.get(id);
    return found === undefined ? Promise.reject(new Error('média introuvable')) : Promise.resolve(found);
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

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
import { ConnectionState, type Event, type Media, type Message, type MessageKind, type Presence, TOKEN_FILE, type Status, uploadKind } from '../src/shared/api.ts';
import { type Backend, type Server, startServer } from '../src/daemon/server.ts';
import type { Converted } from '../src/daemon/convert.ts';
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

/** Citation d'un message existant (réponse), au format stocké. */
const quote = (chatId: string, id: string | undefined): Converted['quoted'] => {
  const q = id === undefined ? null : store.message(chatId, id);
  // « moi » : pas d'auteur dans une discussion directe, numéro du compte sinon
  return q === null ? null : { id: q.id, sender: q.fromMe ? ME : q.sender, kind: q.kind, text: q.text };
};

const add = (
  chatId: string,
  fromMe: boolean,
  text: string,
  ago: number,
  sender: string | null = null,
  senderName: string | null = null,
  attached: { kind: MessageKind; media: Media; data: Buffer } | null = null,
  replyTo?: string,
  forwarded = 0,
): Message => {
  seq += 1;
  const id = `fake${seq}`;
  if (attached !== null) media.set(id, { mimetype: attached.media.mimetype, data: attached.data });
  store.upsertMessage({ id, chatId, fromMe, sender, senderName, timestamp: now - ago, kind: attached?.kind ?? 'text', text, media: attached?.media ?? null, quoted: quote(chatId, replyTo), status: fromMe ? (ago === 0 ? 'pending' : 'read') : null, forwarded }, '{}');
  const m = store.message(chatId, id);
  if (m === null) throw new Error('message de démonstration introuvable');
  return m;
};
const ME = '33600000000@s.whatsapp.net';
store.setMe([ME]);
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
const moi = add(GROUP, true, 'Moi !', 3 * H - 60);
store.setReceipt({ chatId: GROUP, messageId: moi.id, user: BOB, delivered: now - 3 * H + 30, read: now - 3 * H + 120 });
store.setReceipt({ chatId: GROUP, messageId: moi.id, user: ALICE, delivered: now - 3 * H + 40, read: now - 2 * H });
// message modifié et message supprimé par Bob (démonstration)
const dimanche = add(GROUP, false, 'Qui vient dimanhce ?', 3 * H + 30, BOB, 'Bob');
store.applyEdit(GROUP, dimanche.id, 'Qui vient dimanche midi ?');
const oups = add(GROUP, false, 'Message envoyé par erreur', 3 * H + 20, BOB, 'Bob');
store.applyRevoke(GROUP, oups.id);
const dessert = add(GROUP, false, 'Je ramène le dessert', 50 * 60, ALICE, 'Alice', null, moi.id);
// réactions de démonstration
for (const [sender, emoji] of [[BOB, '❤️'], [ME, '❤️'], [ALICE, '😂']] as const) store.setReaction({ chatId: GROUP, targetId: dessert.id, sender: sender === ME ? 'me' : sender, emoji, timestamp: Date.now() });
add(GROUP, false, '', 49 * 60, BOB, 'Bob', { kind: 'sticker', media: { mimetype: 'image/png', width: 512, height: 512, thumbnail: null, fileName: null, size: null, seconds: null }, data: sticker(512) });
store.upsertChat({ id: GROUP, unread: 1 });
// mise en forme WhatsApp
add(BOB, true, 'Pour samedi : *rendez-vous à 14 h*, _pas avant_, ~dimanche~ et le code `A1B2`\n> Il a dit : prends les places\n1. Billets\n2. Écharpes\n* parking\n- sandwichs\n```\nporte = 12\n```', 9 * 24 * H + 120);
add(BOB, false, 'Oublie pas Naomie', 9 * 24 * H + 60, null, null, null, undefined, 1);
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

/** longue discussion : de quoi remonter dans l'historique local (pagination) */
const LONG = '33600000005@s.whatsapp.net';
store.upsertContact(LONG, { name: 'Claire (longue discussion)' });
for (let i = 150; i >= 1; i -= 1) add(LONG, i % 2 === 0, `Message n° ${151 - i}`, 3 * H + i * 600);
const historyGiven = new Set<string>();

/** Présence simulée d'une discussion ; `typing` : le correspondant (ou Bob dans un groupe) écrit. */
const fakePresence = (chatId: string, typing: boolean): Presence => ({
  online: chatId === ALICE || (typing && !chatId.endsWith('@g.us')),
  lastSeen: chatId === BOB ? now - 2 * H : null,
  typing: typing ? [{ name: chatId.endsWith('@g.us') ? 'Bob' : (store.chat(chatId)?.name ?? ''), recording: false }] : [],
});

/** Coches d'un message envoyé : envoyé, reçu, puis lu (comme un vrai correspondant). */
const progress = (chatId: string, id: string): void => {
  for (const [delay, status] of [[1000, 'sent'], [3000, 'delivered'], [5000, 'read']] as const) {
    setTimeout(() => {
      store.setStatus(chatId, id, status);
      // destinataires : la personne, ou deux membres du groupe (Bob lit, Alice seulement distribué)
      const t = Math.floor(Date.now() / 1000);
      const users = chatId === GROUP ? [BOB, ALICE] : [chatId];
      for (const user of users) store.setReceipt({ chatId, messageId: id, user, delivered: status === 'sent' ? null : t, read: status === 'read' && user !== ALICE ? t : null });
      const m = store.message(chatId, id);
      if (m !== null) emit({ type: 'message.update', message: m });
    }, delay);
  }
};

let server: Server | null = null;
const emit = (e: Event): void => server?.emit(e);
let status: Status = { state: ConnectionState.parse(values.state), qr: values.state === 'qr' ? 'https://wa.me/settings/linked_devices#fake-qr-code' : null, me: values.state === 'open' ? { id: '33600000000@s.whatsapp.net', name: 'Moi' } : null, error: null };

const backend: Backend = {
  get status() {
    return status;
  },
  send: (chatId, text, replyTo) => {
    const m = add(chatId, true, text, 0, null, null, null, replyTo);
    progress(chatId, m.id);
    emit({ type: 'message', message: m });
    emit({ type: 'chats', chats: [store.chat(chatId)].filter((c) => c !== null) });
    // le correspondant écrit, puis répond
    setTimeout(() => emit({ type: 'presence', chatId, presence: fakePresence(chatId, true) }), 2000);
    setTimeout(() => emit({ type: 'presence', chatId, presence: fakePresence(chatId, false) }), 5900);
    // réponse automatique
    setTimeout(() => {
      // la réponse automatique cite le message envoyé
      const r = add(chatId, false, `Bien reçu : « ${text} »`, 0, chatId === GROUP ? BOB : null, chatId === GROUP ? 'Bob' : null, null, m.id);
      if (chatId === GROUP) store.incrementUnread(chatId);
      emit({ type: 'message', message: r });
      emit({ type: 'chats', chats: [store.chat(chatId)].filter((c) => c !== null) });
    }, 6000);
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
  // historique : le faux téléphone renvoie 20 messages plus anciens, une seule fois par discussion
  requestHistory: (chatId) => {
    if (historyGiven.has(chatId)) return Promise.resolve(false);
    historyGiven.add(chatId);
    const oldest = store.messages(chatId, 10_000)[0]?.timestamp ?? now;
    const ids: string[] = [];
    setTimeout(() => {
      for (let i = 20; i >= 1; i -= 1) ids.push(add(chatId, i % 3 === 0, `Message ancien n° ${i}`, now - oldest + i * 3600).id);
      emit({ type: 'history', ids: [chatId] });
    }, 800);
    return Promise.resolve(true);
  },
  // présence : Alice en ligne, Bob vu il y a 2 h ; les autres sans information
  subscribe: (chatId) => Promise.resolve(fakePresence(chatId, false)),
  setOnline: () => Promise.resolve(),
  typing: () => Promise.resolve(),
  messageAction: (chatId, messageId, a) => {
    if (a.action === 'forward') {
      const m = store.message(chatId, messageId);
      if (m === null) return Promise.reject(new Error('message introuvable'));
      const data = media.get(messageId)?.data;
      for (const to of a.to) {
        const copy = add(to, true, m.text, 0, null, null, m.media === null || data === undefined ? null : { kind: m.kind, media: m.media, data }, undefined, m.forwarded + 1);
        progress(to, copy.id);
        emit({ type: 'message', message: copy });
        emit({ type: 'chats', chats: [store.chat(to)].filter((c) => c !== null) });
      }
      return Promise.resolve();
    }
    if (a.action === 'delete-for-me') {
      store.deleteForMe(chatId, messageId);
      emit({ type: 'message.delete', chatId, id: messageId });
    } else {
      if (a.action === 'edit') store.applyEdit(chatId, messageId, a.text);
      else store.applyRevoke(chatId, messageId);
      const m = store.message(chatId, messageId);
      if (m !== null) emit({ type: 'message.update', message: m });
    }
    emit({ type: 'chats', chats: [store.chat(chatId)].filter((c) => c !== null) });
    return Promise.resolve();
  },
  messageInfo: (chatId, messageId) => ({ receipts: store.receipts(chatId, messageId) }),
  react: (chatId, messageId, emoji) => {
    store.setReaction({ chatId, targetId: messageId, sender: 'me', emoji, timestamp: Date.now() });
    const m = store.message(chatId, messageId);
    if (m !== null) emit({ type: 'message.update', message: m });
    return Promise.resolve();
  },
  sendMedia: (chatId, f) => {
    const kind = uploadKind(f.mimetype, f.asDocument);
    const m = add(chatId, true, f.caption, 0, null, null, {
      kind,
      media: { mimetype: f.mimetype, width: null, height: null, thumbnail: null, fileName: kind === 'document' ? f.fileName : null, size: f.data.length, seconds: null },
      data: f.data,
    }, f.replyTo);
    progress(chatId, m.id);
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

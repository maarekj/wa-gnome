// Connexion WhatsApp (Baileys, protocole multi-appareils) : appairage, reconnexion, et
// recopie des discussions et messages reçus dans le Store.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  BufferJSON,
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
  makeWASocket,
  normalizeMessageContent,
  useMultiFileAuthState,
  proto,
  type WAMessage,
  type WASocket,
} from 'baileys';
import pino from 'pino';
import type { Event, Status } from '../shared/api.ts';
import { mediaOf, seconds, toMessage } from './convert.ts';
import type { Store } from './store.ts';

const logger = pino({ level: process.env['WA_GNOME_LOG'] ?? 'warn' });

/** Délai avant reconnexion après une coupure (ms). */
const RECONNECT_MS = 3000;

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
/** Code HTTP d'une erreur Boom de Baileys (sans dépendre de @hapi/boom). */
const statusCode = (e: unknown): number | undefined => {
  if (typeof e !== 'object' || e === null || !('output' in e)) return undefined;
  const { output } = e;
  if (typeof output !== 'object' || output === null || !('statusCode' in output)) return undefined;
  return typeof output.statusCode === 'number' ? output.statusCode : undefined;
};

export class WhatsApp {
  readonly #store: Store;
  readonly #authDir: string;
  readonly #mediaDir: string;
  readonly #emit: (e: Event) => void;
  #sock: WASocket | null = null;
  #status: Status = { state: 'starting', qr: null, me: null, error: null };
  #stopped = false;

  constructor(store: Store, dataDir: string, emit: (e: Event) => void) {
    this.#store = store;
    this.#authDir = path.join(dataDir, 'auth');
    this.#mediaDir = path.join(dataDir, 'media');
    this.#emit = emit;
  }

  get status(): Status {
    return this.#status;
  }

  #setStatus(patch: Partial<Status>): void {
    this.#status = { ...this.#status, ...patch };
    this.#emit({ type: 'status', status: this.#status });
  }

  async start(): Promise<void> {
    this.#stopped = false;
    fs.mkdirSync(this.#authDir, { recursive: true, mode: 0o700 });
    const { state, saveCreds } = await useMultiFileAuthState(this.#authDir);
    // version du client web annoncée : la plus récente connue, sinon celle de Baileys
    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));
    const sock = makeWASocket({
      ...(version === undefined ? {} : { version }),
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
      logger,
      browser: Browsers.ubuntu('wa-gnome'),
      // le téléphone reste la source des notifications tant que l'app n'est pas ouverte
      markOnlineOnConnect: false,
      syncFullHistory: false,
      getMessage: (key) => Promise.resolve(this.#rawMessage(key.remoteJid, key.id)),
    });
    this.#sock = sock;
    this.#setStatus({ state: 'connecting', qr: null, error: null });

    sock.ev.on('creds.update', () => {
      saveCreds().catch((error: unknown) => logger.error({ error }, 'creds.update'));
    });

    sock.ev.on('connection.update', (u) => {
      if (u.qr !== undefined) this.#setStatus({ state: 'qr', qr: u.qr });
      if (u.connection === 'open') {
        const me = sock.user;
        this.#setStatus({ state: 'open', qr: null, error: null, me: me === undefined ? null : { id: jidNormalizedUser(me.id), name: me.name ?? me.notify ?? null } });
      }
      if (u.connection === 'close') {
        const code = statusCode(u.lastDisconnect?.error);
        this.#sock = null;
        if (code === DisconnectReason.loggedOut) {
          this.#forget();
          this.#setStatus({ state: 'logged-out', qr: null, me: null, error: null });
          // nouvel appairage : QR code suivant
          if (!this.#stopped) this.#restart(0);
          return;
        }
        this.#setStatus({ state: 'closed', error: u.lastDisconnect?.error === undefined ? null : errorText(u.lastDisconnect.error) });
        // 515 (restartRequired) : normal juste après l'appairage
        if (!this.#stopped) this.#restart(code === DisconnectReason.restartRequired ? 0 : RECONNECT_MS);
      }
    });

    sock.ev.on('messaging-history.set', ({ chats, contacts, messages }) => {
      this.#store.transaction(() => {
        for (const c of contacts) this.#store.upsertContact(jidNormalizedUser(c.id), c.name ?? c.verifiedName ?? c.notify ?? null);
        for (const c of chats) {
          if (c.id === null || c.id === undefined) continue;
          this.#store.upsertChat({ id: jidNormalizedUser(c.id), name: c.name ?? null, unread: c.unreadCount ?? null, timestamp: seconds(c.conversationTimestamp) || null });
        }
        for (const m of messages) this.#saveMessage(m);
      });
      this.#emit({ type: 'chats', chats: this.#store.chats() });
    });

    sock.ev.on('chats.upsert', (chats) => {
      for (const c of chats) {
        if (c.id === null || c.id === undefined) continue;
        this.#store.upsertChat({ id: jidNormalizedUser(c.id), name: c.name ?? null, unread: c.unreadCount ?? null, timestamp: seconds(c.conversationTimestamp) || null });
      }
      this.#emitChats(chats.map((c) => c.id));
    });

    sock.ev.on('chats.update', (updates) => {
      for (const c of updates) {
        if (c.id === null || c.id === undefined) continue;
        this.#store.upsertChat({ id: jidNormalizedUser(c.id), name: c.name ?? null, unread: c.unreadCount ?? null, timestamp: seconds(c.conversationTimestamp) || null });
      }
      this.#emitChats(updates.map((c) => c.id));
    });

    sock.ev.on('chats.delete', (ids) => {
      this.#store.deleteChats(ids);
      this.#emit({ type: 'chats.delete', ids });
    });

    sock.ev.on('contacts.upsert', (contacts) => {
      for (const c of contacts) this.#store.upsertContact(jidNormalizedUser(c.id), c.name ?? c.verifiedName ?? c.notify ?? null);
    });

    sock.ev.on('messages.upsert', ({ messages, type }) => {
      for (const wa of messages) {
        const m = this.#saveMessage(wa);
        if (m === null) continue;
        if (type === 'notify' && !m.fromMe) this.#store.incrementUnread(m.chatId);
        this.#emit({ type: 'message', message: m });
        this.#emitChats([m.chatId]);
      }
    });

    // noms de groupes : pas toujours présents dans l'historique
    sock.ev.on('groups.upsert', (groups) => {
      for (const g of groups) this.#store.upsertChat({ id: g.id, name: g.subject });
      this.#emitChats(groups.map((g) => g.id));
    });
  }

  #saveMessage(wa: WAMessage): ReturnType<typeof toMessage> {
    const m = toMessage(wa);
    if (m !== null) this.#store.upsertMessage(m, JSON.stringify(wa, BufferJSON.replacer));
    return m;
  }

  #parseRaw(raw: string): WAMessage | null {
    const wa: unknown = JSON.parse(raw, BufferJSON.reviver);
    if (typeof wa !== 'object' || wa === null || !('key' in wa)) return null;
    const msg = proto.WebMessageInfo.fromObject(wa);
    const { key } = msg;
    if (key === null || key === undefined) return null;
    return Object.assign(msg, { key });
  }

  /** Base antérieure aux médias : `media` recalculé depuis les messages bruts. */
  backfillMedia(): void {
    const rows = this.#store.mediaToBackfill();
    this.#store.transaction(() => {
      for (const r of rows) {
        const content = normalizeContent(this.#parseRaw(r.raw));
        if (content !== undefined) this.#store.setMedia(r.chatId, r.id, mediaOf(content));
      }
    });
    if (rows.length > 0) logger.info(`médias : ${rows.length} message(s) reconverti(s)`);
  }

  /**
   * Contenu d'un média, téléchargé depuis WhatsApp (déchiffré) puis gardé en cache sur disque.
   * Média expiré sur les serveurs : renvoi demandé au téléphone (connexion ouverte nécessaire).
   */
  async media(chatId: string, id: string): Promise<{ mimetype: string; data: Buffer }> {
    const info = this.#store.media(chatId, id);
    const raw = this.#store.raw(chatId, id);
    if (info === null || raw === null) throw new Error('média introuvable');
    const file = path.join(this.#mediaDir, createHash('sha256').update(`${chatId}/${id}`).digest('hex'));
    try {
      return { mimetype: info.mimetype, data: await fs.promises.readFile(file) };
    } catch {
      // absent du cache : téléchargé ci-dessous
    }
    const wa = this.#parseRaw(raw);
    if (wa === null) throw new Error('message illisible');
    const sock = this.#sock;
    const data = await downloadMediaMessage(wa, 'buffer', {}, sock === null ? undefined : { logger, reuploadRequest: (m) => sock.updateMediaMessage(m) });
    await fs.promises.mkdir(this.#mediaDir, { recursive: true, mode: 0o700 });
    await fs.promises.writeFile(file, data, { mode: 0o600 });
    return { mimetype: info.mimetype, data };
  }

  #rawMessage(jid: string | null | undefined, id: string | null | undefined): proto.IMessage | undefined {
    if (jid === null || jid === undefined || id === null || id === undefined) return undefined;
    const raw = this.#store.raw(jidNormalizedUser(jid), id);
    return raw === null ? undefined : (this.#parseRaw(raw)?.message ?? undefined);
  }

  #emitChats(ids: readonly (string | null | undefined)[]): void {
    const chats = ids.flatMap((id) => {
      if (id === null || id === undefined) return [];
      const c = this.#store.chat(jidNormalizedUser(id));
      return c === null || c.timestamp === 0 ? [] : [c];
    });
    if (chats.length > 0) this.#emit({ type: 'chats', chats });
  }

  #restart(delay: number): void {
    setTimeout(() => {
      this.start().catch((error: unknown) => {
        this.#setStatus({ state: 'closed', error: errorText(error) });
        this.#restart(RECONNECT_MS);
      });
    }, delay);
  }

  /** Session et données locales effacées. */
  #forget(): void {
    fs.rmSync(this.#authDir, { recursive: true, force: true });
    fs.rmSync(this.#mediaDir, { recursive: true, force: true });
    this.#store.clear();
  }

  #open(): WASocket {
    if (this.#sock === null || this.#status.state !== 'open') throw new Error('WhatsApp non connecté');
    return this.#sock;
  }

  async send(chatId: string, text: string): Promise<void> {
    const sent = await this.#open().sendMessage(chatId, { text });
    // le message envoyé revient aussi par messages.upsert ; enregistré ici sans attendre
    if (sent !== undefined) {
      const m = this.#saveMessage(sent);
      if (m !== null) {
        this.#emit({ type: 'message', message: m });
        this.#emitChats([m.chatId]);
      }
    }
  }

  /** Discussion lue : accusés de lecture des derniers messages reçus, compteur remis à zéro. */
  async markRead(chatId: string): Promise<void> {
    this.#store.markRead(chatId);
    this.#emitChats([chatId]);
    const sock = this.#sock;
    if (sock === null || this.#status.state !== 'open') return;
    const keys = this.#store
      .messages(chatId, 20)
      .filter((m) => !m.fromMe)
      .map((m): proto.IMessageKey => (m.sender === null ? { remoteJid: chatId, id: m.id, fromMe: false } : { remoteJid: chatId, id: m.id, fromMe: false, participant: m.sender }));
    if (keys.length > 0) await sock.readMessages(keys);
  }

  /** Déconnexion du compte (l'appareil disparaît de la liste du téléphone). */
  async logout(): Promise<void> {
    await this.#open().logout();
  }

  stop(): void {
    this.#stopped = true;
    // oxlint-disable-next-line unicorn/no-useless-undefined -- paramètre obligatoire (erreur de fermeture)
    void this.#sock?.end(undefined);
    this.#sock = null;
  }
}

const normalizeContent = (wa: WAMessage | null): proto.IMessage | undefined => (wa === null ? undefined : normalizeMessageContent(wa.message));

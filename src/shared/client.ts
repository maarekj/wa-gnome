// Client HTTP + SSE du démon wa-gnome, basé sur libsoup 3 (GJS, sans Node).
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';
import * as z from 'zod/mini';
import { Chat, type ChatAction, ChatInfo, ChatList, Contact, Lookup, DEFAULT_PORT, Event, type GalleryTab, Message, type MessageAction, MessageInfo, Presence, SearchHit, Status, TOKEN_FILE, UPLOAD_AS, UPLOAD_CAPTION, UPLOAD_NAME, UPLOAD_REPLY, UPLOAD_VOICE_SECONDS, UPLOAD_VOICE_WAVEFORM } from './api.ts';
import { errorMessage, HttpError } from './errors.ts';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async', 'send_and_read_finish');
Gio._promisify(Soup.Session.prototype, 'send_async', 'send_finish');
Gio._promisify(Gio.DataInputStream.prototype, 'read_line_async', 'read_line_finish');

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** Délai sans aucune donnée du flux d'événements avant reconnexion (heartbeat : 10 s). */
const WATCHDOG_MS = 30_000;
/** Attente entre deux tentatives de connexion au flux. */
const RETRY_MS = 2000;


/** URL du démon (WA_GNOME_URL pour les tests). */
export const daemonUrl = (): string => GLib.getenv('WA_GNOME_URL') ?? `http://127.0.0.1:${DEFAULT_PORT}`;

/** Dossier de données du démon (même règle que src/daemon/main.ts). */
export const dataDir = (): string => GLib.getenv('WA_GNOME_DATA_DIR') ?? GLib.build_filenamev([GLib.get_user_data_dir(), 'wa-gnome']);

/** Jeton d'accès écrit par le démon, ou vide (démon jamais lancé). */
export function readToken(dir = dataDir()): string {
  try {
    const [, bytes] = GLib.file_get_contents(GLib.build_filenamev([dir, TOKEN_FILE]));
    return decoder.decode(bytes).trim();
  } catch {
    return '';
  }
}

/** État de la liaison app ↔ démon (distinct de la connexion WhatsApp du démon). */
export type Link = { state: 'connecting' } | { state: 'connected' } | { state: 'error'; message: string };

export class WaClient {
  readonly url: string;
  readonly #session = new Soup.Session({ timeout: 30, maxConnsPerHost: 8 });
  /** flux SSE uniquement : connexion permanente, jamais en concurrence avec les requêtes */
  readonly #events = new Soup.Session({ timeout: 0, idleTimeout: 0 });
  readonly #token: () => string;

  constructor(url = daemonUrl(), token: () => string = () => readToken()) {
    this.url = url.replace(/\/+$/u, '');
    this.#token = token;
  }

  #message(method: string, path: string): Soup.Message {
    const msg = Soup.Message.new(method, `${this.url}${path}`);
    if (msg === null) throw new Error(`URL invalide : ${this.url}${path}`);
    msg.get_request_headers().replace('Authorization', `Bearer ${this.#token()}`);
    return msg;
  }

  async request<S extends z.ZodMiniType>(method: string, path: string, schema: S, body?: unknown): Promise<z.output<S>> {
    const msg = this.#message(method, path);
    if (body !== undefined) msg.set_request_body_from_bytes('application/json', new GLib.Bytes(encoder.encode(JSON.stringify(body))));
    const bytes = await this.#session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null);
    const data = bytes.get_data();
    const text = data === null ? '' : decoder.decode(data);
    const status: number = msg.get_status();
    if (status < 200 || status >= 300) {
      const parsed = z.object({ error: z.string() }).safeParse(text === '' ? null : JSON.parse(text));
      throw new HttpError(status, parsed.success ? parsed.data.error : `${method} ${path} : HTTP ${status}`);
    }
    return z.parse(schema, text === '' ? null : JSON.parse(text));
  }

  // ------------------------------------------------------------------ API

  status(): Promise<Status> {
    return this.request('GET', '/status', Status);
  }

  chats(): Promise<Chat[]> {
    return this.request('GET', '/chats', z.array(Chat));
  }

  lists(): Promise<ChatList[]> {
    return this.request('GET', '/lists', z.array(ChatList));
  }

  messages(chatId: string, limit = 50, before?: number): Promise<Message[]> {
    const q = `?limit=${limit}${before === undefined ? '' : `&before=${before}`}`;
    return this.request('GET', `/chats/${encodeURIComponent(chatId)}/messages${q}`, z.array(Message));
  }

  /** Photo de profil d'une discussion, null si elle n'en a pas. */
  async picture(chatId: string): Promise<GLib.Bytes | null> {
    const msg = this.#message('GET', `/chats/${encodeURIComponent(chatId)}/picture`);
    const bytes = await this.#session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null);
    const status: number = msg.get_status();
    if (status === 404) return null;
    if (status < 200 || status >= 300) throw new HttpError(status, `photo : HTTP ${status}`);
    return bytes;
  }

  /** Contenu d'un média (téléchargé et mis en cache par le démon). */
  async media(chatId: string, id: string): Promise<GLib.Bytes> {
    const path = `/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(id)}/media`;
    const msg = this.#message('GET', path);
    const bytes = await this.#session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null);
    const status: number = msg.get_status();
    if (status < 200 || status >= 300) {
      const data = bytes.get_data();
      const parsed = z.object({ error: z.string() }).safeParse(data === null ? null : safeJson(decoder.decode(data)));
      throw new HttpError(status, parsed.success ? parsed.data.error : `média : HTTP ${status}`);
    }
    return bytes;
  }

  /** Session des envois de fichiers : pas de délai (un gros fichier peut prendre du temps). */
  readonly #upload = new Soup.Session({ timeout: 0, idleTimeout: 0 });

  /** Envoie un fichier (photo, vidéo, audio ou document selon son type). */
  async sendFile(chatId: string, f: { bytes: GLib.Bytes; mimetype: string; name: string; caption: string; asDocument: boolean; replyTo?: string; voice?: { seconds: number; waveform: readonly number[] } }): Promise<void> {
    const msg = this.#message('POST', `/chats/${encodeURIComponent(chatId)}/media`);
    const h = msg.get_request_headers();
    h.replace(UPLOAD_NAME, encodeURIComponent(f.name));
    if (f.caption !== '') h.replace(UPLOAD_CAPTION, encodeURIComponent(f.caption));
    if (f.asDocument) h.replace(UPLOAD_AS, 'document');
    if (f.replyTo !== undefined) h.replace(UPLOAD_REPLY, encodeURIComponent(f.replyTo));
    if (f.voice !== undefined) {
      h.replace(UPLOAD_AS, 'voice');
      h.replace(UPLOAD_VOICE_SECONDS, String(f.voice.seconds));
      h.replace(UPLOAD_VOICE_WAVEFORM, GLib.base64_encode(Uint8Array.from(f.voice.waveform)));
    }
    msg.set_request_body_from_bytes(f.mimetype, f.bytes);
    const bytes = await this.#upload.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null);
    const status: number = msg.get_status();
    if (status < 200 || status >= 300) {
      const data = bytes.get_data();
      const parsed = z.object({ error: z.string() }).safeParse(data === null ? null : safeJson(decoder.decode(data)));
      throw new HttpError(status, parsed.success ? parsed.data.error : `envoi : HTTP ${status}`);
    }
  }

  async send(chatId: string, text: string, replyTo?: string): Promise<void> {
    await this.request('POST', `/chats/${encodeURIComponent(chatId)}/messages`, z.unknown(), replyTo === undefined ? { text } : { text, replyTo });
  }

  async chatAction(chatId: string, action: ChatAction): Promise<void> {
    await this.request('POST', `/chats/${encodeURIComponent(chatId)}/action`, z.unknown(), action);
  }

  /** Fiche d'un contact ou d'un groupe. */
  info(chatId: string): Promise<ChatInfo> {
    return this.request('GET', `/chats/${encodeURIComponent(chatId)}/info`, ChatInfo);
  }

  /** Galerie d'une discussion : messages avec média de l'onglet, plus récents d'abord, avant `before`. */
  gallery(chatId: string, tab: GalleryTab, limit = 60, after?: { timestamp: number; id: string }): Promise<Message[]> {
    const page = after === undefined ? '' : `&before=${after.timestamp}&beforeId=${encodeURIComponent(after.id)}`;
    return this.request('GET', `/chats/${encodeURIComponent(chatId)}/gallery?tab=${tab}&limit=${limit}${page}`, z.array(Message));
  }

  /** Messages contenant les mots de `query` (toutes discussions). */
  search(query: string, limit = 50, chatId?: string): Promise<SearchHit[]> {
    const chat = chatId === undefined ? '' : `&chat=${encodeURIComponent(chatId)}`;
    return this.request('GET', `/search?q=${encodeURIComponent(query)}&limit=${limit}${chat}`, z.array(SearchHit));
  }

  /** Discussion ouverte sur un message : quelques messages avant `timestamp`, puis tous les suivants. */
  messagesFrom(chatId: string, timestamp: number): Promise<Message[]> {
    return this.request('GET', `/chats/${encodeURIComponent(chatId)}/messages?from=${timestamp}`, z.array(Message));
  }

  /** Contacts du carnet (nouvelle discussion). */
  contacts(): Promise<Contact[]> {
    return this.request('GET', '/contacts', z.array(Contact));
  }

  /** JID d'un numéro s'il a un compte WhatsApp, sinon null. */
  async lookup(phone: string): Promise<string | null> {
    return (await this.request('GET', `/lookup?phone=${encodeURIComponent(phone)}`, Lookup)).id;
  }

  /** Suit la présence d'une discussion ; présence connue. */
  subscribePresence(chatId: string): Promise<Presence> {
    return this.request('POST', `/chats/${encodeURIComponent(chatId)}/subscribe`, Presence);
  }

  /** Ma présence (fenêtre active ou non). */
  async setOnline(online: boolean): Promise<void> {
    await this.request('POST', '/presence', z.unknown(), { online });
  }

  /** Ma saisie dans une discussion. */
  async typing(chatId: string, state: 'composing' | 'recording' | 'paused'): Promise<void> {
    await this.request('POST', `/chats/${encodeURIComponent(chatId)}/typing`, z.unknown(), { state });
  }

  /** Modifier, supprimer pour tous ou pour moi un message. */
  async messageAction(chatId: string, messageId: string, action: MessageAction): Promise<void> {
    await this.request('POST', `/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}/action`, z.unknown(), action);
  }

  /** Infos d'un message envoyé : accusés par destinataire. */
  messageInfo(chatId: string, messageId: string): Promise<MessageInfo> {
    return this.request('GET', `/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}/info`, MessageInfo);
  }

  /** Réagit à un message (émoji vide : réaction retirée). */
  async react(chatId: string, messageId: string, emoji: string): Promise<void> {
    await this.request('POST', `/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}/react`, z.unknown(), { emoji });
  }

  /** Demande au téléphone des messages plus anciens ; false s'il n'y a rien à demander. */
  async requestHistory(chatId: string): Promise<boolean> {
    const r = await this.request('POST', `/chats/${encodeURIComponent(chatId)}/history`, z.object({ requested: z.boolean() }));
    return r.requested;
  }

  async markRead(chatId: string): Promise<void> {
    await this.request('POST', `/chats/${encodeURIComponent(chatId)}/read`, z.unknown());
  }

  async logout(): Promise<void> {
    await this.request('POST', '/logout', z.unknown());
  }

  // ------------------------------------------------------------------ événements

  /**
   * Flux d'événements, reconnecté indéfiniment jusqu'à annulation. `onLink` suit la liaison
   * (le démon peut être arrêté ou redémarré à tout moment).
   */
  async subscribe(cancellable: Gio.Cancellable, onEvent: (e: Event) => void, onLink: (l: Link) => void): Promise<void> {
    while (!cancellable.is_cancelled()) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- reconnexions successives
        await this.#readEvents(cancellable, onEvent, () => onLink({ state: 'connected' }));
        if (!cancellable.is_cancelled()) onLink({ state: 'connecting' });
      } catch (error) {
        if (cancellable.is_cancelled()) return;
        onLink({ state: 'error', message: errorMessage(error) });
      }
      // oxlint-disable-next-line no-await-in-loop -- attente avant la tentative suivante
      await sleep(RETRY_MS, cancellable);
    }
  }

  async #readEvents(outer: Gio.Cancellable, onEvent: (e: Event) => void, onOpen: () => void): Promise<void> {
    // annulation propre à cette connexion : le chien de garde coupe un flux muet
    const cancellable = new Gio.Cancellable();
    const relay = outer.connect(() => cancellable.cancel());
    let watchdog = 0;
    const alive = (): void => {
      if (watchdog !== 0) GLib.source_remove(watchdog);
      watchdog = GLib.timeout_add(GLib.PRIORITY_DEFAULT, WATCHDOG_MS, () => {
        watchdog = 0;
        cancellable.cancel();
        return GLib.SOURCE_REMOVE;
      });
    };
    try {
      const msg = this.#message('GET', '/events');
      msg.get_request_headers().append('Accept', 'text/event-stream');
      const input = await this.#events.send_async(msg, GLib.PRIORITY_DEFAULT, cancellable);
      const status: number = msg.get_status();
      if (status !== 200) throw new HttpError(status, status === 401 ? 'jeton du démon refusé' : `/events : HTTP ${status}`);
      onOpen();
      alive();
      const lines = new Gio.DataInputStream({ baseStream: input, closeBaseStream: true });
      let data: string[] = [];
      try {
        for (;;) {
          // oxlint-disable-next-line no-await-in-loop -- lecture séquentielle d'un flux SSE
          const [bytes] = await lines.read_line_async(GLib.PRIORITY_DEFAULT, cancellable);
          if (bytes === null) return;
          alive();
          const line = decoder.decode(bytes).replace(/\r$/u, '');
          if (line === '') {
            if (data.length > 0) dispatch(data.join('\n'), onEvent);
            data = [];
          } else if (line.startsWith('data:')) {
            data.push(line.slice(5).trimStart());
          }
        }
      } finally {
        lines.close(null);
      }
    } catch (error) {
      // flux coupé par le chien de garde : simple reconnexion
      if (cancellable.is_cancelled() && !outer.is_cancelled()) return;
      throw error;
    } finally {
      if (watchdog !== 0) GLib.source_remove(watchdog);
      outer.disconnect(relay);
    }
  }
}

const safeJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

export function dispatch(raw: string, onEvent: (e: Event) => void): void {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return;
  }
  const ev = Event.safeParse(json);
  if (ev.success) onEvent(ev.data);
}

function sleep(ms: number, cancellable: Gio.Cancellable): Promise<void> {
  return new Promise((resolve) => {
    const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
      cancellable.disconnect(handler);
      resolve();
      return GLib.SOURCE_REMOVE;
    });
    const handler = cancellable.connect(() => {
      GLib.source_remove(id);
      resolve();
    });
  });
}

// Client HTTP de la CLI vers le démon (Node : fetch), réponses validées par les schémas de l'API.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as z from 'zod/mini';
import {
  Account,
  type ChatAction,
  Chat,
  ChatInfo,
  ChatList,
  Contact,
  DEFAULT_ACCOUNT,
  DEFAULT_PORT,
  Lookup,
  Message,
  type MessageAction,
  MAX_UPLOAD,
  Scheduled,
  SearchHit,
  type SendBody,
  Status,
  TOKEN_FILE,
  UPLOAD_AS,
  UPLOAD_CAPTION,
  UPLOAD_NAME,
  UPLOAD_REPLY,
} from '../shared/api.ts';
import { CliError } from './errors.ts';

export { CliError };

/** Paquet Flatpak : données et port propres (voir flatpak/io.github.maarekj.WaGnome.yml). */
const FLATPAK_DATA = path.join(os.homedir(), '.var', 'app', 'io.github.maarekj.WaGnome', 'data', 'wa-gnome');
const FLATPAK_PORT = 4181;

export interface Endpoint {
  readonly url: string;
  readonly token: string;
}

const readToken = (dir: string): string | null => {
  try {
    const t = fs.readFileSync(path.join(dir, TOKEN_FILE), 'utf8').trim();
    return t === '' ? null : t;
  } catch {
    return null;
  }
};

/**
 * Démon à joindre : l'installation habituelle ($XDG_DATA_HOME/wa-gnome, port 4180), sinon celle du
 * Flatpak (port 4181). WA_GNOME_DATA_DIR ou WA_GNOME_URL : démon désigné, jamais de repli sur le
 * Flatpak (jeton pris dans WA_GNOME_DATA_DIR, ou le dossier habituel) ; WA_GNOME_PORT : autre port.
 */
export function endpoint(env: NodeJS.ProcessEnv = process.env): Endpoint {
  const dataDir = env['WA_GNOME_DATA_DIR'];
  const port = env['WA_GNOME_PORT'];
  const explicit = env['WA_GNOME_URL'];
  const normal = dataDir ?? path.join(env['XDG_DATA_HOME'] ?? path.join(os.homedir(), '.local', 'share'), 'wa-gnome');
  const token = readToken(normal);
  if (token !== null || dataDir !== undefined || explicit !== undefined) {
    if (token === null) throw new CliError(`jeton du démon introuvable dans ${normal} (démon jamais lancé ?)`, 3);
    return { url: explicit ?? `http://127.0.0.1:${port ?? DEFAULT_PORT}`, token };
  }
  const flatpak = readToken(FLATPAK_DATA);
  if (flatpak !== null) return { url: `http://127.0.0.1:${port ?? FLATPAK_PORT}`, token: flatpak };
  throw new CliError(`démon wa-gnome introuvable : aucun jeton dans ${normal} ni dans ${FLATPAK_DATA}`, 3);
}

const ErrorBody = z.object({ error: z.string() });
const Accounts = z.array(Account);

/** Client d'un compte du démon. */
export class Client {
  readonly #ep: Endpoint;
  readonly account: string;

  constructor(ep: Endpoint, account = DEFAULT_ACCOUNT) {
    this.#ep = ep;
    this.account = account;
  }

  async #request(
    method: string,
    route: string,
    opts: { body?: unknown; raw?: Uint8Array; headers?: Record<string, string>; global?: boolean } = {},
  ): Promise<unknown> {
    const prefix = opts.global === true || this.account === DEFAULT_ACCOUNT ? '' : `/accounts/${encodeURIComponent(this.account)}`;
    const headers: Record<string, string> = { Authorization: `Bearer ${this.#ep.token}`, ...opts.headers };
    let body: Uint8Array | string | undefined;
    if (opts.raw !== undefined) body = opts.raw;
    else if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }
    let res: Response;
    try {
      res = await fetch(`${this.#ep.url}${prefix}${route}`, { method, headers, ...(body === undefined ? {} : { body }) });
    } catch {
      throw new CliError(`démon injoignable sur ${this.#ep.url} (lancé ? systemctl --user status wa-gnome-daemon)`, 3);
    }
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text === '' ? null : JSON.parse(text);
    } catch {
      data = text;
    }
    if (!res.ok) {
      const e = ErrorBody.safeParse(data);
      throw new CliError(`démon : ${e.success ? e.data.error : `HTTP ${res.status}`}`, res.status === 401 ? 3 : 1);
    }
    return data;
  }

  #get<T>(schema: z.ZodMiniType<T>, route: string, global = false): Promise<T> {
    return this.#request('GET', route, { global }).then((d) => {
      const r = schema.safeParse(d);
      if (!r.success) throw new CliError(`réponse inattendue du démon (${route}) : ${z.prettifyError(r.error)}`);
      return r.data;
    });
  }

  #chat = (id: string): string => `/chats/${encodeURIComponent(id)}`;

  status = (): Promise<Status> => this.#get(Status, '/status');
  accounts = (): Promise<Account[]> => this.#get(Accounts, '/accounts', true);
  chats = (): Promise<Chat[]> => this.#get(z.array(Chat), '/chats');
  lists = (): Promise<ChatList[]> => this.#get(z.array(ChatList), '/lists');
  contacts = (): Promise<Contact[]> => this.#get(z.array(Contact), '/contacts');
  info = (chatId: string): Promise<ChatInfo> => this.#get(ChatInfo, `${this.#chat(chatId)}/info`);
  scheduled = (chatId: string): Promise<Scheduled[]> => this.#get(z.array(Scheduled), `${this.#chat(chatId)}/scheduled`);
  async lookup(phone: string): Promise<string | null> {
    return (await this.#get(Lookup, `/lookup?phone=${encodeURIComponent(phone)}`)).id;
  }
  messages(chatId: string, limit: number, before?: number): Promise<Message[]> {
    const q = new URLSearchParams({ limit: String(limit) });
    if (before !== undefined) q.set('before', String(before));
    return this.#get(z.array(Message), `${this.#chat(chatId)}/messages?${q.toString()}`);
  }
  search(query: string, limit: number, chatId?: string): Promise<SearchHit[]> {
    const q = new URLSearchParams({ q: query, limit: String(limit) });
    if (chatId !== undefined) q.set('chat', chatId);
    return this.#get(z.array(SearchHit), `/search?${q.toString()}`);
  }
  async send(chatId: string, body: SendBody): Promise<void> {
    await this.#request('POST', `${this.#chat(chatId)}/messages`, { body });
  }
  async sendFile(chatId: string, file: string, opts: { caption?: string; replyTo?: string; asDocument?: boolean; mimetype: string }): Promise<void> {
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    if (stat === undefined || !stat.isFile()) throw new CliError(`fichier introuvable : ${file}`);
    if (stat.size > MAX_UPLOAD) throw new CliError(`fichier trop gros (${Math.round(stat.size / 1e6)} Mo, au plus ${MAX_UPLOAD / 1e6} Mo)`);
    const headers: Record<string, string> = { 'Content-Type': opts.mimetype, [UPLOAD_NAME]: encodeURIComponent(path.basename(file)) };
    if (opts.caption !== undefined) headers[UPLOAD_CAPTION] = encodeURIComponent(opts.caption);
    if (opts.replyTo !== undefined) headers[UPLOAD_REPLY] = encodeURIComponent(opts.replyTo);
    if (opts.asDocument === true) headers[UPLOAD_AS] = 'document';
    await this.#request('POST', `${this.#chat(chatId)}/media`, { raw: new Uint8Array(fs.readFileSync(file)), headers });
  }
  async schedule(chatId: string, text: string, at: number, replyTo?: string): Promise<void> {
    await this.#request('POST', `${this.#chat(chatId)}/scheduled`, { body: { text, at, ...(replyTo === undefined ? {} : { replyTo }) } });
  }
  async unschedule(id: string): Promise<void> {
    await this.#request('DELETE', `/scheduled/${encodeURIComponent(id)}`);
  }
  async chatAction(chatId: string, action: ChatAction): Promise<void> {
    await this.#request('POST', `${this.#chat(chatId)}/action`, { body: action });
  }
  async read(chatId: string): Promise<void> {
    await this.#request('POST', `${this.#chat(chatId)}/read`);
  }
  async messageAction(chatId: string, messageId: string, action: MessageAction): Promise<void> {
    await this.#request('POST', `${this.#chat(chatId)}/messages/${encodeURIComponent(messageId)}/action`, { body: action });
  }
  async react(chatId: string, messageId: string, emoji: string): Promise<void> {
    await this.#request('POST', `${this.#chat(chatId)}/messages/${encodeURIComponent(messageId)}/react`, { body: { emoji } });
  }
}

// État de l'application, alimenté par le flux d'événements du démon.
import Gio from 'gi://Gio';
import { createState, type Accessor } from 'gnim';
import type { Chat, ChatAction, Event, Message, Status } from './api.ts';
import type { Link, WaClient } from './client.ts';
import { errorMessage } from './errors.ts';

/** Nombre de messages chargés à l'ouverture d'une discussion. */
const PAGE = 60;

/** Discussions triées : épinglées d'abord (la dernière épinglée en tête), puis la plus récente d'abord. */
export const sortChats = (chats: Iterable<Chat>): Chat[] =>
  [...chats].toSorted((a, b) => Number(b.pinned > 0) - Number(a.pinned > 0) || b.pinned - a.pinned || b.timestamp - a.timestamp || a.name.localeCompare(b.name));

/** Insère ou remplace un message, en gardant l'ordre chronologique. */
export function mergeMessage(list: readonly Message[], m: Message): Message[] {
  const without = list.filter((x) => x.id !== m.id);
  const at = without.findLastIndex((x) => x.timestamp <= m.timestamp);
  without.splice(at + 1, 0, m);
  return without;
}

export class Store {
  readonly client: WaClient;
  readonly link: Accessor<Link>;
  readonly status: Accessor<Status>;
  readonly chats: Accessor<readonly Chat[]>;
  /** discussion ouverte, ou null */
  readonly current: Accessor<string | null>;
  /** messages de la discussion ouverte */
  readonly messages: Accessor<readonly Message[]>;
  /** photo de profil changée */
  onPicture: ((id: string) => void) | null = null;
  /** nouveau message reçu (notifications) */
  onIncoming: ((m: Message, chat: Chat | undefined) => void) | null = null;

  readonly #setLink: (l: Link) => void;
  readonly #setStatus: (s: Status) => void;
  readonly #setChats: (c: readonly Chat[]) => void;
  readonly #setCurrent: (id: string | null) => void;
  readonly #setMessages: (m: readonly Message[]) => void;
  readonly #byId = new Map<string, Chat>();
  #cancellable: Gio.Cancellable | null = null;

  constructor(client: WaClient) {
    this.client = client;
    [this.link, this.#setLink] = createState<Link>({ state: 'connecting' });
    [this.status, this.#setStatus] = createState<Status>({ state: 'starting', qr: null, me: null, error: null });
    [this.chats, this.#setChats] = createState<readonly Chat[]>([]);
    [this.current, this.#setCurrent] = createState<string | null>(null);
    [this.messages, this.#setMessages] = createState<readonly Message[]>([]);
  }

  chat(id: string): Chat | undefined {
    return this.#byId.get(id);
  }

  start(): void {
    if (this.#cancellable !== null) return;
    const cancellable = new Gio.Cancellable();
    this.#cancellable = cancellable;
    void this.client.subscribe(
      cancellable,
      (e) => this.apply(e),
      (l) => {
        this.#setLink(l);
        // (re)connexion : état complet relu, des événements ont pu être manqués
        if (l.state === 'connected') void this.reload();
      },
    );
  }

  stop(): void {
    this.#cancellable?.cancel();
    this.#cancellable = null;
  }

  async reload(): Promise<void> {
    try {
      this.#replaceChats(await this.client.chats());
      const id = this.current.peek();
      if (id !== null) this.#setMessages(await this.client.messages(id, PAGE));
    } catch (error) {
      console.error(`rechargement : ${errorMessage(error)}`);
    }
  }

  #replaceChats(chats: readonly Chat[]): void {
    this.#byId.clear();
    for (const c of chats) this.#byId.set(c.id, c);
    this.#setChats(sortChats(this.#byId.values()));
  }

  /** Événement du démon appliqué à l'état (public pour les tests). */
  apply(e: Event): void {
    switch (e.type) {
      case 'status': {
        const before = this.status.peek().state;
        this.#setStatus(e.status);
        if (e.status.state === 'open' && before !== 'open') void this.reload();
        if (e.status.state === 'logged-out') {
          this.#replaceChats([]);
          this.open(null);
        }
        break;
      }
      case 'chats':
        for (const c of e.chats) this.#byId.set(c.id, c);
        this.#setChats(sortChats(this.#byId.values()));
        break;
      case 'chats.delete':
        for (const id of e.ids) this.#byId.delete(id);
        this.#setChats(sortChats(this.#byId.values()));
        if (e.ids.includes(this.current.peek() ?? '')) this.open(null);
        break;
      case 'picture':
        this.onPicture?.(e.id);
        break;
      case 'chat.cleared':
        if (e.id === this.current.peek()) this.#setMessages([]);
        break;
      case 'message':
        if (e.message.chatId === this.current.peek()) this.#setMessages(mergeMessage(this.messages.peek(), e.message));
        if (!e.message.fromMe) this.onIncoming?.(e.message, this.#byId.get(e.message.chatId));
        break;
      default:
        e satisfies never;
    }
  }

  /** Ouvre une discussion (null : aucune) et charge ses derniers messages. */
  open(id: string | null): void {
    if (id === this.current.peek()) return;
    this.#setCurrent(id);
    this.#setMessages([]);
    if (id === null) return;
    void this.#load(id);
    this.markRead(id);
  }

  async #load(id: string): Promise<void> {
    try {
      const list = await this.client.messages(id, PAGE);
      if (this.current.peek() === id) this.#setMessages(list);
    } catch (error) {
      console.error(`messages : ${errorMessage(error)}`);
    }
  }

  markRead(id: string): void {
    const chat = this.#byId.get(id);
    if (chat === undefined || (chat.unread === 0 && !chat.markedUnread)) return;
    this.client.markRead(id).catch((error: unknown) => console.error(`lecture : ${errorMessage(error)}`));
  }

  chatAction(chatId: string, action: ChatAction): Promise<void> {
    return this.client.chatAction(chatId, action);
  }

  send(chatId: string, text: string): Promise<void> {
    return this.client.send(chatId, text);
  }
}

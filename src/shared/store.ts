// État de l'application, alimenté par le flux d'événements du démon.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { createState, type Accessor } from 'gnim';
import type { Chat, ChatAction, ChatList, Event, Message, Status } from './api.ts';
import type { Link, WaClient } from './client.ts';
import { errorMessage } from './errors.ts';

/** Nombre de messages chargés à l'ouverture d'une discussion. */
const PAGE = 60;

/** Discussions triées : épinglées d'abord (la dernière épinglée en tête), puis la plus récente d'abord. */
export const sortChats = (chats: Iterable<Chat>): Chat[] =>
  [...chats].toSorted((a, b) => Number(b.pinned > 0) - Number(a.pinned > 0) || b.pinned - a.pinned || b.timestamp - a.timestamp || a.name.localeCompare(b.name));

/** Messages plus anciens : `idle` (on peut en demander), `loading`, `phone` (demandés au téléphone), `end` (début de la discussion). */
export type OlderState = 'idle' | 'loading' | 'phone' | 'end';

/** Délai d'attente de la réponse du téléphone à une demande d'historique (ms). */
const PHONE_TIMEOUT_MS = 20_000;

/** Fusionne une page plus ancienne en tête (doublons ignorés), ordre chronologique. */
export function prependPage(list: readonly Message[], page: readonly Message[]): Message[] {
  const known = new Set(list.map((m) => m.id));
  return [...page.filter((m) => !known.has(m.id)), ...list];
}

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
  /** listes de WhatsApp (filtres : non lues, favoris, groupes, listes personnalisées) */
  readonly lists: Accessor<readonly ChatList[]>;
  /** discussion ouverte, ou null */
  readonly current: Accessor<string | null>;
  /** messages de la discussion ouverte */
  readonly messages: Accessor<readonly Message[]>;
  /** chargement des messages plus anciens de la discussion ouverte */
  readonly older: Accessor<OlderState>;
  /** message auquel on répond (zone de saisie), null sinon */
  readonly replyTo: Accessor<Message | null>;
  readonly setReplyTo: (m: Message | null) => void;
  /** photo de profil changée */
  onPicture: ((id: string) => void) | null = null;
  /** nouveau message reçu (notifications) */
  onIncoming: ((m: Message, chat: Chat | undefined) => void) | null = null;

  readonly #setLink: (l: Link) => void;
  readonly #setStatus: (s: Status) => void;
  readonly #setChats: (c: readonly Chat[]) => void;
  readonly #setLists: (l: readonly ChatList[]) => void;
  readonly #setCurrent: (id: string | null) => void;
  readonly #setMessages: (m: readonly Message[]) => void;
  readonly #setOlder: (s: OlderState) => void;
  #phoneTimer = 0;
  /** réponse du téléphone reçue : s'il n'a rien apporté de nouveau, pas de nouvelle demande */
  #afterPhone = false;
  readonly #byId = new Map<string, Chat>();
  #cancellable: Gio.Cancellable | null = null;

  constructor(client: WaClient) {
    this.client = client;
    [this.link, this.#setLink] = createState<Link>({ state: 'connecting' });
    [this.status, this.#setStatus] = createState<Status>({ state: 'starting', qr: null, me: null, error: null });
    [this.chats, this.#setChats] = createState<readonly Chat[]>([]);
    [this.lists, this.#setLists] = createState<readonly ChatList[]>([]);
    [this.current, this.#setCurrent] = createState<string | null>(null);
    [this.messages, this.#setMessages] = createState<readonly Message[]>([]);
    [this.older, this.#setOlder] = createState<OlderState>('idle');
    [this.replyTo, this.setReplyTo] = createState<Message | null>(null);
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
      this.#setLists(await this.client.lists());
      const id = this.current.peek();
      // autant de messages qu'affichés (pages plus anciennes déjà chargées comprises)
      if (id !== null) this.#setMessages(await this.client.messages(id, Math.min(500, Math.max(PAGE, this.messages.peek().length))));
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
      case 'lists':
        this.#setLists(e.lists);
        break;
      case 'picture':
        this.onPicture?.(e.id);
        break;
      case 'history':
        // réponse du téléphone : messages plus anciens désormais dans la base du démon
        if (this.older.peek() === 'phone' && e.ids.includes(this.current.peek() ?? '')) {
          this.#clearPhoneTimer();
          this.#setOlder('idle');
          this.#afterPhone = true;
          void this.loadOlder();
        }
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
    this.#clearPhoneTimer();
    this.#afterPhone = false;
    this.#setOlder('idle');
    this.setReplyTo(null);
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

  /**
   * Page de messages plus anciens : base du démon d'abord, puis demande au téléphone quand elle
   * est épuisée ; `end` si le téléphone n'en a pas d'autres (ou ne répond pas).
   */
  async loadOlder(): Promise<void> {
    const id = this.current.peek();
    const list = this.messages.peek();
    if (id === null || this.older.peek() !== 'idle') return;
    this.#setOlder('loading');
    try {
      const first = list[0];
      // seconde suivante incluse : messages de la même seconde que le plus ancien (doublons retirés)
      const page = first === undefined ? [] : await this.client.messages(id, PAGE, first.timestamp + 1);
      if (this.current.peek() !== id) return;
      const merged = prependPage(this.messages.peek(), page);
      const afterPhone = this.#afterPhone;
      this.#afterPhone = false;
      if (merged.length > this.messages.peek().length) {
        this.#setMessages(merged);
        this.#setOlder('idle');
        return;
      }
      // base locale épuisée : demande au téléphone (une fois : il a déjà tout renvoyé sinon)
      if (afterPhone || !(await this.client.requestHistory(id))) {
        this.#setOlder('end');
        return;
      }
      this.#setOlder('phone');
      this.#phoneTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PHONE_TIMEOUT_MS, () => {
        this.#phoneTimer = 0;
        if (this.older.peek() === 'phone') this.#setOlder('end');
        return GLib.SOURCE_REMOVE;
      });
    } catch (error) {
      console.error(`messages plus anciens : ${errorMessage(error)}`);
      if (this.current.peek() === id) this.#setOlder('end');
    }
  }

  #clearPhoneTimer(): void {
    if (this.#phoneTimer !== 0) GLib.source_remove(this.#phoneTimer);
    this.#phoneTimer = 0;
  }

  markRead(id: string): void {
    const chat = this.#byId.get(id);
    if (chat === undefined || (chat.unread === 0 && !chat.markedUnread)) return;
    this.client.markRead(id).catch((error: unknown) => console.error(`lecture : ${errorMessage(error)}`));
  }

  chatAction(chatId: string, action: ChatAction): Promise<void> {
    return this.client.chatAction(chatId, action);
  }

  send(chatId: string, text: string, replyTo?: string): Promise<void> {
    return this.client.send(chatId, text, replyTo);
  }
}

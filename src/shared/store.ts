// État de l'application, alimenté par le flux d'événements du démon.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { createState, type Accessor, type Setter } from 'gnim';
import type { Call, Chat, ChatAction, StatusGroup, ChatList, Event, Message, Presence, Status } from './api.ts';
import type { Link, WaClient } from './client.ts';
import { errorMessage } from './errors.ts';

/** Nombre de messages chargés à l'ouverture d'une discussion. */
const PAGE = 60;

/** Discussions triées : épinglées d'abord (la dernière épinglée en tête), puis la plus récente d'abord. */
export const sortChats = (chats: Iterable<Chat>): Chat[] =>
  [...chats].toSorted((a, b) => Number(b.pinned > 0) - Number(a.pinned > 0) || b.pinned - a.pinned || b.timestamp - a.timestamp || a.name.localeCompare(b.name));

/** « écrit… » sans nouvelle de WhatsApp pendant ce délai : retiré (ms). */
const TYPING_TIMEOUT_MS = 15_000;

/** « Alice écrit… », « en train d'écrire… », « enregistre un audio… » ; null si personne n'écrit. */
export function typingText(p: Presence, group: boolean): string | null {
  const first = p.typing[0];
  if (first === undefined) return null;
  if (!group) return first.recording ? 'enregistre un audio…' : 'en train d’écrire…';
  if (p.typing.length > 1) return `${p.typing.length} personnes écrivent…`;
  return `${first.name} ${first.recording ? 'enregistre un audio…' : 'écrit…'}`;
}

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
  /** présence de la discussion ouverte (null : inconnue) */
  readonly presence: Accessor<Presence | null>;
  /** messages épinglés de la discussion ouverte (le plus récent d'abord) */
  readonly pins: Accessor<readonly Message[]>;
  /** statuts (« stories ») de moins de 24 h, par personne */
  readonly statuses: Accessor<readonly StatusGroup[]>;
  readonly #setStatuses: Setter<readonly StatusGroup[]>;
  readonly #setPins: Setter<readonly Message[]>;
  readonly #setPresence: (p: Presence | null) => void;
  /** personnes en train d'écrire, par discussion (aperçu de la liste) */
  readonly typing: Accessor<ReadonlyMap<string, string>>;
  /** brouillons (message saisi, pas encore envoyé) par discussion, en mémoire */
  readonly drafts: Accessor<ReadonlyMap<string, string>>;
  readonly #setDrafts: Setter<ReadonlyMap<string, string>>;
  readonly #setTyping: (t: ReadonlyMap<string, string>) => void;
  /** chargement des messages plus anciens de la discussion ouverte */
  readonly older: Accessor<OlderState>;
  /** message en cours de modification (zone de saisie), null sinon */
  readonly editing: Accessor<Message | null>;
  readonly setEditing: (m: Message | null) => void;
  /** message auquel on répond (zone de saisie), null sinon */
  readonly replyTo: Accessor<Message | null>;
  /** message à amener à l'écran (ouverture depuis la recherche) ; `n` change à chaque demande */
  readonly scrollTarget: Accessor<{ id: string; n: number } | null>;
  readonly #setScrollTarget: Setter<{ id: string; n: number } | null>;
  /** demandes de focus dans la zone de saisie (« Répondre » d'une notification) */
  readonly focusRequests: Accessor<number>;
  readonly #setFocusRequests: Setter<number>;
  readonly setReplyTo: (m: Message | null) => void;
  /** photo de profil changée */
  onPicture: ((id: string) => void) | null = null;
  /** nouveau message reçu (notifications) */
  onIncoming: ((m: Message, chat: Chat | undefined) => void) | null = null;
  /** appel reçu qui sonne ou se termine (notification) */
  onCall: ((call: Call, chat: Chat | undefined) => void) | null = null;

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
    [this.presence, this.#setPresence] = createState<Presence | null>(null);
    [this.pins, this.#setPins] = createState<readonly Message[]>([]);
    [this.statuses, this.#setStatuses] = createState<readonly StatusGroup[]>([]);
    [this.typing, this.#setTyping] = createState<ReadonlyMap<string, string>>(new Map());
    [this.drafts, this.#setDrafts] = createState<ReadonlyMap<string, string>>(new Map());
    [this.replyTo, this.setReplyTo] = createState<Message | null>(null);
    [this.focusRequests, this.#setFocusRequests] = createState(0);
    [this.scrollTarget, this.#setScrollTarget] = createState<{ id: string; n: number } | null>(null);
    [this.editing, this.setEditing] = createState<Message | null>(null);
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
      if (id !== null) void this.#loadPins(id);
      void this.loadStatuses();
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
      case 'presence': {
        if (e.chatId === this.current.peek()) this.#setPresence(e.presence);
        this.#setTypingText(e.chatId, typingText(e.presence, e.chatId.endsWith('@g.us')));
        break;
      }
      case 'lists':
        this.#setLists(e.lists);
        break;
      case 'picture':
        this.onPicture?.(e.id);
        break;
      case 'message.delete':
        if (this.pins.peek().some((p) => p.id === e.id)) this.#setPins(this.pins.peek().filter((p) => p.id !== e.id));
        if (e.chatId === this.current.peek()) this.#setMessages(this.messages.peek().filter((m) => m.id !== e.id));
        if (this.editing.peek()?.id === e.id) this.setEditing(null);
        break;
      case 'message.update': {
        // message épinglé modifié (ou supprimé pour tous) : bandeau à jour
        if (this.pins.peek().some((p) => p.id === e.message.id)) this.#setPins(e.message.deleted ? this.pins.peek().filter((p) => p.id !== e.message.id) : this.pins.peek().map((p) => (p.id === e.message.id ? e.message : p)));
        // remplacé s'il est affiché (pas d'ajout : réaction à un message plus ancien que la page)
        const list = this.messages.peek();
        if (e.message.chatId === this.current.peek() && list.some((m) => m.id === e.message.id)) this.#setMessages(list.map((m) => (m.id === e.message.id ? e.message : m)));
        break;
      }
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
      case 'statuses':
        void this.loadStatuses();
        break;
      case 'pins':
        if (e.chatId === this.current.peek()) void this.#loadPins(e.chatId);
        break;
      case 'call':
        this.onCall?.(e.call, this.#byId.get(e.call.chatId));
        break;
      default:
        e satisfies never;
    }
  }

  /** Brouillon d'une discussion (vide : retiré). */
  setDraft(chatId: string, text: string): void {
    const current = this.drafts.peek();
    if ((current.get(chatId) ?? '') === text) return;
    const next = new Map(current);
    if (text.trim() === '') next.delete(chatId);
    else next.set(chatId, text);
    this.#setDrafts(next);
  }

  /** Ouvre une discussion sur un message (résultat de recherche), mis en évidence. */
  openAt(chatId: string, id: string, timestamp: number): void {
    const target = { id, n: (this.scrollTarget.peek()?.n ?? 0) + 1 };
    if (this.current.peek() === chatId && this.messages.peek().some((m) => m.id === id)) {
      this.#setScrollTarget(target);
      return;
    }
    // autre discussion : ouverte sans charger les derniers messages (remplacés ci-dessous)
    this.open(chatId, false);
    void (async (): Promise<void> => {
      try {
        const list = await this.client.messagesFrom(chatId, timestamp);
        if (this.current.peek() !== chatId) return;
        // cible annoncée avant les messages : la conversation ne se recolle pas en bas
        this.#setScrollTarget(target);
        this.#setMessages(list);
      } catch (error) {
        console.error(`messages : ${errorMessage(error)}`);
      }
    })();
  }

  /** Ouvre la discussion, zone de saisie active (réponse depuis une notification). */
  reply(id: string): void {
    this.open(id);
    this.#setFocusRequests(this.focusRequests.peek() + 1);
  }

  /** noms de discussions ouvertes avant d'exister (nouvelle discussion) */
  readonly #names = new Map<string, string>();

  /** Nom connu d'une discussion pas encore dans la liste (nouvelle discussion), sinon null. */
  nameHint(id: string): string | null {
    return this.#names.get(id) ?? null;
  }

  /** Ouvre une discussion, même sans message (nouvelle discussion avec un contact ou un numéro). */
  startChat(id: string, name: string): void {
    this.#names.set(id, name);
    this.open(id);
  }

  /** Ouvre une discussion (null : aucune) et charge ses derniers messages (sauf `load` faux). */
  open(id: string | null, load = true): void {
    if (id === this.current.peek()) return;
    this.#setCurrent(id);
    this.#setMessages([]);
    this.#clearPhoneTimer();
    this.#afterPhone = false;
    this.#setOlder('idle');
    this.setReplyTo(null);
    this.setEditing(null);
    this.#setPresence(null);
    this.#setPins([]);
    if (id === null) return;
    void this.#subscribe(id);
    void this.#loadPins(id);
    if (load) void this.#load(id);
    this.markRead(id);
  }

  /** minuteries d'expiration de « écrit… » (WhatsApp n'envoie pas toujours la pause) */
  readonly #typingTimers = new Map<string, number>();

  #setTypingText(chatId: string, text: string | null): void {
    const typing = new Map(this.typing.peek());
    if (text === null) typing.delete(chatId);
    else typing.set(chatId, text);
    this.#setTyping(typing);
    const old = this.#typingTimers.get(chatId);
    if (old !== undefined) GLib.source_remove(old);
    this.#typingTimers.delete(chatId);
    if (text === null) return;
    this.#typingTimers.set(
      chatId,
      GLib.timeout_add(GLib.PRIORITY_DEFAULT, TYPING_TIMEOUT_MS, () => {
        this.#typingTimers.delete(chatId);
        this.#setTypingText(chatId, null);
        const p = this.presence.peek();
        if (chatId === this.current.peek() && p !== null) this.#setPresence({ ...p, typing: [] });
        return GLib.SOURCE_REMOVE;
      }),
    );
  }

  /** Statuts relus (au chargement, à chaque changement annoncé par le démon). */
  async loadStatuses(): Promise<void> {
    try {
      this.#setStatuses(await this.client.statuses());
    } catch (error) {
      console.error(`statuts : ${errorMessage(error)}`);
    }
  }

  async #loadPins(id: string): Promise<void> {
    try {
      const list = await this.client.pins(id);
      if (this.current.peek() === id) this.#setPins(list);
    } catch (error) {
      console.error(`messages épinglés : ${errorMessage(error)}`);
    }
  }

  async #subscribe(id: string): Promise<void> {
    try {
      const p = await this.client.subscribePresence(id);
      if (this.current.peek() !== id) return;
      this.#setPresence(p);
      // même chemin qu'un événement : « écrit… » expire aussi
      this.#setTypingText(id, typingText(p, id.endsWith('@g.us')));
    } catch (error) {
      console.error(`présence : ${errorMessage(error)}`);
    }
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

  send(chatId: string, text: string, replyTo?: string, mentions?: readonly string[]): Promise<void> {
    return this.client.send(chatId, text, replyTo, mentions);
  }
}

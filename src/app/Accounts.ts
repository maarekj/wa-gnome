// Comptes WhatsApp du démon vus par l'app : un Store (flux d'événements) par compte, tous suivis
// en même temps (notifications, non-lus), un seul affiché dans la fenêtre.
import { type Accessor, createState, type Setter } from 'gnim';
import { DEFAULT_ACCOUNT, type Chat, isMuted } from '../shared/api.ts';
import type { WaClient } from '../shared/client.ts';
import { errorMessage } from '../shared/errors.ts';
import { Store } from '../shared/store.ts';
import { Pictures } from './pictures.ts';

/** Discussions non lues d'un compte (hors archivées et silencieuses), pour le sélecteur. */
export const unreadChats = (chats: readonly Chat[]): number => chats.filter((c) => !c.archived && !isMuted(c) && (c.unread > 0 || c.markedUnread)).length;

/** Nom d'un compte : son nom WhatsApp, son numéro, ou « en attente d'appairage ». */
export function accountName(store: Store): string {
  const me = store.status.peek().me;
  if (me === null) return 'Nouveau compte (à appairer)';
  return me.name ?? `+${me.id.split('@')[0] ?? ''}`;
}

export class Accounts {
  /** comptes, dans l'ordre d'ajout (le compte par défaut d'abord) */
  readonly list: Accessor<readonly Store[]>;
  readonly #setList: Setter<readonly Store[]>;
  /** compte affiché */
  readonly active: Accessor<Store>;
  readonly #setActive: Setter<Store>;
  readonly #pictures = new WeakMap<Store, Pictures>();
  /** nouveau compte suivi (notifications à brancher) */
  onAdded: ((store: Store) => void) | null = null;
  /** compte retiré (notifications à retirer) */
  onRemoved: ((store: Store) => void) | null = null;
  /** compte affiché changé */
  onSwitch: ((store: Store) => void) | null = null;
  #wanted: string;

  constructor(base: WaClient, wanted: string) {
    const first = new Store(base);
    [this.list, this.#setList] = createState<readonly Store[]>([first]);
    [this.active, this.#setActive] = createState(first);
    this.#wanted = wanted;
    // démon (re)joint : liste des comptes relue
    first.link.subscribe(() => {
      if (first.link.peek().state === 'connected') void this.refresh();
    });
  }

  /** Compte par défaut (toujours présent). */
  get main(): Store {
    const first = this.list.peek()[0];
    if (first === undefined) throw new Error('aucun compte');
    return first;
  }

  byId(id: string): Store | undefined {
    return this.list.peek().find((s) => s.client.account === id);
  }

  /** Photos de profil d'un compte. */
  pictures(store: Store): Pictures {
    let p = this.#pictures.get(store);
    if (p === undefined) {
      p = new Pictures(store.client);
      const pics = p;
      store.onPicture = (id) => pics.invalidate(id);
      this.#pictures.set(store, p);
    }
    return p;
  }

  start(): void {
    for (const s of this.list.peek()) s.start();
  }

  stop(): void {
    for (const s of this.list.peek()) s.stop();
  }

  #refreshing: Promise<void> = Promise.resolve();

  /** Comptes relus auprès du démon : nouveaux suivis, retirés arrêtés (une relecture à la fois). */
  refresh(): Promise<void> {
    this.#refreshing = this.#refreshing.then(() => this.#refresh());
    return this.#refreshing;
  }

  async #refresh(): Promise<void> {
    let ids: string[];
    try {
      ids = (await this.main.client.accounts()).map((a) => a.id);
    } catch (error) {
      console.error(`comptes : ${errorMessage(error)}`);
      return;
    }
    const old = this.list.peek();
    const next = [DEFAULT_ACCOUNT, ...ids.filter((id) => id !== DEFAULT_ACCOUNT)].map((id) => old.find((s) => s.client.account === id) ?? this.#follow(id));
    for (const s of old) {
      if (next.includes(s)) continue;
      s.stop();
      this.onRemoved?.(s);
    }
    this.#setList(next);
    // compte du dernier lancement, s'il existe encore
    const wanted = next.find((s) => s.client.account === this.#wanted);
    if (wanted !== undefined && wanted !== this.active.peek()) this.select(wanted);
    else if (!next.includes(this.active.peek())) this.select(this.main);
  }

  #follow(id: string): Store {
    const s = new Store(this.main.client.forAccount(id));
    s.start();
    this.onAdded?.(s);
    return s;
  }

  select(store: Store): void {
    this.#wanted = store.client.account;
    if (store === this.active.peek()) return;
    this.#setActive(store);
    this.onSwitch?.(store);
  }

  /** Nouveau compte, affiché aussitôt (QR code d'appairage). */
  async add(): Promise<void> {
    const id = await this.main.client.addAccount();
    this.#wanted = id;
    await this.refresh();
  }

  /** Compte déconnecté et retiré (données effacées) ; retour au compte par défaut. */
  async remove(store: Store): Promise<void> {
    // compte affiché : retour au premier avant le retrait (pas d'écran d'erreur entre-temps)
    const shown = this.active.peek() === store;
    if (shown) this.select(this.main);
    try {
      await store.client.removeAccount();
    } catch (error) {
      if (shown) this.select(store);
      throw error;
    }
    await this.refresh();
  }
}

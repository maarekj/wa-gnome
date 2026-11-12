// Liste des discussions virtuelle (Gtk.ListView) : seules les lignes visibles existent et sont
// mises en page ; leurs photos sont demandées à l'affichage. Une même liste contient les entrées
// (Archivées, Statuts, Chaînes), les discussions, puis les messages trouvés par la recherche.
import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';
import type { Accessor } from 'gnim';
import { type Chat, isMuted, type SearchHit } from '../shared/api.ts';
import { esc, fmtShortDate, snippetMarkup } from '../shared/format.ts';
import type { Store } from '../shared/store.ts';
import { attachRowMenu, type ChatMenuAt } from './ChatMenu.ts';
import type { Pictures } from './pictures.ts';

/** Entrée vers une autre vue, en tête de la liste principale. */
export type EntryId = 'archived' | 'statuses' | 'channels';

/** Élément de la liste. */
export type SideRow =
  | { readonly kind: 'entry'; readonly id: EntryId; readonly count: string; readonly accent: boolean }
  | { readonly kind: 'chat'; readonly chat: Chat }
  | { readonly kind: 'header' }
  | { readonly kind: 'hit'; readonly hit: SearchHit };

/** Clé stable d'un élément (même clé : même objet du modèle, mis à jour sur place). */
export function rowKey(r: SideRow): string {
  switch (r.kind) {
    case 'entry':
      return `entry:${r.id}`;
    case 'chat':
      return r.chat.id;
    case 'header':
      return 'header';
    case 'hit':
      return `hit:${r.hit.chatId}/${r.hit.id}`;
    default:
      return r satisfies never;
  }
}

/** Texte de l'avatar : sans le « ~ » des noms publics (initiales du nom). */
export const avatarText = (name: string): string => name.replace(/^~ /u, '');

/** Aperçu d'une discussion dans la liste : « écrit… », « Brouillon : … » ou dernier message (balisage). */
export function previewMarkup(c: Pick<Chat, 'preview'>, typing?: string, draft?: string): string {
  if (typing !== undefined) return esc(typing);
  if (draft !== undefined && draft.trim() !== '') return `<span foreground="#1fa855" weight="bold">Brouillon :</span> <span alpha="60%">${esc(draft.replaceAll('\n', ' '))}</span>`;
  return esc(c.preview.replaceAll('\n', ' '));
}

/**
 * Un seul élément déplacé entre `old` et `next` (même contenu sinon) : ses positions. Cas d'une
 * discussion qui remonte en tête : retrait et insertion, sans relier toute la liste.
 */
export function moveOf(old: readonly string[], next: readonly string[]): { from: number; to: number } | null {
  const change = spliceOf(old, next);
  if (change === null || change.remove !== change.insert || change.remove < 2) return null;
  const { at, remove: n } = change;
  const last = at + n - 1;
  // remonté : le dernier du segment passe en premier
  if (next[at] === old[last] && old.slice(at, last).every((k, i) => next[at + 1 + i] === k)) return { from: last, to: at };
  // descendu : le premier passe en dernier
  if (next[last] === old[at] && old.slice(at + 1, last + 1).every((k, i) => next[at + i] === k)) return { from: at, to: last };
  return null;
}

/**
 * Plus petite modification qui transforme `old` en `next` (clés) : préfixe et suffixe communs
 * gardés, le milieu remplacé.
 */
export function spliceOf(old: readonly string[], next: readonly string[]): { at: number; remove: number; insert: number } | null {
  let p = 0;
  while (p < old.length && p < next.length && old[p] === next[p]) p += 1;
  if (p === old.length && p === next.length) return null;
  let s = 0;
  while (s < old.length - p && s < next.length - p && old[old.length - 1 - s] === next[next.length - 1 - s]) s += 1;
  return { at: p, remove: old.length - p - s, insert: next.length - p - s };
}

/** lignes ajoutées par image au plus (un lot dépasse ce que l'écran montre) */
const STEP = 30;

/** Élément du modèle GTK : clé et valeur courante. */
const RowItem = GObject.registerClass(
  class RowItem extends GObject.Object {
    key = '';
    row: SideRow = { kind: 'header' };
  },
);
type RowItem = InstanceType<typeof RowItem>;

const ENTRY: Readonly<Record<EntryId, { icon: string; label: string; tooltip: string }>> = {
  archived: { icon: 'folder-symbolic', label: 'Archivées', tooltip: 'Discussions archivées' },
  statuses: { icon: 'camera-photo-symbolic', label: 'Statuts', tooltip: 'Statuts des contacts' },
  channels: { icon: 'microphone-sensitivity-high-symbolic', label: 'Chaînes', tooltip: 'Chaînes suivies' },
};

const label = (props: Partial<Gtk.Label.ConstructorProps>): Gtk.Label => new Gtk.Label({ xalign: 0, ...props });

interface View<T> {
  readonly root: Gtk.Widget;
  readonly fill: (value: T) => void;
  /** ligne recyclée pour une autre sorte d'élément : abonnements libérés */
  readonly release: () => void;
}

/** Ligne de discussion (widgets construits une fois, remplis à chaque liaison). */
function chatView(store: Store, pictures: Pictures): View<Chat> {
  const root = new Gtk.Box({ spacing: 12, marginTop: 8, marginBottom: 8, marginStart: 8, marginEnd: 8 });
  const avatar = new Adw.Avatar({ size: 44 });
  const name = label({ hexpand: true, ellipsize: Pango.EllipsizeMode.END, cssClasses: ['heading'] });
  const date = new Gtk.Label();
  const preview = label({ useMarkup: true, hexpand: true, ellipsize: Pango.EllipsizeMode.END });
  const muted = new Gtk.Image({ iconName: 'notifications-disabled-symbolic', tooltipText: 'Mode silencieux', cssClasses: ['dim-label'] });
  const pin = new Gtk.Image({ iconName: 'view-pin-symbolic', tooltipText: 'Épinglée', cssClasses: ['dim-label'] });
  const unread = new Gtk.Label({ valign: Gtk.Align.CENTER });
  const text = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, valign: Gtk.Align.CENTER, hexpand: true, spacing: 2 });
  const top = new Gtk.Box({ spacing: 6 });
  top.append(name);
  top.append(date);
  const bottom = new Gtk.Box({ spacing: 6 });
  for (const w of [preview, muted, pin, unread]) bottom.append(w);
  text.append(top);
  text.append(bottom);
  root.append(avatar);
  root.append(text);
  /** photo suivie (une seule discussion à la fois) */
  let picture: { id: string; off: () => void } | null = null;
  const release = (): void => {
    picture?.off();
    picture = null;
  };
  const fill = (c: Chat): void => {
    root.tooltipText = c.name;
    avatar.text = avatarText(c.name);
    avatar.showInitials = /\p{L}/u.test(c.name);
    if (picture?.id !== c.id) {
      release();
      // photo demandée à l'affichage de la ligne seulement
      const texture = pictures.texture(c.id);
      const apply = (): void => avatar.set_custom_image(texture.peek());
      apply();
      picture = { id: c.id, off: texture.subscribe(apply) };
    }
    name.label = c.name;
    date.label = fmtShortDate(c.timestamp);
    date.cssClasses = c.unread > 0 && !isMuted(c) ? ['caption', 'accent'] : ['caption', 'dim-label'];
    // écrit… ; sinon brouillon (discussion non affichée) ; sinon dernier message
    const typing = store.typing.peek().get(c.id);
    const draft = store.current.peek() === c.id ? undefined : store.drafts.peek().get(c.id);
    preview.label = previewMarkup(c, typing, draft);
    // brouillon : couleurs dans le balisage (pas d'atténuation de tout le libellé)
    preview.cssClasses = typing === undefined ? (draft !== undefined && draft.trim() !== '' ? [] : ['dim-label']) : ['accent'];
    muted.visible = isMuted(c);
    pin.visible = c.pinned > 0;
    // nombre de non-lus, ou pastille vide pour « marquée comme non lue »
    unread.label = c.unread > 0 ? String(c.unread) : '';
    unread.visible = c.unread > 0 || c.markedUnread;
    unread.cssClasses = ['unread-badge', ...(isMuted(c) ? ['muted'] : []), ...(c.unread > 0 ? [] : ['dot'])];
  };
  return { root, fill, release };
}

/** rien à libérer */
const noop = (): void => {
  // aucun abonnement
};

/** Message trouvé : discussion, date, auteur et extrait (mots trouvés en gras). */
function hitView(): View<SearchHit> {
  const root = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2, marginTop: 8, marginBottom: 8, marginStart: 12, marginEnd: 8 });
  const chat = label({ hexpand: true, ellipsize: Pango.EllipsizeMode.END, cssClasses: ['heading'] });
  const date = new Gtk.Label({ cssClasses: ['caption', 'dim-label'] });
  const snippet = label({ useMarkup: true, ellipsize: Pango.EllipsizeMode.END, lines: 2, wrap: true, wrapMode: Pango.WrapMode.WORD_CHAR, cssClasses: ['dim-label'] });
  const top = new Gtk.Box({ spacing: 6 });
  top.append(chat);
  top.append(date);
  root.append(top);
  root.append(snippet);
  const fill = (hit: SearchHit): void => {
    const who = hit.fromMe ? 'Vous : ' : hit.senderName === null ? '' : `${hit.senderName} : `;
    chat.label = hit.chatName;
    date.label = fmtShortDate(hit.timestamp);
    snippet.label = `${esc(who)}${snippetMarkup(hit.snippet)}`;
  };
  return { root, fill, release: noop };
}

type EntryRow = Extract<SideRow, { kind: 'entry' }>;

/** Entrée vers une autre vue (bouton plat : icône, nom, compte). */
function entryView(open: (id: EntryId, button: Gtk.Button) => void): View<EntryRow> {
  const root = new Gtk.Button({ cssClasses: ['flat', 'archived-entry'], marginStart: 6, marginEnd: 6 });
  const icon = new Gtk.Image();
  const name = label({ hexpand: true, cssClasses: ['heading'] });
  const count = new Gtk.Label();
  const box = new Gtk.Box({ spacing: 12, marginStart: 14, marginEnd: 4 });
  box.append(icon);
  box.append(name);
  box.append(count);
  root.child = box;
  let id: EntryId = 'archived';
  root.connect('clicked', () => open(id, root));
  const fill = (r: EntryRow): void => {
    id = r.id;
    const e = ENTRY[r.id];
    root.tooltipText = e.tooltip;
    icon.iconName = e.icon;
    name.label = e.label;
    count.label = r.count;
    count.cssClasses = r.accent ? ['accent', 'caption'] : ['dim-label', 'caption'];
  };
  return { root, fill, release: noop };
}

/** Contenu d'une ligne de la liste : une vue par sorte d'élément, créée à la première utilisation. */
interface RowView {
  readonly root: Gtk.Box;
  item: RowItem | null;
  readonly fill: (row: SideRow) => void;
  readonly release: () => void;
}

function rowView(store: Store, pictures: Pictures, open: (id: EntryId, button: Gtk.Button) => void): RowView {
  const root = new Gtk.Box();
  let chat: View<Chat> | null = null;
  let hit: View<SearchHit> | null = null;
  let entry: View<EntryRow> | null = null;
  let header: Gtk.Label | null = null;
  /** vues créées (pas les autres enfants : menu contextuel ouvert sur la ligne) */
  const made: Gtk.Widget[] = [];
  const show = (w: Gtk.Widget): void => {
    for (const c of made) c.visible = c === w;
    if (w.get_parent() === null) {
      root.append(w);
      made.push(w);
    }
    w.visible = true;
    w.hexpand = true;
  };
  const rv: RowView = {
    root,
    item: null,
    fill: (row) => {
      if (row.kind !== 'chat') chat?.release();
      switch (row.kind) {
        case 'chat':
          chat ??= chatView(store, pictures);
          chat.fill(row.chat);
          show(chat.root);
          return;
        case 'hit':
          hit ??= hitView();
          hit.fill(row.hit);
          show(hit.root);
          return;
        case 'entry':
          entry ??= entryView(open);
          entry.fill(row);
          show(entry.root);
          return;
        case 'header':
          // titre des messages trouvés par la recherche
          header ??= label({ label: 'Messages', marginStart: 10, marginTop: 12, marginBottom: 4, cssClasses: ['heading', 'dim-label'] });
          show(header);
          return;
        default:
          row satisfies never;
      }
    },
    release: () => {
      chat?.release();
      rv.item = null;
    },
  };
  return rv;
}

export interface ChatListViewOptions {
  readonly store: Store;
  readonly pictures: Pictures;
  readonly rows: Accessor<readonly SideRow[]>;
  /** clic sur une entrée (Archivées, Statuts, Chaînes) */
  readonly openEntry: (id: EntryId, button: Gtk.Button) => void;
  /** menu contextuel des discussions */
  readonly menu: (list: Gtk.Widget) => ChatMenuAt;
}

/**
 * Liste virtuelle suivant `rows` (à placer directement dans un Gtk.ScrolledWindow) ; renvoie
 * la vue et sa fonction de libération.
 */
export function chatListView({ store, pictures, rows, openEntry, menu }: ChatListViewOptions): { view: Gtk.ListView; dispose: () => void } {
  const model = new Gio.ListStore({ itemType: RowItem.$gtype });
  const items = new Map<string, RowItem>();
  let keys: string[] = [];
  /** lignes liées (visibles ou presque), par clé */
  const bound = new Map<string, RowView>();
  const selection = new Gtk.SingleSelection({ model, autoselect: false, canUnselect: true });
  const factory = new Gtk.SignalListItemFactory();
  const view = new Gtk.ListView({ model: selection, factory, cssClasses: ['navigation-sidebar'] });
  const popup = menu(view);
  /** contenu de chaque ligne de la fabrique */
  // référence forte (une WeakMap sur l'enveloppe JS pourrait perdre la ligne si GJS la recrée)
  const views = new Map<Gtk.ListItem, RowView>();
  const itemOf = (o: GObject.Object | null): RowItem | null => (o instanceof RowItem ? o : null);

  /** action d'un élément (clic, Entrée) */
  const activate = (item: RowItem | null): void => {
    const r = item?.row;
    if (r?.kind === 'chat') store.open(r.chat.id);
    else if (r?.kind === 'hit') store.openAt(r.hit.chatId, r.hit.id, r.hit.timestamp);
  };

  factory.connect('setup', (_f: Gtk.SignalListItemFactory, obj: GObject.Object) => {
    if (!(obj instanceof Gtk.ListItem)) return;
    const rv = rowView(store, pictures, openEntry);
    obj.child = rv.root;
    views.set(obj, rv);
    // clic simple : ouverture (la sélection suit la discussion affichée, voir `select`)
    const click = new Gtk.GestureClick({ button: 1 });
    click.connect('released', (_g: Gtk.GestureClick, n: number) => {
      lastClick = GLib.get_monotonic_time();
      if (n === 1) activate(rv.item);
    });
    rv.root.add_controller(click);
    attachRowMenu(rv.root, popup, () => (rv.item?.row.kind === 'chat' ? rv.item.row.chat.id : null));
  });
  factory.connect('bind', (_f: Gtk.SignalListItemFactory, obj: GObject.Object) => {
    if (!(obj instanceof Gtk.ListItem)) return;
    const rv = views.get(obj);
    const item = itemOf(obj.item);
    if (rv === undefined || item === null) return;
    rv.item = item;
    bound.set(item.key, rv);
    const selectable = item.row.kind === 'chat';
    obj.selectable = selectable;
    obj.activatable = selectable || item.row.kind === 'hit';
    // les entrées sont des boutons : pas de focus sur la ligne autour
    obj.focusable = item.row.kind !== 'entry' && item.row.kind !== 'header';
    rv.fill(item.row);
  });
  factory.connect('teardown', (_f: Gtk.SignalListItemFactory, obj: GObject.Object) => {
    if (obj instanceof Gtk.ListItem) views.delete(obj);
  });
  factory.connect('unbind', (_f: Gtk.SignalListItemFactory, obj: GObject.Object) => {
    if (!(obj instanceof Gtk.ListItem)) return;
    const rv = views.get(obj);
    if (rv === undefined) return;
    if (rv.item !== null && bound.get(rv.item.key) === rv) bound.delete(rv.item.key);
    rv.release();
  });
  // Entrée (le double-clic émet aussi `activate` : déjà ouvert par le premier clic)
  let lastClick = 0;
  view.connect('activate', (_v: Gtk.ListView, position: number) => {
    if (GLib.get_monotonic_time() - lastClick > 600_000) activate(itemOf(model.get_item(position)));
  });

  /** lignes liées remplies à nouveau (saisie, brouillons, discussion affichée) */
  const refill = (): void => {
    for (const rv of bound.values()) if (rv.item !== null) rv.fill(rv.item.row);
  };

  // sélection = discussion affichée (ouverture par notification, raccourcis, déconnexion)
  let selecting = false;
  const select = (): void => {
    const id = store.current.peek();
    const i = id === null ? -1 : keys.indexOf(id);
    selecting = true;
    if (i < 0) selection.unselect_all();
    else if (selection.selected !== i) selection.select_item(i, true);
    selecting = false;
  };
  // sélection changée par la liste elle-même (flèches, clic) : rétablie, l'ouverture passe par activate
  selection.connect('notify::selected', () => {
    if (!selecting) select();
  });

  /** lot suivant attendu (image suivante) : identifiant du rappel */
  let tick = 0;
  /** discussion affichée pas encore dans la liste (lots en cours) : défilement à faire */
  let scrollPending = false;
  const scrollToCurrent = (): void => {
    const i = keys.indexOf(store.current.peek() ?? '');
    scrollPending = i < 0 && store.current.peek() !== null;
    if (i >= 0) view.scroll_to(i, Gtk.ListScrollFlags.NONE, null);
  };
  const sync = (): void => {
    const list = rows.peek();
    const next = list.map((r) => rowKey(r));
    const nextItems = list.map((r, i) => {
      const k = next[i] ?? '';
      let it = items.get(k);
      if (it === undefined) {
        it = new RowItem();
        it.key = k;
      }
      it.row = r;
      return it;
    });
    items.clear();
    for (const it of nextItems) items.set(it.key, it);
    // beaucoup de lignes ajoutées d'un coup (lancement, fin de recherche) : par lots, une image
    // chacun (GTK lie jusqu'à 200 lignes : d'un bloc, l'affichage attendrait toutes)
    const cap = keys.length + STEP;
    if (next.length > cap) {
      next.length = cap;
      nextItems.length = cap;
      if (tick === 0) {
        tick = view.add_tick_callback(() => {
          tick = 0;
          sync();
          return false;
        });
      }
    }
    const change = spliceOf(keys, next);
    const move = moveOf(keys, next);
    keys = next;
    if (move !== null) {
      const it = nextItems[move.to];
      model.remove(move.from);
      if (it !== undefined) model.insert(move.to, it);
    } else if (change !== null) model.splice(change.at, change.remove, nextItems.slice(change.at, change.at + change.insert));
    // éléments restés en place : contenu mis à jour
    refill();
    select();
    if (scrollPending) scrollToCurrent();
  };
  sync();
  const offs = [
    rows.subscribe(sync),
    store.typing.subscribe(refill),
    store.drafts.subscribe(refill),
    store.current.subscribe(() => {
      refill();
      select();
      // discussion affichée visible dans la liste (Alt+Haut / Alt+Bas, notification)
      scrollToCurrent();
    }),
  ];
  return {
    view,
    dispose: () => {
      for (const off of offs) off();
      if (tick !== 0) view.remove_tick_callback(tick);
      tick = 0;
      // lignes déliées : abonnements aux photos libérés
      model.remove_all();
    },
  };
}

// Palette de commandes (Ctrl+P), comme celle de VS Code : discussions récentes et toutes les actions, puis en tapant
// discussions, contacts et actions correspondants ; flèches pour choisir, Entrée pour lancer.
import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';
import type { Chat, Contact } from '../shared/api.ts';
import { errorMessage } from '../shared/errors.ts';
import type { Store } from '../shared/store.ts';
import { avatarText, fold } from './ChatList.tsx';
import { bindAvatar, type Pictures } from './pictures.ts';

/** Action proposée par la palette. */
export interface Command {
  readonly title: string;
  /** icône symbolique */
  readonly icon: string;
  /** autres mots qui la trouvent (« réglages » pour Préférences…) */
  readonly keywords?: string;
  /** raccourci affiché (accélérateur GTK) */
  readonly accel?: string;
  readonly run: () => void;
}

/** Fournisseurs d'actions selon le contexte (liste, discussion ouverte) ; chacun se retire. */
const providers = new Set<() => readonly Command[]>();

/** Actions ajoutées à la palette tant que la fonction de retrait n'est pas appelée. */
export function provideCommands(fn: () => readonly Command[]): () => void {
  providers.add(fn);
  return () => {
    providers.delete(fn);
  };
}

/**
 * Pertinence de `text` pour la recherche `q` (déjà normalisée) : 0 si absente ; plus haut au
 * début du texte, puis au début d'un mot, puis ailleurs.
 */
export function score(q: string, text: string): number {
  if (q === '') return 1;
  const t = fold(text);
  const i = t.indexOf(q);
  if (i < 0) return 0;
  if (i === 0) return 3;
  return /[\s\p{P}]/u.test(t[i - 1] ?? '') ? 2 : 1;
}

/** Discussions proposées sans saisie (les plus récentes, épinglées d'abord : ordre de la liste). */
const RECENT = 8;
/** Résultats au plus par sorte. */
const MAX_CHATS = 8;
const MAX_CONTACTS = 5;
const MAX_COMMANDS = 8;

/** `items` retenus par la recherche, les plus pertinents d'abord (ordre d'origine à égalité). */
export function ranked<T>(items: readonly T[], q: string, text: (it: T) => string, max: number): T[] {
  return items
    .map((it, i) => ({ it, i, s: score(q, text(it)) }))
    .filter((x) => x.s > 0)
    .toSorted((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, max)
    .map((x) => x.it);
}

const header = (label: string): Gtk.ListBoxRow =>
  new Gtk.ListBoxRow({
    child: new Gtk.Label({ label, xalign: 0, marginStart: 12, marginTop: 10, marginBottom: 4, cssClasses: ['heading', 'dim-label'] }),
    selectable: false,
    activatable: false,
    focusable: false,
  });

/** Ouvre la palette ; `commands` : actions de l'application (toujours proposées). */
/** Palette ouverte (Ctrl+P de nouveau : refermée, pas une seconde par-dessus). */
let opened: Adw.Dialog | null = null;

export function openCommandPalette(parent: Gtk.Widget, store: Store, pictures: Pictures, commands: readonly Command[]): void {
  if (opened !== null) {
    opened.close();
    return;
  }
  let contacts: Contact[] = [];
  const search = new Gtk.SearchEntry({ placeholderText: 'Discussion, contact ou action…', marginStart: 12, marginEnd: 12, marginTop: 12 });
  const list = new Gtk.ListBox({ selectionMode: Gtk.SelectionMode.SINGLE, cssClasses: ['navigation-sidebar'], marginStart: 6, marginEnd: 6, marginBottom: 6 });
  const empty = new Gtk.Label({ label: 'Aucun résultat', cssClasses: ['dim-label'], marginTop: 24, visible: false });
  const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6 });
  box.append(search);
  const inner = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
  inner.append(list);
  inner.append(empty);
  const scroller = new Gtk.ScrolledWindow({ child: inner, vexpand: true, hscrollbarPolicy: Gtk.PolicyType.NEVER });
  box.append(scroller);
  const dialog = new Adw.Dialog({ title: 'Palette de commandes', child: box, contentWidth: 520, contentHeight: 480 });
  /** action de chaque ligne */
  const actions = new Map<Gtk.ListBoxRow, () => void>();

  const add = (row: Gtk.ListBoxRow, run: () => void, key: string): void => {
    list.append(row);
    rowKeys.set(row, key);
    actions.set(row, () => {
      dialog.close();
      run();
    });
  };
  const chatRow = (c: Chat): Adw.ActionRow => {
    const row = new Adw.ActionRow({
      title: GLib.markup_escape_text(c.name, -1),
      subtitle: GLib.markup_escape_text(c.preview.replaceAll('\n', ' '), -1),
      activatable: true,
    });
    row.subtitleLines = 1;
    const avatar = new Adw.Avatar({ size: 32, text: avatarText(c.name), showInitials: /\p{L}/u.test(c.name) });
    bindAvatar(avatar, pictures.texture(c.id));
    row.add_prefix(avatar);
    return row;
  };
  const contactRow = (c: Contact): Adw.ActionRow => {
    const row = new Adw.ActionRow({ title: GLib.markup_escape_text(c.name, -1), subtitle: 'Nouvelle discussion', activatable: true });
    const avatar = new Adw.Avatar({ size: 32, text: avatarText(c.name), showInitials: /\p{L}/u.test(c.name) });
    bindAvatar(avatar, pictures.texture(c.id));
    row.add_prefix(avatar);
    return row;
  };
  const commandRow = (c: Command): Adw.ActionRow => {
    const row = new Adw.ActionRow({ title: GLib.markup_escape_text(c.title, -1), activatable: true });
    row.add_prefix(new Gtk.Image({ iconName: c.icon }));
    if (c.accel !== undefined) {
      const [, key, mods] = Gtk.accelerator_parse(c.accel);
      row.add_suffix(
        new Gtk.Label({
          label: Gtk.accelerator_get_label(key, mods ?? Gdk.ModifierType.NO_MODIFIER_MASK),
          cssClasses: ['dim-label', 'caption'],
          ellipsize: Pango.EllipsizeMode.END,
        }),
      );
    }
    return row;
  };

  /** clé de chaque ligne (sélection retrouvée après un nouveau rendu) */
  const rowKeys = new Map<Gtk.ListBoxRow, string>();
  const render = (): void => {
    const before = list.get_selected_row();
    const kept = before === null ? undefined : rowKeys.get(before);
    rowKeys.clear();
    for (let c = list.get_first_child(); c !== null; c = list.get_first_child()) list.remove(c);
    actions.clear();
    const q = fold(search.text.trim());
    const chats = store.chats.peek().filter((c) => !c.id.endsWith('@broadcast'));
    const shownChats = q === '' ? chats.filter((c) => !c.archived).slice(0, RECENT) : ranked(chats, q, (c) => c.name, MAX_CHATS);
    if (shownChats.length > 0) list.append(header(q === '' ? 'Discussions récentes' : 'Discussions'));
    for (const c of shownChats) add(chatRow(c), () => store.open(c.id), `chat:${c.id}`);
    if (q !== '') {
      // contacts du carnet sans discussion (les autres sont déjà dans les discussions)
      const known = new Set(chats.map((c) => c.id));
      const people = ranked(
        contacts.filter((c) => !known.has(c.id)),
        q,
        (c) => c.name,
        MAX_CONTACTS,
      );
      if (people.length > 0) list.append(header('Contacts'));
      for (const c of people) add(contactRow(c), () => store.startChat(c.id, c.name), `contact:${c.id}`);
    }
    // fournisseur le plus récent d'abord : le plus précis (discussion ouverte avant la liste)
    const all = [...[...providers].toReversed().flatMap((p) => p()), ...commands];
    // sans saisie : toutes les actions, sous les discussions récentes (contexte d'abord : sélection,
    // discussion ouverte, liste, puis application)
    const found = q === '' ? all : ranked(all, q, (c) => `${c.title} ${c.keywords ?? ''}`, MAX_COMMANDS);
    if (found.length > 0) list.append(header('Actions'));
    for (const c of found) add(commandRow(c), c.run, `action:${c.title}`);
    empty.visible = actions.size === 0;
    // même ligne qu'avant si elle est encore là (contacts arrivés pendant la navigation), sinon
    // le premier résultat : Entrée le lance
    const again = kept === undefined ? undefined : [...rowKeys].find(([, k]) => k === kept)?.[0];
    const first = again ?? [...actions.keys()][0];
    if (first !== undefined) list.select_row(first);
  };

  list.connect('row-activated', (_l: Gtk.ListBox, row: Gtk.ListBoxRow) => actions.get(row)?.());
  search.connect('search-changed', render);
  search.connect('activate', () => {
    const row = list.get_selected_row();
    if (row !== null) actions.get(row)?.();
  });
  // Échap (capté par le champ de recherche) : fenêtre fermée
  search.connect('stop-search', () => {
    dialog.close();
  });
  // flèches dans le champ de recherche : résultat précédent / suivant
  const keys = new Gtk.EventControllerKey();
  keys.connect('key-pressed', (_c: Gtk.EventControllerKey, keyval: number) => {
    if (keyval !== Gdk.KEY_Down && keyval !== Gdk.KEY_Up) return false;
    const rows = [...actions.keys()];
    // rien de choisi : la première ligne (Bas) ou la dernière (Haut)
    const selected = list.get_selected_row();
    const at = selected === null ? -1 : rows.indexOf(selected);
    const target = at < 0 ? (keyval === Gdk.KEY_Down ? 0 : rows.length - 1) : at + (keyval === Gdk.KEY_Down ? 1 : -1);
    const next = rows[Math.max(0, Math.min(rows.length - 1, target))];
    if (next !== undefined) {
      list.select_row(next);
      // ligne amenée à l'écran
      const [ok, bounds] = next.compute_bounds(inner);
      if (ok) {
        const adj = scroller.vadjustment;
        const top = bounds.get_y();
        const bottom = top + bounds.get_height();
        if (top < adj.value) adj.value = top;
        else if (bottom > adj.value + adj.pageSize) adj.value = bottom - adj.pageSize;
      }
    }
    return true;
  });
  search.add_controller(keys);
  render();
  // contacts du carnet : chargés en arrière-plan (la palette s'ouvre tout de suite)
  void (async (): Promise<void> => {
    try {
      contacts = await store.client.contacts();
      if (search.text.trim() !== '') render();
    } catch (error) {
      console.error(`contacts : ${errorMessage(error)}`);
    }
  })();
  opened = dialog;
  dialog.connect('closed', () => {
    opened = null;
  });
  dialog.set_focus(search);
  dialog.present(parent);
}

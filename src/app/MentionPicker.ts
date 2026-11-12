// Mentions dans la zone de saisie d'un groupe : « @ » ouvre la liste des membres (filtrée à la
// frappe) ; le choix insère « @Nom ». À l'envoi, « @Nom » devient « @numéro » et la personne est
// mentionnée (notifiée par WhatsApp), comme sur le téléphone.
import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import Graphene from 'gi://Graphene';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';
import { type Participant, replaceMention } from '../shared/api.ts';
import { errorMessage } from '../shared/errors.ts';
import { mentionQuery } from '../shared/format.ts';
import type { Store } from '../shared/store.ts';
import { fold } from './ChatList.tsx';
import { bindAvatar, type Pictures } from './pictures.ts';

/** Membres proposés au plus. */
const LIMIT = 8;

/** Nom inséré pour une personne (sans le « ~ » des noms publics). */
export const mentionName = (name: string): string => name.replace(/^~\s*/u, '').trim();

/** Membres correspondant au texte tapé après « @ » (début d'un mot du nom ou du numéro). */
export function matchMembers(members: readonly Participant[], query: string): Participant[] {
  const q = fold(query);
  return members
    .filter((p) => !p.me)
    .filter((p) => q === '' || fold(mentionName(p.name)).split(/\s+/u).some((w) => w.startsWith(q)) || (p.id.split('@')[0] ?? '').startsWith(q))
    .slice(0, LIMIT);
}

/** Texte envoyé et personnes mentionnées : chaque « @Nom » choisi devient « @numéro ». */
export function resolveMentions(text: string, chosen: ReadonlyMap<string, string>): { text: string; mentions: string[] } {
  let out = text;
  const mentions: string[] = [];
  // noms les plus longs d'abord (« @Alice Martin » avant « @Alice »)
  for (const [name, jid] of [...chosen].toSorted((a, b) => b[0].length - a[0].length)) {
    const next = replaceMention(out, name, jid.split('@')[0] ?? jid);
    if (next === out) continue;
    out = next;
    mentions.push(jid);
  }
  return { text: out, mentions };
}

export interface MentionPicker {
  /** touche de la zone de saisie : true si la liste l'a prise (flèches, Entrée, Tab, Échap) */
  key: (keyval: number) => boolean;
  /** texte modifié : liste ouverte, filtrée ou fermée */
  update: () => void;
  /** mentions choisies dans une discussion (nom inséré → identifiant) */
  chosen: (chatId: string) => Map<string, string>;
  /** discussion envoyée : ses mentions oubliées */
  sent: (chatId: string) => void;
  close: () => void;
}

/** Liste des membres attachée à la zone de saisie (groupes seulement). */
export function mentionPicker(view: Gtk.TextView, store: Store, pictures: Pictures, chatId: () => string | null): MentionPicker {
  const members = new Map<string, readonly Participant[]>();
  const loading = new Set<string>();
  /** par discussion : le brouillon garde ses mentions d'une discussion à l'autre */
  const byChat = new Map<string, Map<string, string>>();
  const chosen = (id: string): Map<string, string> => {
    let m = byChat.get(id);
    if (m === undefined) {
      m = new Map();
      byChat.set(id, m);
    }
    return m;
  };
  const list = new Gtk.ListBox({ selectionMode: Gtk.SelectionMode.SINGLE, cssClasses: ['navigation-sidebar'] });
  const popover = new Gtk.Popover({ child: list, autohide: false, hasArrow: false, position: Gtk.PositionType.TOP, halign: Gtk.Align.START, canFocus: false, widthRequest: 260 });
  // pas un enfant de la zone de texte : GtkTextView ne sait pas retirer un enfant qui n'est pas
  // le sien (boucle d'avertissements sans fin à la fermeture de la fenêtre, processus jamais
  // terminé) ; rattachée au conteneur de la zone, dès qu'elle est placée
  const attach = (): void => {
    const host = view.get_parent()?.get_parent() ?? null;
    if (host !== null && popover.get_parent() === null) popover.set_parent(host);
  };
  const detach = (): void => {
    if (popover.get_parent() !== null) popover.unparent();
  };
  view.connect('realize', attach);
  view.connect('unrealize', detach);
  attach();
  let shown: Participant[] = [];
  let at = -1;

  const close = (): void => {
    popover.popdown();
    shown = [];
  };
  const insert = (p: Participant): void => {
    const buffer = view.buffer;
    const name = mentionName(p.name);
    const start = buffer.get_iter_at_offset(at);
    const end = buffer.get_iter_at_mark(buffer.get_insert());
    buffer.delete(start, end);
    buffer.insert_at_cursor(`@${name} `, -1);
    const id = chatId();
    if (id !== null) chosen(id).set(name, p.id);
    close();
  };
  list.connect('row-activated', (_l: Gtk.ListBox, row: Gtk.ListBoxRow) => {
    const p = shown[row.get_index()];
    if (p !== undefined) insert(p);
    view.grab_focus();
  });

  const render = (): void => {
    list.remove_all();
    for (const p of shown) {
      const box = new Gtk.Box({ spacing: 8, marginTop: 4, marginBottom: 4 });
      const avatar = new Adw.Avatar({ size: 24, text: mentionName(p.name), showInitials: true });
      bindAvatar(avatar, pictures.texture(p.id));
      box.append(avatar);
      box.append(new Gtk.Label({ label: mentionName(p.name), xalign: 0, hexpand: true, ellipsize: Pango.EllipsizeMode.END }));
      const row = new Gtk.ListBoxRow({ child: box });
      row.update_property([Gtk.AccessibleProperty.LABEL], [`Mentionner ${mentionName(p.name)}`]);
      list.append(row);
    }
    list.select_row(list.get_row_at_index(0));
  };

  const update = (): void => {
    const id = chatId();
    if (id?.endsWith('@g.us') !== true) {
      close();
      return;
    }
    const buffer = view.buffer;
    const cursor = buffer.get_iter_at_mark(buffer.get_insert());
    const before = buffer.get_text(buffer.get_start_iter(), cursor, false);
    const q = mentionQuery(before);
    if (q === null) {
      close();
      return;
    }
    const known = members.get(id);
    if (known === undefined) {
      // membres du groupe : demandés une fois, la liste s'ouvre à leur arrivée
      if (!loading.has(id)) {
        loading.add(id);
        void (async (): Promise<void> => {
          try {
            members.set(id, (await store.client.info(id)).participants);
            if (chatId() === id) update();
          } catch (error) {
            console.error(`membres du groupe : ${errorMessage(error)}`);
          } finally {
            loading.delete(id);
          }
        })();
      }
      return;
    }
    at = q.at;
    shown = matchMembers(known, q.query);
    if (shown.length === 0) {
      close();
      return;
    }
    render();
    // sous le « @ » tapé
    const rect = view.get_iter_location(buffer.get_iter_at_offset(at));
    const [x, y] = view.buffer_to_window_coords(Gtk.TextWindowType.WIDGET, rect.x, rect.y);
    attach();
    const host = popover.get_parent();
    if (host === null) return;
    // coordonnées de la zone de texte → celles du conteneur
    const [ok, point] = view.compute_point(host, new Graphene.Point({ x, y }));
    popover.set_pointing_to(new Gdk.Rectangle({ x: ok ? Math.round(point.x) : x, y: ok ? Math.round(point.y) : y, width: 1, height: rect.height }));
    popover.popup();
  };

  const key = (keyval: number): boolean => {
    if (!popover.visible || shown.length === 0) return false;
    const row = list.get_selected_row();
    const index = row?.get_index() ?? 0;
    if (keyval === Gdk.KEY_Down || keyval === Gdk.KEY_Up) {
      const next = (index + (keyval === Gdk.KEY_Down ? 1 : -1) + shown.length) % shown.length;
      list.select_row(list.get_row_at_index(next));
      return true;
    }
    if (keyval === Gdk.KEY_Return || keyval === Gdk.KEY_KP_Enter || keyval === Gdk.KEY_Tab) {
      const p = shown[index];
      if (p !== undefined) insert(p);
      return true;
    }
    if (keyval === Gdk.KEY_Escape) {
      close();
      return true;
    }
    return false;
  };

  // curseur déplacé (flèches, clic) : liste refiltrée ou fermée
  view.buffer.connect('notify::cursor-position', () => {
    if (popover.visible) update();
  });
  // focus perdu : fermée
  const focus = new Gtk.EventControllerFocus();
  focus.connect('leave', close);
  view.add_controller(focus);
  return {
    key,
    update,
    chosen,
    sent: (id) => {
      byChat.delete(id);
    },
    close,
  };
}

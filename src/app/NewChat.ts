// Nouvelle discussion : un contact du carnet, ou un numéro vérifié sur WhatsApp.
import Adw from 'gi://Adw?version=1';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import { type Contact, formatPhone, phoneDigits } from '../shared/api.ts';
import { errorMessage } from '../shared/errors.ts';
import type { Store } from '../shared/store.ts';
import { avatarText, fold } from './ChatList.tsx';
import { bindAvatar, type Pictures } from './pictures.ts';

/** Contacts retenus par la recherche (nom ou numéro). */
export function matchContacts(contacts: readonly Contact[], query: string): Contact[] {
  const q = fold(query.trim());
  if (q === '') return [...contacts];
  const digits = query.replaceAll(/\D/gu, '');
  return contacts.filter((c) => fold(c.name).includes(q) || (digits.length >= 3 && c.id.split('@')[0]?.includes(digits) === true));
}

/** Contacts affichés au plus (le carnet peut en compter des milliers). */
const MAX_ROWS = 200;

function contactRow(c: Contact, pictures: Pictures): Adw.ActionRow {
  const row = new Adw.ActionRow({ title: GLib.markup_escape_text(c.name, -1), subtitle: formatPhone(c.id.split('@')[0] ?? ''), activatable: true });
  const avatar = new Adw.Avatar({ size: 32, text: avatarText(c.name), showInitials: /\p{L}/u.test(c.name) });
  bindAvatar(avatar, pictures.texture(c.id));
  row.add_prefix(avatar);
  return row;
}

/** Fenêtre « Nouvelle discussion ». */
export function openNewChat(parent: Gtk.Widget, store: Store, pictures: Pictures, toast: (t: string) => void): void {
  let contacts: Contact[] = [];
  const search = new Gtk.SearchEntry({ placeholderText: 'Nom ou numéro (+33 6 12 34 56 78)', marginStart: 12, marginEnd: 12, marginTop: 6 });
  const list = new Gtk.ListBox({ selectionMode: Gtk.SelectionMode.NONE, cssClasses: ['boxed-list'], marginStart: 12, marginEnd: 12, marginTop: 6, marginBottom: 12, valign: Gtk.Align.START });
  const status = new Gtk.Label({ wrap: true, cssClasses: ['dim-label'], marginTop: 24, marginStart: 12, marginEnd: 12 });
  const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
  box.append(search);
  const inner = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
  inner.append(list);
  inner.append(status);
  box.append(new Gtk.ScrolledWindow({ child: inner, vexpand: true, hscrollbarPolicy: Gtk.PolicyType.NEVER }));
  const header = new Adw.HeaderBar();
  const view = new Adw.ToolbarView({ content: box });
  view.add_top_bar(header);
  const dialog = new Adw.Dialog({ title: 'Nouvelle discussion', child: view, contentWidth: 420, contentHeight: 560 });

  const start = (id: string, name: string): void => {
    dialog.close();
    store.startChat(id, name);
  };
  /** numéro saisi : vérifié sur WhatsApp avant d'ouvrir la discussion */
  const startNumber = async (digits: string): Promise<void> => {
    status.label = 'Vérification du numéro…';
    try {
      const id = await store.client.lookup(digits);
      if (id === null) {
        status.label = `${formatPhone(digits)} n’a pas de compte WhatsApp.`;
        return;
      }
      start(id, formatPhone(digits));
    } catch (error) {
      status.label = '';
      toast(`Vérification impossible : ${errorMessage(error)}`);
    }
  };
  const render = (): void => {
    for (let c = list.get_first_child(); c !== null; c = list.get_first_child()) list.remove(c);
    const digits = phoneDigits(search.text);
    if (digits !== null) {
      const row = new Adw.ActionRow({ title: `Discuter avec ${formatPhone(digits)}`, subtitle: 'Le numéro sera vérifié sur WhatsApp', activatable: true });
      row.add_prefix(new Gtk.Image({ iconName: 'call-start-symbolic' }));
      row.connect('activated', () => void startNumber(digits));
      list.append(row);
    }
    const found = matchContacts(contacts, search.text);
    for (const c of found.slice(0, MAX_ROWS)) {
      const row = contactRow(c, pictures);
      row.connect('activated', () => start(c.id, c.name));
      list.append(row);
    }
    list.visible = list.get_first_child() !== null;
    status.label = list.visible ? '' : search.text.trim() === '' ? 'Aucun contact dans le carnet' : 'Aucun contact trouvé. Saisissez un numéro avec l’indicatif du pays.';
  };
  search.connect('search-changed', render);
  // Entrée : premier résultat (numéro ou contact)
  search.connect('activate', () => {
    const first = list.get_first_child();
    if (first instanceof Adw.ActionRow) first.activate();
  });
  status.label = 'Chargement des contacts…';
  list.visible = false;
  void (async (): Promise<void> => {
    try {
      contacts = await store.client.contacts();
      render();
    } catch (error) {
      status.label = `Contacts indisponibles : ${errorMessage(error)}`;
    }
  })();
  dialog.set_focus(search);
  dialog.present(parent);
}

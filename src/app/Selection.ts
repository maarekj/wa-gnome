// Plusieurs messages à la fois : copie des textes, suppression, transfert vers d'autres discussions.
import Adw from 'gi://Adw?version=1';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';
import { type Chat, type Message, previewOf, REVOKE_WINDOW_S } from '../shared/api.ts';
import { errorMessage } from '../shared/errors.ts';
import type { Store } from '../shared/store.ts';
import { avatarText, fold } from './ChatList.tsx';
import { bindAvatar, type Pictures } from './pictures.ts';

/** Texte d'un message pour la copie (genre du média s'il n'a pas de texte). */
const textOf = (m: Message): string => (m.text === '' ? previewOf(m) : m.text);

/**
 * Texte copié : le texte seul pour un message ; sinon une ligne par message,
 * `[06/11/2026 14:05] Alice : texte`, comme WhatsApp.
 */
export function copyText(messages: readonly Message[], chatName: string): string {
  if (messages.length === 1 && messages[0] !== undefined) return textOf(messages[0]);
  return messages
    .map((m) => {
      const when = GLib.DateTime.new_from_unix_local(m.timestamp)?.format('%d/%m/%Y %H:%M') ?? '';
      const who = m.fromMe ? 'Moi' : (m.senderName ?? m.sender?.split('@')[0] ?? chatName);
      return `[${when}] ${who} : ${textOf(m)}`;
    })
    .join('\n');
}

/** « Supprimer pour tous » possible : uniquement mes messages, dans le délai de WhatsApp. */
export const canRevokeAll = (messages: readonly Message[], now = Date.now() / 1000): boolean => messages.length > 0 && messages.every((m) => m.fromMe && !m.deleted && now - m.timestamp < REVOKE_WINDOW_S);

/** Libellé « 3 messages ». */
export const countText = (n: number): string => (n === 1 ? '1 message' : `${n} messages`);

/** Suppression de plusieurs messages, après confirmation ; `done` appelé une fois lancée. */
export function confirmRemoveMany(parent: Gtk.Widget, store: Store, messages: readonly Message[], toast: (t: string) => void, done: () => void): void {
  const forAll = canRevokeAll(messages);
  const dialog = new Adw.AlertDialog({
    heading: `Supprimer ${countText(messages.length)} ?`,
    body: forAll ? '« Pour tous » les remplace par « Ce message a été supprimé » chez tous les participants.' : 'Ils seront supprimés de cet ordinateur et de vos autres appareils. Les autres participants les verront toujours.',
  });
  dialog.add_response('cancel', 'Annuler');
  dialog.add_response('delete-for-me', 'Pour moi');
  dialog.set_response_appearance('delete-for-me', Adw.ResponseAppearance.DESTRUCTIVE);
  if (forAll) {
    dialog.add_response('revoke', 'Pour tous');
    dialog.set_response_appearance('revoke', Adw.ResponseAppearance.DESTRUCTIVE);
  }
  dialog.connect('response', (_d: Adw.AlertDialog, response: string) => {
    if (response !== 'revoke' && response !== 'delete-for-me') return;
    done();
    void runAll(messages, (m) => store.client.messageAction(m.chatId, m.id, { action: response }), 'Suppression', toast);
  });
  dialog.present(parent);
}

/** Actions lancées l'une après l'autre ; échecs regroupés dans un seul message. */
async function runAll(messages: readonly Message[], action: (m: Message) => Promise<void>, what: string, toast: (t: string) => void): Promise<number> {
  let failed = 0;
  let last = '';
  for (const m of messages) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- dans l'ordre de la discussion
      await action(m);
    } catch (error) {
      failed += 1;
      last = errorMessage(error);
    }
  }
  if (failed > 0) toast(`${what} impossible pour ${countText(failed)} : ${last}`);
  return messages.length - failed;
}

/** Ligne d'une discussion dans la fenêtre de transfert : photo, nom, case à cocher. */
function chatRow(c: Chat, pictures: Pictures, checked: Set<string>, changed: () => void): Adw.ActionRow {
  const row = new Adw.ActionRow({ title: GLib.markup_escape_text(c.name, -1), activatable: true });
  const avatar = new Adw.Avatar({ size: 32, text: avatarText(c.name), showInitials: /\p{L}/u.test(c.name) });
  bindAvatar(avatar, pictures.texture(c.id));
  row.add_prefix(avatar);
  const check = new Gtk.CheckButton({ valign: Gtk.Align.CENTER, cssClasses: ['selection-mode'] });
  row.add_suffix(check);
  row.set_activatable_widget(check);
  check.connect('toggled', () => {
    if (check.active) checked.add(c.id);
    else checked.delete(c.id);
    changed();
  });
  return row;
}

/** Fenêtre de transfert : choix des discussions (recherche, plusieurs), puis envoi. */
export function openForward(parent: Gtk.Widget, store: Store, pictures: Pictures, messages: readonly Message[], toast: (t: string) => void, done: () => void): void {
  const checked = new Set<string>();
  const send = new Gtk.Button({ label: 'Transférer', sensitive: false, cssClasses: ['suggested-action'] });
  const chosen = new Gtk.Label({ xalign: 0, ellipsize: Pango.EllipsizeMode.END, cssClasses: ['caption', 'dim-label'], marginStart: 12, marginEnd: 12, marginTop: 6, marginBottom: 6 });
  const chats = store.chats.peek().filter((c) => !c.id.endsWith('@broadcast'));
  const names = new Map(chats.map((c) => [c.id, c.name]));
  const changed = (): void => {
    send.sensitive = checked.size > 0;
    chosen.label = checked.size === 0 ? 'Choisissez une ou plusieurs discussions' : [...checked].map((id) => names.get(id) ?? id).join(', ');
  };
  changed();
  const list = new Gtk.ListBox({ selectionMode: Gtk.SelectionMode.NONE, cssClasses: ['boxed-list'], marginStart: 12, marginEnd: 12, marginTop: 6, marginBottom: 12, valign: Gtk.Align.START });
  const rows = chats.map((c) => {
    const row = chatRow(c, pictures, checked, changed);
    list.append(row);
    return { row, key: fold(c.name) };
  });
  const search = new Gtk.SearchEntry({ placeholderText: 'Rechercher une discussion', marginStart: 12, marginEnd: 12, marginTop: 6 });
  // Échap (capté par le champ de recherche) : fenêtre fermée
  search.connect('stop-search', () => {
    dialog.close();
  });
  search.connect('search-changed', () => {
    const q = fold(search.text.trim());
    for (const { row, key } of rows) row.visible = q === '' || key.includes(q);
  });
  const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
  box.append(search);
  box.append(new Gtk.ScrolledWindow({ child: list, vexpand: true, hscrollbarPolicy: Gtk.PolicyType.NEVER }));
  const header = new Adw.HeaderBar({ showEndTitleButtons: false, showStartTitleButtons: false });
  const cancel = new Gtk.Button({ label: 'Annuler' });
  header.pack_start(cancel);
  header.pack_end(send);
  const view = new Adw.ToolbarView({ content: box });
  view.add_top_bar(header);
  view.add_bottom_bar(chosen);
  const dialog = new Adw.Dialog({ title: `Transférer ${countText(messages.length)}`, child: view, contentWidth: 420, contentHeight: 560 });
  cancel.connect('clicked', () => {
    dialog.close();
  });
  send.connect('clicked', () => {
    const to = [...checked];
    dialog.close();
    done();
    void (async (): Promise<void> => {
      const ok = await runAll(messages, (m) => store.client.messageAction(m.chatId, m.id, { action: 'forward', to }), 'Transfert', toast);
      if (ok > 0) toast(`${countText(ok)} transféré${ok > 1 ? 's' : ''}`);
    })();
  });
  dialog.set_focus(search);
  dialog.present(parent);
}

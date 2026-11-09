// Sélecteur de compte (en-tête de la liste des discussions) : photo du compte affiché ; liste des
// comptes avec leurs non-lus, et « Ajouter un compte ».
import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';
import { onCleanup } from 'gnim';
import { errorMessage } from '../shared/errors.ts';
import type { Store } from '../shared/store.ts';
import { type Accounts, accountName, unreadChats } from './Accounts.ts';

/** Ligne d'un compte dans la liste. */
function accountRow(accounts: Accounts, store: Store, active: boolean): Gtk.ListBoxRow {
  const box = new Gtk.Box({ spacing: 10, marginTop: 6, marginBottom: 6, marginStart: 6, marginEnd: 6 });
  const name = accountName(store);
  const me = store.status.peek().me;
  const avatar = new Adw.Avatar({ size: 32, text: me === null ? '' : name, showInitials: true });
  if (me !== null) avatar.set_custom_image(accounts.pictures(store).texture(me.id).peek());
  box.append(avatar);
  box.append(new Gtk.Label({ label: name, xalign: 0, hexpand: true, ellipsize: Pango.EllipsizeMode.END }));
  const unread = unreadChats(store.chats.peek());
  if (unread > 0) box.append(new Gtk.Label({ label: String(unread), cssClasses: ['unread-badge'], valign: Gtk.Align.CENTER }));
  if (active) box.append(new Gtk.Image({ iconName: 'object-select-symbolic', tooltipText: 'Compte affiché' }));
  const row = new Gtk.ListBoxRow({ child: box, tooltipText: `Afficher le compte ${name}` });
  row.update_property([Gtk.AccessibleProperty.LABEL], [name]);
  return row;
}

/** Bouton du sélecteur de compte. */
export function accountSwitcher(accounts: Accounts, toast: (t: string) => void): Gtk.MenuButton {
  const store = accounts.active.peek();
  /** nom affiché sur l'avatar : initiales du compte, icône s'il n'est pas encore appairé */
  const initials = (): string => (store.status.peek().me === null ? '' : accountName(store));
  const avatar = new Adw.Avatar({ size: 24, text: initials(), showInitials: true });
  // photo du compte, dès qu'il est connu (appairage fait après la création du bouton)
  let photo: { id: string; off: () => void } | null = null;
  const sync = (): void => {
    avatar.text = initials();
    const id = store.status.peek().me?.id ?? null;
    if (id === photo?.id) return;
    photo?.off();
    photo = null;
    avatar.set_custom_image(null);
    if (id === null) return;
    const texture = accounts.pictures(store).texture(id);
    avatar.set_custom_image(texture.peek());
    photo = { id, off: texture.subscribe(() => avatar.set_custom_image(texture.peek())) };
  };
  sync();
  onCleanup(store.status.subscribe(sync));
  onCleanup(() => photo?.off());
  // pastille : messages non lus dans un autre compte
  const dot = new Gtk.Label({ cssClasses: ['unread-badge', 'dot'], halign: Gtk.Align.END, valign: Gtk.Align.START, visible: false, canTarget: false });
  const overlay = new Gtk.Overlay({ child: avatar });
  overlay.add_overlay(dot);
  let watched: (() => void)[] = [];
  const updateDot = (): void => {
    dot.visible = accounts.list.peek().some((s) => s !== store && unreadChats(s.chats.peek()) > 0);
  };
  const watch = (): void => {
    for (const off of watched) off();
    watched = accounts.list.peek().map((s) => s.chats.subscribe(updateDot));
    updateDot();
  };
  watch();
  onCleanup(accounts.list.subscribe(watch));
  onCleanup(() => {
    for (const off of watched) off();
  });
  const button = new Gtk.MenuButton({ child: overlay, tooltipText: 'Comptes', cssClasses: ['flat', 'account-switcher'] });
  // nom accessible : pas d'icône ni de libellé dont le déduire
  button.update_property([Gtk.AccessibleProperty.LABEL], ['Comptes']);
  const inner = button.get_first_child();
  if (inner !== null) inner.update_property([Gtk.AccessibleProperty.LABEL], ['Comptes']);
  const list = new Gtk.ListBox({ selectionMode: Gtk.SelectionMode.NONE, cssClasses: ['boxed-list'] });
  const add = new Gtk.Button({ label: 'Ajouter un compte', cssClasses: ['flat'] });
  const content = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 8, widthRequest: 280 });
  content.append(list);
  content.append(add);
  const popover = new Gtk.Popover({ child: content });
  button.popover = popover;
  let shown: Store[] = [];
  // liste refaite à chaque ouverture : noms, non-lus et comptes à jour
  popover.connect('show', () => {
    list.remove_all();
    shown = [...accounts.list.peek()];
    for (const s of shown) list.append(accountRow(accounts, s, s === accounts.active.peek()));
  });
  list.connect('row-activated', (_l: Gtk.ListBox, row: Gtk.ListBoxRow) => {
    const s = shown[row.get_index()];
    popover.popdown();
    if (s !== undefined) accounts.select(s);
  });
  add.connect('clicked', () => {
    popover.popdown();
    accounts.add().catch((error: unknown) => {
      toast(`Ajout impossible : ${errorMessage(error)}`);
    });
  });
  return button;
}

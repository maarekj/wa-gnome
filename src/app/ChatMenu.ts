// Menu contextuel d'une discussion (clic droit, appui long), comme dans WhatsApp Web :
// archiver, mode silencieux, épingler, non lue, effacer, supprimer, quitter le groupe.
import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gdk from 'gi://Gdk?version=4.0';
import Graphene from 'gi://Graphene';
import Gtk from 'gi://Gtk?version=4.0';
import { type Chat, type ChatAction, isMuted, MAX_PINNED } from '../shared/api.ts';
import { errorMessage } from '../shared/errors.ts';
import type { Store } from '../shared/store.ts';

const HOUR = 3_600_000;

/** Durées du mode silencieux proposées (comme WhatsApp). */
export const MUTE_CHOICES = [
  { action: 'mute-8h', label: '8 heures', until: (now: number) => now + 8 * HOUR },
  { action: 'mute-week', label: '1 semaine', until: (now: number) => now + 7 * 24 * HOUR },
  { action: 'mute-always', label: 'Toujours', until: () => -1 },
] as const;

/** Modèle du menu d'une discussion (actions `chat.*`, cible : son identifiant). */
export function chatMenu(chat: Chat, pinnedCount: number, now = Date.now()): Gio.Menu {
  const target = new GLib.Variant('s', chat.id);
  const item = (label: string, action: string): Gio.MenuItem => {
    const it = Gio.MenuItem.new(label, null);
    it.set_action_and_target_value(`chat.${action}`, target);
    return it;
  };
  const main = new Gio.Menu();
  main.append_item(chat.archived ? item('Désarchiver la discussion', 'unarchive') : item('Archiver la discussion', 'archive'));
  if (isMuted(chat, now)) {
    main.append_item(item('Réactiver les notifications', 'unmute'));
  } else {
    const mute = new Gio.Menu();
    for (const c of MUTE_CHOICES) mute.append_item(item(c.label, c.action));
    main.append_submenu('Mode silencieux', mute);
  }
  if (chat.pinned > 0) main.append_item(item('Désépingler la discussion', 'unpin'));
  // limite de WhatsApp atteinte : entrée absente plutôt qu'une erreur
  else if (pinnedCount < MAX_PINNED) main.append_item(item('Épingler la discussion', 'pin'));
  main.append_item(chat.unread > 0 || chat.markedUnread ? item('Marquer comme lue', 'read') : item('Marquer comme non lue', 'unread'));
  const danger = new Gio.Menu();
  danger.append_item(item('Effacer la discussion…', 'clear'));
  danger.append_item(chat.group ? item('Quitter le groupe…', 'leave') : item('Supprimer la discussion…', 'delete'));
  const menu = new Gio.Menu();
  menu.append_section(null, main);
  menu.append_section(null, danger);
  return menu;
}

/** Confirmations des actions destructrices. */
const CONFIRM: Readonly<Partial<Record<ChatAction['action'], { heading: string; body: string; label: string }>>> = {
  clear: { heading: 'Effacer la discussion ?', body: 'Les messages de « %s » seront effacés sur tous vos appareils. La discussion reste dans la liste.', label: 'Effacer' },
  delete: { heading: 'Supprimer la discussion ?', body: 'La discussion avec « %s » et ses messages seront supprimés sur tous vos appareils.', label: 'Supprimer' },
  leave: { heading: 'Quitter le groupe ?', body: 'Vous ne recevrez plus les messages de « %s ».', label: 'Quitter' },
};

/**
 * Actions `chat.*` (paramètre : identifiant de la discussion) installées sur `widget`, et menu
 * contextuel ouvert par clic droit ou appui long sur une ligne de `list`.
 */
export function attachChatMenu(list: Gtk.ListBox, store: Store, toast: (text: string) => void): void {
  const run = (id: string, action: ChatAction): void => {
    store.chatAction(id, action).catch((error: unknown) => toast(errorMessage(error)));
  };
  const confirm = (id: string, action: ChatAction): void => {
    const text = CONFIRM[action.action];
    if (text === undefined) {
      run(id, action);
      return;
    }
    const dialog = new Adw.AlertDialog({ heading: text.heading, body: text.body.replace('%s', store.chat(id)?.name ?? '') });
    dialog.add_response('cancel', 'Annuler');
    dialog.add_response('ok', text.label);
    dialog.set_response_appearance('ok', Adw.ResponseAppearance.DESTRUCTIVE);
    dialog.connect('response', (_d: Adw.AlertDialog, response: string) => {
      if (response === 'ok') run(id, action);
    });
    dialog.present(list);
  };
  const actions: Record<string, (id: string) => void> = {
    archive: (id) => run(id, { action: 'archive', value: true }),
    unarchive: (id) => run(id, { action: 'archive', value: false }),
    unmute: (id) => run(id, { action: 'mute', until: null }),
    pin: (id) => run(id, { action: 'pin', value: true }),
    unpin: (id) => run(id, { action: 'pin', value: false }),
    unread: (id) => run(id, { action: 'unread', value: true }),
    read: (id) => run(id, { action: 'unread', value: false }),
    clear: (id) => confirm(id, { action: 'clear' }),
    delete: (id) => confirm(id, { action: 'delete' }),
    leave: (id) => confirm(id, { action: 'leave' }),
  };
  for (const c of MUTE_CHOICES) actions[c.action] = (id) => run(id, { action: 'mute', until: c.until(Date.now()) });
  const group = new Gio.SimpleActionGroup();
  for (const [name, fn] of Object.entries(actions)) {
    const a = new Gio.SimpleAction({ name, parameterType: new GLib.VariantType('s') });
    a.connect('activate', (_a: Gio.SimpleAction, param: GLib.Variant | null) => {
      const id = param?.get_string()[0];
      if (id !== undefined && id !== '') fn(id);
    });
    group.add_action(a);
  }
  list.insert_action_group('chat', group);

  const popup = (x: number, y: number): boolean => {
    const row = list.get_row_at_y(y);
    const chat = row === null ? undefined : store.chat(row.name);
    if (row === null || chat === undefined) return false;
    const pinned = store.chats.peek().filter((c) => c.pinned > 0).length;
    // sous-menus déroulés à côté (comme WhatsApp Web), pas en glissement
    const menu = Gtk.PopoverMenu.new_from_model_full(chatMenu(chat, pinned), Gtk.PopoverMenuFlags.NESTED);
    menu.hasArrow = false;
    menu.halign = Gtk.Align.START;
    menu.set_parent(row);
    const [, point] = list.compute_point(row, new Graphene.Point({ x, y }));
    menu.set_pointing_to(new Gdk.Rectangle({ x: Math.round(point.x), y: Math.round(point.y), width: 1, height: 1 }));
    // détaché après sa fermeture (l'action choisie est déjà lancée)
    menu.connect('closed', () => {
      GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        menu.unparent();
        return GLib.SOURCE_REMOVE;
      });
    });
    menu.popup();
    return true;
  };
  const click = new Gtk.GestureClick({ button: Gdk.BUTTON_SECONDARY });
  click.connect('pressed', (g: Gtk.GestureClick, _n: number, x: number, y: number) => {
    if (popup(x, y)) g.set_state(Gtk.EventSequenceState.CLAIMED);
  });
  list.add_controller(click);
  const press = new Gtk.GestureLongPress({ touchOnly: true });
  press.connect('pressed', (g: Gtk.GestureLongPress, x: number, y: number) => {
    if (popup(x, y)) g.set_state(Gtk.EventSequenceState.CLAIMED);
  });
  list.add_controller(press);
}

// Menu contextuel d'une discussion (clic droit, appui long), comme dans WhatsApp Web :
// archiver, mode silencieux, épingler, non lue, effacer, supprimer, quitter le groupe.
import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gdk from 'gi://Gdk?version=4.0';
import Gtk from 'gi://Gtk?version=4.0';
import { type Chat, type ChatAction, type ChatList, isMuted, MAX_PINNED } from '../shared/api.ts';
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
export function chatMenu(chat: Chat, pinnedCount: number, lists: readonly ChatList[] = [], now = Date.now()): Gio.Menu {
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
  main.append_item(chat.favorite ? item('Retirer des favoris', 'unfavorite') : item('Ajouter aux favoris', 'favorite'));
  const custom = lists.filter((l) => l.kind === 'custom');
  if (custom.length > 0) {
    const sub = new Gio.Menu();
    for (const l of custom) {
      // cible « discussion|liste » ; coche devant les listes de la discussion
      const it = Gio.MenuItem.new(`${chat.labels.includes(l.id) ? '✓ ' : ''}${l.name}`, null);
      it.set_action_and_target_value('chat.toggle-label', new GLib.Variant('s', `${chat.id}|${l.id}`));
      sub.append_item(it);
    }
    main.append_submenu('Ajouter à la liste', sub);
  }
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

/** Menu contextuel d'une ligne : `row` sa ligne, `chatId` sa discussion (null : rien). */
export type ChatMenuAt = (row: Gtk.Widget, chatId: string | null, x: number, y: number) => boolean;

/**
 * Actions `chat.*` (paramètre : identifiant de la discussion) installées sur `list` ; renvoie
 * l'ouverture du menu contextuel d'une ligne (voir `attachRowMenu`).
 */
export function chatMenuActions(list: Gtk.Widget, store: Store, toast: (text: string) => void): ChatMenuAt {
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
    favorite: (id) => run(id, { action: 'favorite', value: true }),
    unfavorite: (id) => run(id, { action: 'favorite', value: false }),
    'toggle-label': (target) => {
      const [id = '', labelId = ''] = target.split('|');
      run(id, { action: 'label', labelId, value: store.chat(id)?.labels.includes(labelId) !== true });
    },
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

  return (row, chatId, x, y) => {
    const chat = chatId === null ? undefined : store.chat(chatId);
    if (chat === undefined) return false;
    const pinned = store.chats.peek().filter((c) => c.pinned > 0).length;
    // sous-menus déroulés à côté (comme WhatsApp Web), pas en glissement
    const menu = Gtk.PopoverMenu.new_from_model_full(chatMenu(chat, pinned, store.lists.peek()), Gtk.PopoverMenuFlags.NESTED);
    menu.hasArrow = false;
    menu.halign = Gtk.Align.START;
    menu.set_parent(row);
    menu.set_pointing_to(new Gdk.Rectangle({ x: Math.round(x), y: Math.round(y), width: 1, height: 1 }));
    // détaché après sa fermeture (l'action choisie est déjà lancée)
    // ligne recyclée ou détruite pendant que le menu est ouvert
    const gone = row.connect('unrealize', () => {
      if (menu.get_parent() !== null) menu.unparent();
    });
    menu.connect('closed', () => {
      row.disconnect(gone);
      GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        if (menu.get_parent() !== null) menu.unparent();
        return GLib.SOURCE_REMOVE;
      });
    });
    menu.popup();
    return true;
  };
}

/** Clic droit ou appui long sur `row` : menu de la discussion `chatId()`. */
export function attachRowMenu(row: Gtk.Widget, open: ChatMenuAt, chatId: () => string | null): void {
  const click = new Gtk.GestureClick({ button: Gdk.BUTTON_SECONDARY });
  click.connect('pressed', (g: Gtk.GestureClick, _n: number, x: number, y: number) => {
    if (open(row, chatId(), x, y)) g.set_state(Gtk.EventSequenceState.CLAIMED);
  });
  row.add_controller(click);
  const press = new Gtk.GestureLongPress({ touchOnly: true });
  press.connect('pressed', (g: Gtk.GestureLongPress, x: number, y: number) => {
    if (open(row, chatId(), x, y)) g.set_state(Gtk.EventSequenceState.CLAIMED);
  });
  row.add_controller(press);
}

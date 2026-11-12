// Point d'entrée de l'application GTK : WhatsApp pour GNOME.
import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import { createRoot } from 'gnim';
import { DEFAULT_ACCOUNT, isMissedCall, isMuted, mentionsMe, previewOf } from '../shared/api.ts';
import { WaClient } from '../shared/client.ts';
import { errorMessage } from '../shared/errors.ts';
import type { Store } from '../shared/store.ts';
import { Accounts, accountName, unreadChats } from './Accounts.ts';
import { Badge } from './Badge.ts';
import { openDiagnostics } from './Diagnostics.ts';
import { MainWindow, type WindowApi } from './MainWindow.tsx';
import { openNewChat } from './NewChat.ts';
import { initSettings, loadSettings, openPreferences, rememberAccount, settings } from './Preferences.ts';
import { openShortcuts } from './Shortcuts.ts';
import { STYLESHEET } from './style.ts';

/** Identifiant D-Bus (surchargeable pour lancer une version de développement à côté). */
export const APP_ID = GLib.getenv('WA_GNOME_APP_ID') ?? 'io.github.maarekj.WaGnome';

const app = new Adw.Application({ applicationId: APP_ID, flags: Gio.ApplicationFlags.DEFAULT_FLAGS });
Gtk.Window.set_default_icon_name(APP_ID);
const accounts = new Accounts(new WaClient(), loadSettings().account);
/** compte affiché */
const active = (): Store => accounts.active.peek();
let mainWindow: Gtk.Window | null = null;
let api: WindowApi | null = null;

// ------------------------------------------------------------------ notifications

/** Cible des actions de notification : discussion, préfixée du compte s'il n'est pas le premier. */
const target = (store: Store, chatId: string): string => (store.client.account === DEFAULT_ACCOUNT ? chatId : `${store.client.account}/${chatId}`);
/** Compte et discussion d'une cible (un JID ne contient pas de « / »). */
function parseTarget(param: GLib.Variant | null): { store: Store; chatId: string } | null {
  const raw = param?.get_string()[0] ?? '';
  const slash = raw.indexOf('/');
  const store = slash === -1 ? accounts.main : accounts.byId(raw.slice(0, slash));
  const chatId = slash === -1 ? raw : raw.slice(slash + 1);
  return store === undefined || chatId === '' ? null : { store, chatId };
}
const notificationId = (store: Store, chatId: string): string => `chat-${target(store, chatId)}`;

/** Compteur de non-lus hors de la fenêtre (barre du haut, docks) : clic, fenêtre au premier plan. */
const badge = new Badge(APP_ID, () => {
  if (mainWindow === null) app.activate();
  else mainWindow.present();
});
/** `removed` : compte en cours de retrait, encore dans la liste */
const updateBadge = (removed?: Store): void => {
  badge.set(accounts.list.peek().filter((s) => s !== removed).reduce((n, s) => n + unreadChats(s.chats.peek()), 0));
};

/** Compte retiré : notifications et abonnements libérés. */
const unwatch = new Map<Store, () => void>();

/** Notifications d'un compte suivi. */
function watch(store: Store): void {
  /** discussions ayant une notification affichée */
  const shown = new Set<string>();
  store.onIncoming = (m, chat) => {
    // ligne d'appel : notification seulement pour un appel manqué (la sonnerie a déjà la sienne)
    if (m.kind === 'call' && !isMissedCall(m)) return;
    // discussion affichée dans une fenêtre active : déjà vue
    if (mainWindow?.isActive === true && active() === store && store.current.peek() === m.chatId) {
      store.markRead(m.chatId);
      return;
    }
    // mode silencieux ou notifications coupées dans les préférences : rien
    // silencieuse : notifiée quand même si l'on me mentionne (préférences)
    const mentioned = mentionsMe(m) && settings().notifyMentions;
    if ((chat !== undefined && isMuted(chat) && !mentioned) || !settings().notify) return;
    const n = new Gio.Notification();
    const name = chat?.name ?? m.senderName ?? m.chatId.split('@')[0] ?? '';
    // plusieurs comptes : celui qui a reçu le message
    const several = accounts.list.peek().length > 1;
    // contenu masqué (préférences) : ni auteur ni texte
    if (settings().preview) {
      const title = chat?.group === true && m.senderName !== null ? `${m.senderName} · ${name}` : name;
      n.set_title(several ? `${title} (${accountName(store)})` : title);
      n.set_body(`${mentioned ? 'Vous a mentionné : ' : ''}${previewOf(m)}`);
    } else {
      n.set_title(several ? `WhatsApp (${accountName(store)})` : 'WhatsApp');
      n.set_body('Nouveau message');
    }
    const t = new GLib.Variant('s', target(store, m.chatId));
    n.set_default_action_and_target('app.open-chat', t);
    // Répondre : discussion ouverte, saisie active ; Marquer comme lu : sans ouvrir l'app
    n.add_button_with_target('Répondre', 'app.reply-chat', t);
    n.add_button_with_target('Marquer comme lu', 'app.read-chat', t);
    app.send_notification(notificationId(store, m.chatId), n);
    shown.add(m.chatId);
  };
  // appel qui sonne : notification (décrocher se fait sur le téléphone) ; retirée à la fin
  store.onCall = (call, chat) => {
    const id = `call-${target(store, call.id)}`;
    if (call.state === 'ended') {
      app.withdraw_notification(id);
      api?.calls.end(id);
      return;
    }
    const name = chat?.name ?? call.chatId.split('@')[0] ?? '';
    const several = accounts.list.peek().length > 1;
    // fenêtre ouverte : appel en surimpression (même si les notifications sont coupées)
    if (api !== null) {
      const avatar = new Adw.Avatar({ size: 48, text: name, showInitials: true });
      // photo connue tout de suite (hors portée gnim : pas d'abonnement à libérer)
      avatar.set_custom_image(accounts.pictures(store).texture(call.chatId).peek());
      const t = new GLib.Variant('s', target(store, call.id));
      api.calls.ring({
        key: id,
        call,
        name,
        account: several ? accountName(store) : null,
        picture: avatar,
        open: () => {
          bring(store, call.chatId);
          store.open(call.chatId);
        },
        reject: (withMessage) => rejectCall(t, withMessage),
      });
    }
    // fenêtre active : la surimpression suffit
    if (!settings().notify || mainWindow?.isActive === true) return;
    const n = new Gio.Notification();
    n.set_title(`${name} vous appelle${several ? ` (${accountName(store)})` : ''}`);
    n.set_body(`${call.video ? 'Appel vidéo' : 'Appel vocal'} WhatsApp${call.group ? ' de groupe' : ''} · décrochez sur votre téléphone`);
    n.set_priority(Gio.NotificationPriority.URGENT);
    n.set_default_action_and_target('app.open-chat', new GLib.Variant('s', target(store, call.chatId)));
    const t = new GLib.Variant('s', target(store, call.id));
    n.add_button_with_target('Refuser', 'app.reject-call', t);
    n.add_button_with_target('Refuser avec un message', 'app.reject-call-message', t);
    app.send_notification(id, n);
  };
  // discussion lue ailleurs (téléphone, autre fenêtre) : notification retirée
  const off = store.chats.subscribe(() => {
    updateBadge();
    if (shown.size === 0) return;
    for (const c of store.chats.peek()) {
      if (!shown.has(c.id) || c.unread > 0 || c.markedUnread) continue;
      app.withdraw_notification(notificationId(store, c.id));
      shown.delete(c.id);
    }
  });
  unwatch.set(store, () => {
    off();
    store.onIncoming = null;
    store.onCall = null;
    for (const id of shown) app.withdraw_notification(notificationId(store, id));
  });
}
watch(accounts.main);
accounts.onAdded = watch;
accounts.onRemoved = (store) => {
  unwatch.get(store)?.();
  unwatch.delete(store);
  updateBadge(store);
};
accounts.onSwitch = (store) => {
  rememberAccount(store.client.account);
  // présence : le compte quitté n'est plus « en ligne »
  for (const s of accounts.list.peek()) if (s !== store && s.status.peek().state === 'open') void s.client.setOnline(false).catch((error: unknown) => console.error(`présence : ${errorMessage(error)}`));
  if (mainWindow?.isActive === true && store.status.peek().state === 'open') void store.client.setOnline(true).catch((error: unknown) => console.error(`présence : ${errorMessage(error)}`));
};

/** Fenêtre au premier plan sur le compte d'une discussion. */
function bring(store: Store, chatId: string): void {
  if (mainWindow === null) app.activate();
  else mainWindow.present();
  accounts.select(store);
  app.withdraw_notification(notificationId(store, chatId));
}

// ------------------------------------------------------------------ actions

/** app.open-chat(jid) : clic sur une notification */
const openChat = new Gio.SimpleAction({ name: 'open-chat', parameterType: new GLib.VariantType('s') });
openChat.connect('activate', (_a: Gio.SimpleAction, param: GLib.Variant | null) => {
  const t = parseTarget(param);
  if (t === null) return;
  bring(t.store, t.chatId);
  t.store.open(t.chatId);
});
app.add_action(openChat);

/** app.reply-chat(jid) : bouton « Répondre » d'une notification */
const replyChat = new Gio.SimpleAction({ name: 'reply-chat', parameterType: new GLib.VariantType('s') });
replyChat.connect('activate', (_a: Gio.SimpleAction, param: GLib.Variant | null) => {
  const t = parseTarget(param);
  if (t === null) return;
  bring(t.store, t.chatId);
  t.store.reply(t.chatId);
});
app.add_action(replyChat);

/** app.read-chat(jid) : bouton « Marquer comme lu » d'une notification (sans ouvrir la fenêtre) */
const readChat = new Gio.SimpleAction({ name: 'read-chat', parameterType: new GLib.VariantType('s') });
readChat.connect('activate', (_a: Gio.SimpleAction, param: GLib.Variant | null) => {
  const t = parseTarget(param);
  if (t === null) return;
  app.withdraw_notification(notificationId(t.store, t.chatId));
  t.store.markRead(t.chatId);
});
app.add_action(readChat);

/** app.reject-call / app.reject-call-message : boutons d'une notification d'appel. Refuse l'appel d'une notification (cible : compte/identifiant de l'appel). */
function rejectCall(param: GLib.Variant | null, withMessage: boolean): void {
  const t = parseTarget(param);
  if (t === null) return;
  app.withdraw_notification(`call-${target(t.store, t.chatId)}`);
  api?.calls.end(`call-${target(t.store, t.chatId)}`);
  t.store.client.rejectCall(t.chatId, withMessage ? settings().rejectMessage : undefined).catch((error: unknown) => {
    console.error(`refus de l'appel : ${errorMessage(error)}`);
    api?.toast(`Refus impossible : ${errorMessage(error)}`);
  });
}
for (const [name, withMessage] of [['reject-call', false], ['reject-call-message', true]] as const) {
  const action = new Gio.SimpleAction({ name, parameterType: new GLib.VariantType('s') });
  action.connect('activate', (_a: Gio.SimpleAction, param: GLib.Variant | null) => {
    rejectCall(param, withMessage);
  });
  app.add_action(action);
}

/** app.logout : déconnexion du compte (le poste disparaît des appareils connectés) */
const logout = new Gio.SimpleAction({ name: 'logout' });
logout.connect('activate', () => {
  if (mainWindow === null) return;
  const dialog = new Adw.AlertDialog({
    heading: 'Déconnecter ce poste ?',
    body: 'Les discussions enregistrées sur cet ordinateur seront effacées. Il faudra scanner un nouveau QR code pour vous reconnecter.',
  });
  dialog.add_response('cancel', 'Annuler');
  dialog.add_response('logout', 'Déconnecter');
  dialog.set_response_appearance('logout', Adw.ResponseAppearance.DESTRUCTIVE);
  dialog.connect('response', (_d: Adw.AlertDialog, response: string) => {
    if (response !== 'logout') return;
    active().client.logout().catch((error: unknown) => api?.toast(`Déconnexion impossible : ${errorMessage(error)}`));
  });
  dialog.present(mainWindow);
});
app.add_action(logout);

/** app.remove-account : retire le compte affiché (pas le premier) */
const removeAccount = new Gio.SimpleAction({ name: 'remove-account' });
removeAccount.connect('activate', () => {
  const store = active();
  if (mainWindow === null || store === accounts.main) return;
  const dialog = new Adw.AlertDialog({
    heading: `Retirer le compte ${accountName(store)} ?`,
    body: 'Ce poste sera déconnecté de ce compte et ses discussions enregistrées sur cet ordinateur seront effacées.',
  });
  dialog.add_response('cancel', 'Annuler');
  dialog.add_response('remove', 'Retirer');
  dialog.set_response_appearance('remove', Adw.ResponseAppearance.DESTRUCTIVE);
  dialog.connect('response', (_d: Adw.AlertDialog, response: string) => {
    if (response !== 'remove') return;
    accounts.remove(store).catch((error: unknown) => api?.toast(`Retrait impossible : ${errorMessage(error)}`));
  });
  dialog.present(mainWindow);
});
app.add_action(removeAccount);

/** Version de l'application (fenêtre « À propos », diagnostic). */
const VERSION = '0.1.0';

/** app.diagnostics : versions, état des comptes, journal du démon */
const diagnostics = new Gio.SimpleAction({ name: 'diagnostics' });
diagnostics.connect('activate', () => {
  if (mainWindow !== null) openDiagnostics(mainWindow, accounts.main.client, VERSION, (t) => api?.toast(t));
});
app.add_action(diagnostics);

const about = new Gio.SimpleAction({ name: 'about' });
about.connect('activate', () => {
  const dialog = new Adw.AboutDialog({
    applicationName: 'WhatsApp pour GNOME',
    applicationIcon: APP_ID,
    version: VERSION,
    developerName: 'maarekj',
    licenseType: Gtk.License.UNKNOWN,
    comments: 'Client WhatsApp non officiel (protocole multi-appareils, via Baileys).',
  });
  dialog.present(mainWindow);
});
app.add_action(about);

/** app.new-chat : nouvelle discussion (Ctrl+N) */
const newChat = new Gio.SimpleAction({ name: 'new-chat' });
newChat.connect('activate', () => {
  if (mainWindow !== null && api !== null) openNewChat(mainWindow, active(), api.pictures, (t) => api?.toast(t));
});
app.add_action(newChat);
app.set_accels_for_action('app.new-chat', ['<Control>n']);

/** app.preferences : fenêtre des préférences (Ctrl+,) */
const preferences = new Gio.SimpleAction({ name: 'preferences' });
preferences.connect('activate', () => {
  if (mainWindow !== null) openPreferences(mainWindow);
});
app.add_action(preferences);
app.set_accels_for_action('app.preferences', ['<Control>comma']);

/** app.shortcuts : fenêtre des raccourcis (Ctrl+?) */
const shortcuts = new Gio.SimpleAction({ name: 'shortcuts' });
shortcuts.connect('activate', () => {
  if (mainWindow !== null) openShortcuts(mainWindow);
});
app.add_action(shortcuts);
app.set_accels_for_action('app.shortcuts', ['<Control>question', '<Control><Shift>question']);

const quit = new Gio.SimpleAction({ name: 'quit' });
quit.connect('activate', () => app.quit());
app.add_action(quit);
app.set_accels_for_action('app.quit', ['<Control>q']);
app.set_accels_for_action('window.close', ['<Control>w']);

// ------------------------------------------------------------------ fenêtre

app.connect('startup', () => {
  const css = new Gtk.CssProvider();
  css.load_from_string(STYLESHEET);
  const display = Gdk.Display.get_default();
  // oxlint-disable-next-line typescript/no-deprecated -- seule API exposée par GJS pour un style global
  if (display !== null) Gtk.StyleContext.add_provider_for_display(display, css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
  // couleur d'accent choisie (sinon celle du système)
  initSettings();
  badge.start();
});

app.connect('activate', () => {
  GLib.unsetenv('XDG_ACTIVATION_TOKEN');
  GLib.unsetenv('DESKTOP_STARTUP_ID');
  if (mainWindow !== null) {
    mainWindow.present();
    return;
  }
  accounts.start();
  createRoot((dispose) => {
    const win = MainWindow({
      app,
      accounts,
      ready: (a) => {
        api = a;
      },
    });
    if (!(win instanceof Gtk.Window)) throw new TypeError('fenêtre attendue');
    mainWindow = win;
    // présence : en ligne seulement quand la fenêtre a le focus (comme WhatsApp Web)
    let onlineTimer = 0;
    win.connect('notify::is-active', () => {
      if (onlineTimer !== 0) GLib.source_remove(onlineTimer);
      // regroupé : un passage bref dans une autre fenêtre ne bascule pas la présence
      onlineTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
        onlineTimer = 0;
        const store = active();
        if (store.status.peek().state === 'open') void store.client.setOnline(win.isActive).catch((error: unknown) => console.error(`présence : ${errorMessage(error)}`));
        return GLib.SOURCE_REMOVE;
      });
    });
    // connexion (ré)ouverte alors que la fenêtre a déjà le focus : en ligne
    // (compte affiché seulement : les autres restent hors ligne)
    const wasOpen = new WeakMap<Store, boolean>();
    const follow = (store: Store): (() => void) => {
      wasOpen.set(store, store.status.peek().state === 'open');
      return store.status.subscribe(() => {
        const open = store.status.peek().state === 'open';
        if (open && wasOpen.get(store) !== true && win.isActive && active() === store) void store.client.setOnline(true).catch((error: unknown) => console.error(`présence : ${errorMessage(error)}`));
        wasOpen.set(store, open);
      });
    };
    let statusSubs = accounts.list.peek().map((st) => follow(st));
    const listSub = accounts.list.subscribe(() => {
      for (const off of statusSubs) off();
      statusSubs = accounts.list.peek().map((st) => follow(st));
    });
    win.connect('destroy', () => {
      listSub();
      for (const off of statusSubs) off();
    });
    // discussion affichée redevenue visible : lue
    win.connect('notify::is-active', () => {
      const store = active();
      const id = store.current.peek();
      if (win.isActive && id !== null) {
        store.markRead(id);
        app.withdraw_notification(notificationId(store, id));
      }
    });
    win.connect('close-request', () => {
      void active().client.setOnline(false).catch((error: unknown) => console.error(`présence : ${errorMessage(error)}`));
      api = null;
      mainWindow = null;
      for (const s of accounts.list.peek()) s.open(null);
      dispose();
      return false;
    });
    win.present();
  });
});

app.connect('shutdown', () => {
  badge.stop();
  accounts.stop();
});

app.runAsync([imports.system.programInvocationName, ...ARGV]).catch((error: unknown) => {
  console.error(error);
});

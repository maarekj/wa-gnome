// Point d'entrée de l'application GTK : WhatsApp pour GNOME.
import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import { createRoot } from 'gnim';
import { isMuted, previewOf } from '../shared/api.ts';
import { WaClient } from '../shared/client.ts';
import { errorMessage } from '../shared/errors.ts';
import { Store } from '../shared/store.ts';
import { MainWindow, type WindowApi } from './MainWindow.tsx';
import { openNewChat } from './NewChat.ts';
import { initSettings, openPreferences } from './Preferences.ts';
import { STYLESHEET } from './style.ts';

/** Identifiant D-Bus (surchargeable pour lancer une version de développement à côté). */
export const APP_ID = GLib.getenv('WA_GNOME_APP_ID') ?? 'io.github.maarekj.WaGnome';

const app = new Adw.Application({ applicationId: APP_ID, flags: Gio.ApplicationFlags.DEFAULT_FLAGS });
Gtk.Window.set_default_icon_name(APP_ID);
const store = new Store(new WaClient());
let mainWindow: Gtk.Window | null = null;
let api: WindowApi | null = null;

// ------------------------------------------------------------------ notifications

store.onIncoming = (m, chat) => {
  // discussion affichée dans une fenêtre active : déjà vue
  if (mainWindow?.isActive === true && store.current.peek() === m.chatId) {
    store.markRead(m.chatId);
    return;
  }
  // mode silencieux : ni notification ni son
  if (chat !== undefined && isMuted(chat)) return;
  const n = new Gio.Notification();
  const name = chat?.name ?? m.senderName ?? m.chatId.split('@')[0] ?? '';
  n.set_title(chat?.group === true && m.senderName !== null ? `${m.senderName} · ${name}` : name);
  n.set_body(previewOf(m));
  n.set_default_action_and_target('app.open-chat', new GLib.Variant('s', m.chatId));
  // Répondre : discussion ouverte, saisie active ; Marquer comme lu : sans ouvrir l'app
  n.add_button_with_target('Répondre', 'app.reply-chat', new GLib.Variant('s', m.chatId));
  n.add_button_with_target('Marquer comme lu', 'app.read-chat', new GLib.Variant('s', m.chatId));
  app.send_notification(`chat-${m.chatId}`, n);
  notified.add(m.chatId);
};

/** discussions ayant une notification affichée */
const notified = new Set<string>();
// discussion lue ailleurs (téléphone, autre fenêtre) : notification retirée
store.chats.subscribe(() => {
  if (notified.size === 0) return;
  for (const c of store.chats.peek()) {
    if (!notified.has(c.id) || c.unread > 0 || c.markedUnread) continue;
    app.withdraw_notification(`chat-${c.id}`);
    notified.delete(c.id);
  }
});

// ------------------------------------------------------------------ actions

/** app.open-chat(jid) : clic sur une notification */
const openChat = new Gio.SimpleAction({ name: 'open-chat', parameterType: new GLib.VariantType('s') });
openChat.connect('activate', (_a: Gio.SimpleAction, param: GLib.Variant | null) => {
  const id = param?.get_string()[0];
  if (id === undefined || id === '') return;
  if (mainWindow === null) app.activate();
  else mainWindow.present();
  app.withdraw_notification(`chat-${id}`);
  store.open(id);
});
app.add_action(openChat);

/** app.reply-chat(jid) : bouton « Répondre » d'une notification */
const replyChat = new Gio.SimpleAction({ name: 'reply-chat', parameterType: new GLib.VariantType('s') });
replyChat.connect('activate', (_a: Gio.SimpleAction, param: GLib.Variant | null) => {
  const id = param?.get_string()[0];
  if (id === undefined || id === '') return;
  if (mainWindow === null) app.activate();
  else mainWindow.present();
  app.withdraw_notification(`chat-${id}`);
  store.reply(id);
});
app.add_action(replyChat);

/** app.read-chat(jid) : bouton « Marquer comme lu » d'une notification (sans ouvrir la fenêtre) */
const readChat = new Gio.SimpleAction({ name: 'read-chat', parameterType: new GLib.VariantType('s') });
readChat.connect('activate', (_a: Gio.SimpleAction, param: GLib.Variant | null) => {
  const id = param?.get_string()[0];
  if (id === undefined || id === '') return;
  app.withdraw_notification(`chat-${id}`);
  store.markRead(id);
});
app.add_action(readChat);

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
    store.client.logout().catch((error: unknown) => api?.toast(`Déconnexion impossible : ${errorMessage(error)}`));
  });
  dialog.present(mainWindow);
});
app.add_action(logout);

const about = new Gio.SimpleAction({ name: 'about' });
about.connect('activate', () => {
  const dialog = new Adw.AboutDialog({
    applicationName: 'WhatsApp pour GNOME',
    applicationIcon: APP_ID,
    version: '0.1.0',
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
  if (mainWindow !== null && api !== null) openNewChat(mainWindow, store, api.pictures, (t) => api?.toast(t));
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
});

app.connect('activate', () => {
  GLib.unsetenv('XDG_ACTIVATION_TOKEN');
  GLib.unsetenv('DESKTOP_STARTUP_ID');
  if (mainWindow !== null) {
    mainWindow.present();
    return;
  }
  store.start();
  createRoot((dispose) => {
    const win = MainWindow({
      app,
      store,
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
        if (store.status.peek().state === 'open') void store.client.setOnline(win.isActive).catch((error: unknown) => console.error(`présence : ${errorMessage(error)}`));
        return GLib.SOURCE_REMOVE;
      });
    });
    // connexion (ré)ouverte alors que la fenêtre a déjà le focus : en ligne
    let wasOpen = store.status.peek().state === 'open';
    const statusSub = store.status.subscribe(() => {
      const open = store.status.peek().state === 'open';
      if (open && !wasOpen && win.isActive) void store.client.setOnline(true).catch((error: unknown) => console.error(`présence : ${errorMessage(error)}`));
      wasOpen = open;
    });
    win.connect('destroy', statusSub);
    // discussion affichée redevenue visible : lue
    win.connect('notify::is-active', () => {
      const id = store.current.peek();
      if (win.isActive && id !== null) {
        store.markRead(id);
        app.withdraw_notification(`chat-${id}`);
      }
    });
    win.connect('close-request', () => {
      void store.client.setOnline(false).catch((error: unknown) => console.error(`présence : ${errorMessage(error)}`));
      api = null;
      mainWindow = null;
      store.open(null);
      dispose();
      return false;
    });
    win.present();
  });
});

app.connect('shutdown', () => store.stop());

app.runAsync([imports.system.programInvocationName, ...ARGV]).catch((error: unknown) => {
  console.error(error);
});

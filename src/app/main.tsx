// Point d'entrée de l'application GTK : WhatsApp pour GNOME.
import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import { createRoot } from 'gnim';
import { previewOf } from '../shared/api.ts';
import { WaClient } from '../shared/client.ts';
import { errorMessage } from '../shared/errors.ts';
import { Store } from '../shared/store.ts';
import { MainWindow, type WindowApi } from './MainWindow.tsx';
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
  const n = new Gio.Notification();
  const name = chat?.name ?? m.senderName ?? m.chatId.split('@')[0] ?? '';
  n.set_title(chat?.group === true && m.senderName !== null ? `${m.senderName} · ${name}` : name);
  n.set_body(previewOf(m));
  n.set_default_action_and_target('app.open-chat', new GLib.Variant('s', m.chatId));
  app.send_notification(`chat-${m.chatId}`, n);
};

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
    // discussion affichée redevenue visible : lue
    win.connect('notify::is-active', () => {
      const id = store.current.peek();
      if (win.isActive && id !== null) {
        store.markRead(id);
        app.withdraw_notification(`chat-${id}`);
      }
    });
    win.connect('close-request', () => {
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

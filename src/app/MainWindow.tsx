// Fenêtre principale : selon l'état, démon injoignable, appairage (QR code) ou discussions.
import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';
import { createMemo, createRoot, onCleanup } from 'gnim';
import type { Status } from '../shared/api.ts';
import type { Link } from '../shared/client.ts';
import { errorMessage } from '../shared/errors.ts';
import type { Store } from '../shared/store.ts';
import { ChatList } from './ChatList.tsx';
import { ConversationPage } from './ConversationPage.tsx';
import type { Accounts } from './Accounts.ts';
import { accountSwitcher } from './AccountSwitcher.ts';
import { CallBanner } from './CallBanner.ts';
import type { Pictures } from './pictures.ts';
import { qrCode } from './QrCode.ts';

/** Unité systemd du démon (scripts/install.ts). */
export const DAEMON_UNIT = 'wa-gnome-daemon.service';

/** Page affichée selon la liaison au démon et l'état de WhatsApp. */
export function screenOf(link: Link, status: Status): 'daemon' | 'loading' | 'pair' | 'main' {
  if (link.state !== 'connected') return 'daemon';
  if (status.me !== null || status.state === 'open') return 'main';
  if (status.state === 'qr') return 'pair';
  return 'loading';
}

const STATE_BANNER: Record<Status['state'], string> = {
  starting: 'Démarrage…',
  qr: 'Appairage nécessaire',
  connecting: 'Connexion à WhatsApp…',
  open: '',
  'logged-out': 'Déconnecté',
  closed: 'Connexion perdue, reconnexion…',
};

function asPage(o: JSX.Element): Adw.NavigationPage {
  if (!(o instanceof Adw.NavigationPage)) throw new TypeError('NavigationPage attendue');
  return o;
}

export interface WindowApi {
  toast: (text: string) => void;
  /** photos de profil du compte affiché (fenêtres ouvertes depuis l'application) */
  readonly pictures: Pictures;
  /** appels qui sonnent, en surimpression */
  readonly calls: CallBanner;
}

/** Bouton du sélecteur de compte, en tête d'une barre d'en-tête. */
function switcherIn(bar: Adw.HeaderBar, accounts: Accounts, toast: (t: string) => void): void {
  bar.pack_start(accountSwitcher(accounts, toast));
}

export function MainWindow({ app, accounts, ready }: { app: Adw.Application; accounts: Accounts; ready: (api: WindowApi) => void }): JSX.Element {
  let overlay: Adw.ToastOverlay | null = null;
  const toast = (text: string): void => overlay?.add_toast(new Adw.Toast({ title: text, timeout: 5 }));
  const calls = new CallBanner();
  ready({
    toast,
    calls,
    get pictures() {
      return accounts.pictures(accounts.active.peek());
    },
  });
  /** contenu du compte affiché, refait à chaque changement de compte */
  let disposeView: (() => void) | null = null;
  const show = (bin: Adw.Bin): void => {
    disposeView?.();
    createRoot((dispose) => {
      disposeView = dispose;
      const view = AccountView({ store: accounts.active.peek(), accounts, toast });
      if (!(view instanceof Gtk.Widget)) throw new TypeError('widget attendu');
      bin.child = view;
    });
  };

  return (
    <Adw.ApplicationWindow application={app} title="WhatsApp" defaultWidth={1000} defaultHeight={700} widthRequest={360} heightRequest={400}>
      <Adw.ToastOverlay
        $={(self: Adw.ToastOverlay) => {
          overlay = self;
        }}
      >
        <Gtk.Overlay
          $={(self: Gtk.Overlay) => {
            const bin = new Adw.Bin();
            self.child = bin;
            self.add_overlay(calls.widget);
            show(bin);
            onCleanup(accounts.active.subscribe(() => show(bin)));
            onCleanup(() => disposeView?.());
          }}
        />
      </Adw.ToastOverlay>
    </Adw.ApplicationWindow>
  );
}

/** Écrans d'un compte : démon injoignable, chargement, appairage ou discussions. */
function AccountView({ store, accounts, toast }: { store: Store; accounts: Accounts; toast: (t: string) => void }): JSX.Element {
  const screen = createMemo(() => screenOf(store.link(), store.status()));
  let split: Adw.NavigationSplitView | null = null;
  const pictures = accounts.pictures(store);
  /** compte ajouté (pas le premier) : appairage annulable */
  const extra = store !== accounts.main;
  return (
    <Adw.BreakpointBin
      widthRequest={360}
      heightRequest={400}
      $={(self: Adw.BreakpointBin) => {
        // fenêtre étroite : une seule colonne, la discussion ouverte au premier plan
        const bp = new Adw.Breakpoint({ condition: Adw.BreakpointCondition.parse('max-width: 640sp') });
        if (split !== null) bp.add_setter(split, 'collapsed', true);
        self.add_breakpoint(bp);
      }}
    >
        <Gtk.Stack visibleChildName={screen} transitionType={Gtk.StackTransitionType.CROSSFADE}>
          <Adw.ToolbarView $type="named" name="daemon">
            <Adw.HeaderBar $type="top" />
            <Adw.StatusPage
              iconName="network-offline-symbolic"
              title="Service WhatsApp injoignable"
              description={store.link((l) => `Le démon wa-gnome ne répond pas.\nDémarrez-le avec « systemctl --user start ${DAEMON_UNIT} ».${l.state === 'error' ? `\n\n${l.message}` : ''}`)}
            />
          </Adw.ToolbarView>
          <Adw.ToolbarView $type="named" name="loading">
            <Adw.HeaderBar $type="top" $={(self: Adw.HeaderBar) => switcherIn(self, accounts, toast)} />
            <Adw.StatusPage title={store.status((s) => STATE_BANNER[s.state])} description={store.status((s) => s.error ?? '')}>
              <Adw.Spinner widthRequest={32} heightRequest={32} />
            </Adw.StatusPage>
          </Adw.ToolbarView>
          <Adw.ToolbarView $type="named" name="pair">
            <Adw.HeaderBar $type="top" $={(self: Adw.HeaderBar) => switcherIn(self, accounts, toast)} />
            <Gtk.ScrolledWindow hscrollbarPolicy={Gtk.PolicyType.NEVER}>
              <Adw.Clamp maximumSize={480}>
                <Gtk.Box orientation={Gtk.Orientation.VERTICAL} spacing={18} valign={Gtk.Align.CENTER} marginTop={24} marginBottom={24} marginStart={12} marginEnd={12}>
                  <Gtk.Label label="Connecter WhatsApp" cssClasses={['title-1']} />
                  <Gtk.Box
                    halign={Gtk.Align.CENTER}
                    cssClasses={['card', 'qr-frame']}
                    $={(self: Gtk.Box) => {
                      self.append(qrCode(store.status((s) => s.qr ?? '')));
                    }}
                  />
                  <Gtk.Label
                    useMarkup
                    wrap
                    justify={Gtk.Justification.CENTER}
                    label={'1. Ouvrez WhatsApp sur votre téléphone\n2. Touchez <b>Appareils connectés</b> puis <b>Connecter un appareil</b>\n3. Scannez ce code'}
                  />
                  <Gtk.Button
                    label="Annuler l’ajout de ce compte"
                    visible={extra}
                    halign={Gtk.Align.CENTER}
                    cssClasses={['pill']}
                    onClicked={() => {
                      accounts.remove(store).catch((error: unknown) => toast(`Retrait impossible : ${errorMessage(error)}`));
                    }}
                  />
                </Gtk.Box>
              </Adw.Clamp>
            </Gtk.ScrolledWindow>
          </Adw.ToolbarView>
          <Gtk.Box $type="named" name="main" orientation={Gtk.Orientation.VERTICAL}>
            <Adw.Banner title={store.status((s) => STATE_BANNER[s.state])} revealed={store.status((s) => s.state !== 'open')} />
            <Adw.NavigationSplitView
              vexpand
              minSidebarWidth={280}
              maxSidebarWidth={400}
              $={(self: Adw.NavigationSplitView) => {
                split = self;
                self.sidebar = asPage(ChatList({ store, pictures, toast, switcher: accountSwitcher(accounts, toast), removable: extra }));
                self.content = asPage(ConversationPage({ store, pictures, toast }));
                onCleanup(
                  store.current.subscribe(() => {
                    self.showContent = store.current.peek() !== null;
                  }),
                );
                self.connect('notify::show-content', () => {
                  if (self.collapsed && !self.showContent) store.open(null);
                });
              }}
            />
          </Gtk.Box>
        </Gtk.Stack>
    </Adw.BreakpointBin>
  );
}

// Fenêtre principale : selon l'état, démon injoignable, appairage (QR code) ou discussions.
import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';
import { createMemo, onCleanup } from 'gnim';
import type { Status } from '../shared/api.ts';
import type { Link } from '../shared/client.ts';
import type { Store } from '../shared/store.ts';
import { ChatList } from './ChatList.tsx';
import { ConversationPage } from './ConversationPage.tsx';
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
}

export function MainWindow({ app, store, ready }: { app: Adw.Application; store: Store; ready: (api: WindowApi) => void }): JSX.Element {
  const screen = createMemo(() => screenOf(store.link(), store.status()));
  let overlay: Adw.ToastOverlay | null = null;
  let split: Adw.NavigationSplitView | null = null;
  const toast = (text: string): void => overlay?.add_toast(new Adw.Toast({ title: text, timeout: 5 }));
  ready({ toast });

  return (
    <Adw.ApplicationWindow
      application={app}
      title="WhatsApp"
      defaultWidth={1000}
      defaultHeight={700}
      widthRequest={360}
      heightRequest={400}
      $={(self: Adw.ApplicationWindow) => {
        // fenêtre étroite : une seule colonne, la discussion ouverte au premier plan
        const bp = new Adw.Breakpoint({ condition: Adw.BreakpointCondition.parse('max-width: 640sp') });
        if (split !== null) bp.add_setter(split, 'collapsed', true);
        self.add_breakpoint(bp);
      }}
    >
      <Adw.ToastOverlay
        $={(self: Adw.ToastOverlay) => {
          overlay = self;
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
            <Adw.HeaderBar $type="top" />
            <Adw.StatusPage title={store.status((s) => STATE_BANNER[s.state])} description={store.status((s) => s.error ?? '')}>
              <Adw.Spinner widthRequest={32} heightRequest={32} />
            </Adw.StatusPage>
          </Adw.ToolbarView>
          <Adw.ToolbarView $type="named" name="pair">
            <Adw.HeaderBar $type="top" />
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
                self.sidebar = asPage(ChatList({ store, toast }));
                self.content = asPage(ConversationPage({ store, toast }));
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
      </Adw.ToastOverlay>
    </Adw.ApplicationWindow>
  );
}

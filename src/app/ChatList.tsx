// Barre latérale : liste des discussions (la plus récente d'abord), recherche par nom.
import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';
import { createMemo, createState, onCleanup, type Accessor } from 'gnim';
import type { Chat } from '../shared/api.ts';
import { fmtShortDate } from '../shared/format.ts';
import type { Store } from '../shared/store.ts';
import { keyedListBox } from './KeyedBox.ts';
import { asWidget } from './widgets.ts';

/** Recherche insensible à la casse et aux accents. */
export const fold = (s: string): string => s.normalize('NFD').replaceAll(/\p{M}/gu, '').toLowerCase();

/** Texte de l'avatar : sans le « ~ » des noms publics (initiales du nom). */
export const avatarText = (name: string): string => name.replace(/^~ /u, '');

function ChatRow(chat: Chat, live: Accessor<Chat>): Gtk.Widget {
  return asWidget(
    <Gtk.ListBoxRow name={chat.id} cssClasses={['chat-row']} tooltipText={live((c) => c.name)}>
      <Gtk.Box spacing={12} marginTop={8} marginBottom={8} marginStart={8} marginEnd={8}>
        <Adw.Avatar size={44} text={live((c) => avatarText(c.name))} showInitials={live((c) => /\p{L}/u.test(c.name))} />
        <Gtk.Box orientation={Gtk.Orientation.VERTICAL} valign={Gtk.Align.CENTER} hexpand spacing={2}>
          <Gtk.Box spacing={6}>
            <Gtk.Label label={live((c) => c.name)} xalign={0} hexpand ellipsize={Pango.EllipsizeMode.END} cssClasses={['heading']} />
            <Gtk.Label label={live((c) => fmtShortDate(c.timestamp))} cssClasses={live((c) => (c.unread > 0 ? ['caption', 'accent'] : ['caption', 'dim-label']))} />
          </Gtk.Box>
          <Gtk.Box spacing={6}>
            <Gtk.Label label={live((c) => c.preview.replaceAll('\n', ' '))} xalign={0} hexpand ellipsize={Pango.EllipsizeMode.END} cssClasses={['dim-label']} />
            <Gtk.Label label={live((c) => String(c.unread))} visible={live((c) => c.unread > 0)} valign={Gtk.Align.CENTER} cssClasses={['unread-badge']} />
          </Gtk.Box>
        </Gtk.Box>
      </Gtk.Box>
    </Gtk.ListBoxRow>,
  );
}

export function ChatList({ store }: { store: Store }): JSX.Element {
  const [query, setQuery] = createState('');
  const shown = createMemo(() => {
    const q = fold(query().trim());
    const all = store.chats();
    return q === '' ? all : all.filter((c) => fold(c.name).includes(q));
  });
  return (
    <Adw.NavigationPage title="Discussions" tag="chats">
      <Adw.ToolbarView>
        <Adw.HeaderBar $type="top">
          <Gtk.MenuButton
            $type="end"
            iconName="open-menu-symbolic"
            tooltipText="Menu principal"
            primary
            $={(self: Gtk.MenuButton) => {
              const menu = new Gio.Menu();
              menu.append('Déconnecter ce poste…', 'app.logout');
              menu.append('À propos de WhatsApp pour GNOME', 'app.about');
              self.menuModel = menu;
            }}
          />
        </Adw.HeaderBar>
        <Gtk.SearchEntry
          $type="top"
          placeholderText="Rechercher une discussion"
          marginStart={8}
          marginEnd={8}
          marginBottom={6}
          onSearchChanged={(self: Gtk.SearchEntry) => setQuery(self.text)}
        />
        <Gtk.Stack visibleChildName={shown((l) => (l.length === 0 ? 'empty' : 'list'))}>
          <Adw.StatusPage $type="named" name="empty" iconName="chat-message-new-symbolic" title={query((q) => (q === '' ? 'Aucune discussion' : 'Aucun résultat'))} cssClasses={['compact']} />
          <Gtk.ScrolledWindow $type="named" name="list" hscrollbarPolicy={Gtk.PolicyType.NEVER} vexpand>
            <Gtk.ListBox
              cssClasses={['navigation-sidebar']}
              $={(self: Gtk.ListBox) => {
                onCleanup(keyedListBox(self, shown, (c) => c.id, ChatRow));
                self.connect('row-activated', (_l: Gtk.ListBox, row: Gtk.ListBoxRow) => store.open(row.name));
                // sélection suivie depuis le store (ouverture par notification, déconnexion)
                const select = (): void => {
                  const id = store.current.peek();
                  let row: Gtk.ListBoxRow | null = null;
                  for (let c = self.get_first_child(); c !== null; c = c.get_next_sibling()) if (c instanceof Gtk.ListBoxRow && c.name === id) row = c;
                  if (row === null) self.unselect_all();
                  else if (self.get_selected_row() !== row) self.select_row(row);
                };
                onCleanup(store.current.subscribe(select));
                onCleanup(shown.subscribe(select));
              }}
            />
          </Gtk.ScrolledWindow>
        </Gtk.Stack>
      </Adw.ToolbarView>
    </Adw.NavigationPage>
  );
}

// Barre latérale : liste des discussions (épinglées puis la plus récente d'abord), recherche par
// nom, discussions archivées à part, menu contextuel (ChatMenu.ts).
import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';
import { createMemo, createState, onCleanup, type Accessor } from 'gnim';
import { type Chat, isMuted } from '../shared/api.ts';
import { fmtShortDate } from '../shared/format.ts';
import type { Store } from '../shared/store.ts';
import { attachChatMenu } from './ChatMenu.ts';
import { keyedListBox } from './KeyedBox.ts';
import { bindAvatar, type Pictures } from './pictures.ts';
import { asWidget } from './widgets.ts';

/** Recherche insensible à la casse et aux accents. */
export const fold = (s: string): string => s.normalize('NFD').replaceAll(/\p{M}/gu, '').toLowerCase();

/** Texte de l'avatar : sans le « ~ » des noms publics (initiales du nom). */
export const avatarText = (name: string): string => name.replace(/^~ /u, '');

function chatRow(pictures: Pictures) {
  return (chat: Chat, live: Accessor<Chat>): Gtk.Widget => ChatRow(chat, live, pictures);
}

function ChatRow(chat: Chat, live: Accessor<Chat>, pictures: Pictures): Gtk.Widget {
  return asWidget(
    <Gtk.ListBoxRow name={chat.id} cssClasses={['chat-row']} tooltipText={live((c) => c.name)}>
      <Gtk.Box spacing={12} marginTop={8} marginBottom={8} marginStart={8} marginEnd={8}>
        <Adw.Avatar size={44} text={live((c) => avatarText(c.name))} showInitials={live((c) => /\p{L}/u.test(c.name))} $={(self: Adw.Avatar) => bindAvatar(self, pictures.texture(chat.id))} />
        <Gtk.Box orientation={Gtk.Orientation.VERTICAL} valign={Gtk.Align.CENTER} hexpand spacing={2}>
          <Gtk.Box spacing={6}>
            <Gtk.Label label={live((c) => c.name)} xalign={0} hexpand ellipsize={Pango.EllipsizeMode.END} cssClasses={['heading']} />
            <Gtk.Label label={live((c) => fmtShortDate(c.timestamp))} cssClasses={live((c) => (c.unread > 0 && !isMuted(c) ? ['caption', 'accent'] : ['caption', 'dim-label']))} />
          </Gtk.Box>
          <Gtk.Box spacing={6}>
            <Gtk.Label label={live((c) => c.preview.replaceAll('\n', ' '))} xalign={0} hexpand ellipsize={Pango.EllipsizeMode.END} cssClasses={['dim-label']} />
            <Gtk.Image iconName="notifications-disabled-symbolic" visible={live((c) => isMuted(c))} tooltipText="Mode silencieux" cssClasses={['dim-label']} />
            <Gtk.Image iconName="view-pin-symbolic" visible={live((c) => c.pinned > 0)} tooltipText="Épinglée" cssClasses={['dim-label']} />
            {/* nombre de non-lus, ou pastille vide pour « marquée comme non lue » */}
            <Gtk.Label
              label={live((c) => (c.unread > 0 ? String(c.unread) : ''))}
              visible={live((c) => c.unread > 0 || c.markedUnread)}
              valign={Gtk.Align.CENTER}
              cssClasses={live((c) => ['unread-badge', ...(isMuted(c) ? ['muted'] : []), ...(c.unread > 0 ? [] : ['dot'])])}
            />
          </Gtk.Box>
        </Gtk.Box>
      </Gtk.Box>
    </Gtk.ListBoxRow>,
  );
}

/** Discussions affichées : archivées ou non, filtrées par la recherche (qui porte sur toutes). */
export function visibleChats(all: readonly Chat[], query: string, archived: boolean): readonly Chat[] {
  const q = fold(query.trim());
  // une recherche porte aussi sur les archivées, comme dans WhatsApp
  if (q !== '') return all.filter((c) => fold(c.name).includes(q));
  return all.filter((c) => c.archived === archived);
}

export function ChatList({ store, pictures, toast }: { store: Store; pictures: Pictures; toast: (text: string) => void }): JSX.Element {
  const [query, setQuery] = createState('');
  const [archived, setArchived] = createState(false);
  const shown = createMemo(() => visibleChats(store.chats(), query(), archived()));
  const archivedCount = createMemo(() => store.chats().filter((c) => c.archived).length);
  // plus d'archivées : retour à la liste principale
  onCleanup(
    archivedCount.subscribe(() => {
      if (archivedCount.peek() === 0) setArchived(false);
    }),
  );
  return (
    <Adw.NavigationPage title={archived((a) => (a ? 'Archivées' : 'Discussions'))} tag="chats">
      <Adw.ToolbarView>
        <Adw.HeaderBar $type="top">
          <Gtk.Button $type="start" iconName="go-previous-symbolic" tooltipText="Retour aux discussions" visible={archived} onClicked={() => setArchived(false)} />
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
          <Adw.StatusPage $type="named" name="empty" iconName="chat-message-new-symbolic" title={createMemo(() => (query() === '' ? (archived() ? 'Aucune discussion archivée' : 'Aucune discussion') : 'Aucun résultat'))} cssClasses={['compact']} />
          <Gtk.ScrolledWindow $type="named" name="list" hscrollbarPolicy={Gtk.PolicyType.NEVER} vexpand>
            <Gtk.Box orientation={Gtk.Orientation.VERTICAL}>
            <Gtk.Button
              visible={createMemo(() => !archived() && query().trim() === '' && archivedCount() > 0)}
              cssClasses={['flat', 'archived-entry']}
              marginStart={6}
              marginEnd={6}
              tooltipText="Discussions archivées"
              onClicked={() => setArchived(true)}
            >
              <Gtk.Box spacing={12} marginStart={14} marginEnd={4}>
                <Gtk.Image iconName="folder-symbolic" />
                <Gtk.Label label="Archivées" xalign={0} hexpand cssClasses={['heading']} />
                <Gtk.Label label={archivedCount(String)} cssClasses={['dim-label', 'caption']} />
              </Gtk.Box>
            </Gtk.Button>
            <Gtk.ListBox
              cssClasses={['navigation-sidebar']}
              $={(self: Gtk.ListBox) => {
                onCleanup(keyedListBox(self, shown, (c) => c.id, chatRow(pictures)));
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
                attachChatMenu(self, store, toast);
              }}
            />
            </Gtk.Box>
          </Gtk.ScrolledWindow>
        </Gtk.Stack>
      </Adw.ToolbarView>
    </Adw.NavigationPage>
  );
}

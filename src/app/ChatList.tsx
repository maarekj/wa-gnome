// Barre latérale : liste des discussions (épinglées puis la plus récente d'abord), recherche par
// nom, discussions archivées à part, menu contextuel (ChatMenu.ts).
import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';
import { createMemo, createState, onCleanup, type Accessor } from 'gnim';
import { type Chat, type ChatList as WaList, isMuted } from '../shared/api.ts';
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

function chatRow(pictures: Pictures, store: Store) {
  return (chat: Chat, live: Accessor<Chat>): Gtk.Widget => ChatRow(chat, live, pictures, store);
}

function ChatRow(chat: Chat, live: Accessor<Chat>, pictures: Pictures, store: Store): Gtk.Widget {
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
            <Gtk.Label
              label={createMemo(() => store.typing().get(live().id) ?? live().preview.replaceAll('\n', ' '))}
              xalign={0}
              hexpand
              ellipsize={Pango.EllipsizeMode.END}
              cssClasses={createMemo(() => (store.typing().has(live().id) ? ['accent'] : ['dim-label']))}
            />
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

/** Filtre de la liste principale : « all » (toutes) ou l'identifiant d'une liste de WhatsApp. */
export type Filter = string;

/** Discussion retenue par une liste de WhatsApp. */
export function inList(c: Chat, list: WaList): boolean {
  switch (list.kind) {
    case 'unread':
      return c.unread > 0 || c.markedUnread;
    case 'groups':
      return c.group;
    case 'favorites':
      return c.favorite;
    case 'custom':
      return c.labels.includes(list.id);
    case 'other':
      return false;
    default:
      return list.kind satisfies never;
  }
}

/** Listes proposées en filtres, dans l'ordre de WhatsApp. */
export const filterLists = (lists: readonly WaList[]): WaList[] => lists.filter((l) => l.kind !== 'other');

/** Vue de la liste : discussions, archivées, ou chaînes (onglet « Actus » du téléphone). */
export type View = 'main' | 'archived' | 'channels';

/** Chaîne WhatsApp (lecture seule). */
export const isChannel = (id: string): boolean => id.endsWith('@newsletter');

/** Discussion de la vue (hors recherche). */
const inView = (c: Chat, view: View): boolean => (view === 'channels' ? isChannel(c.id) : !isChannel(c.id) && c.archived === (view === 'archived'));

/**
 * Discussions affichées : archivées, chaînes ou principales, filtrées par une liste (vue principale) ou par la
 * recherche (qui porte sur toutes, archivées comprises, comme dans WhatsApp).
 */
export function visibleChats(all: readonly Chat[], query: string, view: View, filter: Filter = 'all', lists: readonly WaList[] = []): readonly Chat[] {
  const q = fold(query.trim());
  if (q !== '') return all.filter((c) => fold(c.name).includes(q));
  const list = view !== 'main' || filter === 'all' ? undefined : lists.find((l) => l.id === filter);
  return all.filter((c) => inView(c, view) && (list === undefined || inList(c, list)));
}

export function ChatList({ store, pictures, toast }: { store: Store; pictures: Pictures; toast: (text: string) => void }): JSX.Element {
  const [query, setQuery] = createState('');
  const [view, setView] = createState<View>('main');
  /** hors de la liste principale (archivées ou chaînes) */
  const archived = view((v) => v !== 'main');
  const setArchived = (on: boolean): void => setView(on ? 'archived' : 'main');
  const [filter, setFilter] = createState<Filter>('all');
  const shown = createMemo(() => visibleChats(store.chats(), query(), view(), filter(), store.lists()));
  const archivedCount = createMemo(() => store.chats().filter((c) => inView(c, 'archived')).length);
  const channelCount = createMemo(() => store.chats().filter((c) => isChannel(c.id)).length);
  // plus rien dans la vue : retour à la liste principale
  const back = (): void => {
    if ((view.peek() === 'archived' && archivedCount.peek() === 0) || (view.peek() === 'channels' && channelCount.peek() === 0)) setView('main');
  };
  onCleanup(archivedCount.subscribe(back));
  onCleanup(channelCount.subscribe(back));
  return (
    <Adw.NavigationPage title={view((v) => (v === 'archived' ? 'Archivées' : v === 'channels' ? 'Chaînes' : 'Discussions'))} tag="chats">
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
              menu.append('Préférences', 'app.preferences');
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
        {/* filtres : Toutes, puis les listes de WhatsApp (non lues, favoris, groupes, personnalisées) */}
        {/* à la ligne quand ils ne tiennent pas en largeur (une barre de défilement masquait les boutons : #23) */}
        <Gtk.FlowBox
          $type="top"
          selectionMode={Gtk.SelectionMode.NONE}
          rowSpacing={6}
          columnSpacing={6}
          maxChildrenPerLine={20}
          marginStart={8}
          marginEnd={8}
          marginBottom={6}
          cssClasses={['list-filters']}
          visible={createMemo(() => !archived() && query().trim() === '' && filterLists(store.lists()).length > 0)}
          $={(self: Gtk.FlowBox) => {
            const build = (): void => {
              self.remove_all();
              const lists = filterLists(store.lists.peek());
              // liste disparue : retour à « Toutes »
              if (filter.peek() !== 'all' && !lists.some((l) => l.id === filter.peek())) setFilter('all');
              let first: Gtk.ToggleButton | null = null;
              for (const [id, label] of [['all', 'Toutes'] as const, ...lists.map((l) => [l.id, l.name] as const)]) {
                const b = new Gtk.ToggleButton({ label, active: filter.peek() === id, cssClasses: ['pill', 'filter-chip'] });
                if (first === null) first = b;
                else b.set_group(first);
                b.connect('toggled', () => {
                  if (b.active) setFilter(id);
                });
                // pas de case sélectionnable autour du bouton (focus et clic directement sur lui)
                self.append(new Gtk.FlowBoxChild({ child: b, focusable: false, cssClasses: ['filter-cell'] }));
              }
            };
            build();
            onCleanup(store.lists.subscribe(build));
          }}
        />
        <Gtk.Stack visibleChildName={shown((l) => (l.length === 0 ? 'empty' : 'list'))}>
          <Adw.StatusPage $type="named" name="empty" iconName="chat-message-new-symbolic" title={createMemo(() => (query() === '' ? (view() === 'channels' ? 'Aucune chaîne' : archived() ? 'Aucune discussion archivée' : filter() === 'all' ? 'Aucune discussion' : 'Aucune discussion dans cette liste') : 'Aucun résultat'))} cssClasses={['compact']} />
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
            {/* chaînes suivies : à part, comme l'onglet « Actus » du téléphone */}
            <Gtk.Button
              visible={createMemo(() => !archived() && query().trim() === '' && channelCount() > 0)}
              cssClasses={['flat', 'archived-entry']}
              marginStart={6}
              marginEnd={6}
              tooltipText="Chaînes suivies"
              onClicked={() => setView('channels')}
            >
              <Gtk.Box spacing={12} marginStart={14} marginEnd={4}>
                <Gtk.Image iconName="microphone-sensitivity-high-symbolic" />
                <Gtk.Label label="Chaînes" xalign={0} hexpand cssClasses={['heading']} />
                <Gtk.Label
                  label={createMemo(() => {
                    const unread = store.chats().filter((c) => isChannel(c.id) && c.unread > 0).length;
                    return unread > 0 ? `${unread} non lue${unread > 1 ? 's' : ''}` : String(channelCount());
                  })}
                  cssClasses={['dim-label', 'caption']}
                />
              </Gtk.Box>
            </Gtk.Button>
            <Gtk.ListBox
              cssClasses={['navigation-sidebar']}
              $={(self: Gtk.ListBox) => {
                onCleanup(keyedListBox(self, shown, (c) => c.id, chatRow(pictures, store)));
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

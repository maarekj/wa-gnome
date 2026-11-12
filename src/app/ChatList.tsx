// Barre latérale : liste des discussions (épinglées puis la plus récente d'abord), recherche par
// nom et dans les messages, discussions archivées à part, menu contextuel (ChatMenu.ts).
import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import { createMemo, createState, onCleanup } from 'gnim';
import { type Chat, type ChatList as WaList, type SearchHit } from '../shared/api.ts';
import { errorMessage } from '../shared/errors.ts';
import type { Store } from '../shared/store.ts';
import { chatMenuActions } from './ChatMenu.ts';
import { chatListView, type EntryId, type SideRow } from './ChatListView.ts';
import { openStatuses, statusEntryLabel } from './Statuses.ts';
import type { Pictures } from './pictures.ts';

/** Recherche insensible à la casse et aux accents. */
export const fold = (s: string): string => s.normalize('NFD').replaceAll(/\p{M}/gu, '').toLowerCase();

export { avatarText, previewMarkup } from './ChatListView.ts';

/** Recherche dans les messages à partir de ce nombre de caractères. */
const SEARCH_MIN = 2;

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

/** Discussion voisine de `current` dans la liste affichée (`delta` : +1 suivante, -1 précédente). */
export function neighbourChat(list: readonly Chat[], current: string | null, delta: number): string | null {
  if (list.length === 0) return null;
  const i = list.findIndex((c) => c.id === current);
  if (i < 0) return list[delta > 0 ? 0 : list.length - 1]?.id ?? null;
  return list[i + delta]?.id ?? null;
}

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

export function ChatList({ store, pictures, toast, switcher, removable = false }: { store: Store; pictures: Pictures; toast: (text: string) => void; switcher?: Gtk.Widget; removable?: boolean }): JSX.Element {
  const [query, setQuery] = createState('');
  const [view, setView] = createState<View>('main');
  // messages trouvés (recherche dans le contenu, après une courte pause de frappe)
  const [hits, setHits] = createState<readonly SearchHit[]>([]);
  let searchTimer = 0;
  let searchGen = 0;
  onCleanup(
    query.subscribe(() => {
      if (searchTimer !== 0) GLib.source_remove(searchTimer);
      searchTimer = 0;
      const q = query.peek().trim();
      const gen = (searchGen += 1);
      if (q.length < SEARCH_MIN) {
        setHits([]);
        return;
      }
      searchTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
        searchTimer = 0;
        void (async (): Promise<void> => {
          try {
            const found = await store.client.search(q);
            if (gen === searchGen) setHits(found);
          } catch (error) {
            if (gen === searchGen) setHits([]);
            console.error(`recherche : ${errorMessage(error)}`);
          }
        })();
        return GLib.SOURCE_REMOVE;
      });
    }),
  );
  /** hors de la liste principale (archivées ou chaînes) */
  const archived = view((v) => v !== 'main');
  const setArchived = (on: boolean): void => setView(on ? 'archived' : 'main');
  const [filter, setFilter] = createState<Filter>('all');
  const shown = createMemo(() => visibleChats(store.chats(), query(), view(), filter(), store.lists()));
  /** Alt+Haut / Alt+Bas : discussion précédente / suivante de la liste affichée */
  const step = (delta: number): void => {
    const id = neighbourChat(shown.peek(), store.current.peek(), delta);
    if (id !== null) store.open(id);
  };
  const archivedCount = createMemo(() => store.chats().filter((c) => inView(c, 'archived')).length);
  const channelCount = createMemo(() => store.chats().filter((c) => isChannel(c.id)).length);
  // plus rien dans la vue : retour à la liste principale
  const back = (): void => {
    if ((view.peek() === 'archived' && archivedCount.peek() === 0) || (view.peek() === 'channels' && channelCount.peek() === 0)) setView('main');
  };
  onCleanup(archivedCount.subscribe(back));
  onCleanup(channelCount.subscribe(back));
  // entrées (liste principale, hors recherche), discussions, puis messages trouvés
  const entries = createMemo((): SideRow[] => {
    if (archived() || query().trim() !== '') return [];
    const out: SideRow[] = [];
    if (archivedCount() > 0) out.push({ kind: 'entry', id: 'archived', count: String(archivedCount()), accent: false });
    // statuts (« stories ») de moins de 24 h : fenêtre à part
    const statuses = store.statuses();
    if (statuses.some((g) => !g.me)) out.push({ kind: 'entry', id: 'statuses', count: statusEntryLabel(statuses), accent: statuses.some((g) => !g.me && g.items.some((i) => !i.seen)) });
    // chaînes suivies : à part, comme l'onglet « Actus » du téléphone
    if (channelCount() > 0) {
      const unread = store.chats().filter((c) => isChannel(c.id) && c.unread > 0).length;
      out.push({ kind: 'entry', id: 'channels', count: unread > 0 ? `${unread} non lue${unread > 1 ? 's' : ''}` : String(channelCount()), accent: false });
    }
    return out;
  });
  const rows = createMemo((): readonly SideRow[] => {
    const found = hits();
    return [...entries(), ...shown().map((chat): SideRow => ({ kind: 'chat', chat })), ...(found.length > 0 ? [{ kind: 'header' } as const, ...found.map((hit): SideRow => ({ kind: 'hit', hit }))] : [])];
  });
  const openEntry = (id: EntryId, button: Gtk.Button): void => {
    if (id === 'statuses') openStatuses(button, store, pictures, toast);
    else setView(id);
  };
  return (
    <Adw.NavigationPage title={view((v) => (v === 'archived' ? 'Archivées' : v === 'channels' ? 'Chaînes' : 'Discussions'))} tag="chats">
      <Adw.ToolbarView>
        <Adw.HeaderBar
          $type="top"
          $={(self: Adw.HeaderBar) => {
            // sélecteur de compte : en tête, masqué dans les archives et les chaînes
            if (switcher === undefined) return;
            self.pack_start(switcher);
            const sync = (): void => {
              switcher.visible = !archived.peek();
            };
            sync();
            onCleanup(archived.subscribe(sync));
          }}
        >
          <Gtk.Button $type="start" iconName="go-previous-symbolic" tooltipText="Retour aux discussions" visible={archived} onClicked={() => setArchived(false)} />
          <Gtk.Button
            $type="start"
            iconName="chat-message-new-symbolic"
            tooltipText="Nouvelle discussion (Ctrl+N)"
            visible={archived((a) => !a)}
            actionName="app.new-chat"
          />
          <Gtk.MenuButton
            $type="end"
            iconName="open-menu-symbolic"
            tooltipText="Menu principal"
            primary
            $={(self: Gtk.MenuButton) => {
              const menu = new Gio.Menu();
              menu.append('Préférences', 'app.preferences');
              menu.append('Raccourcis clavier', 'app.shortcuts');
              menu.append('Déconnecter ce poste…', 'app.logout');
              // compte ajouté : retirable (le premier se déconnecte seulement)
              if (removable) menu.append('Retirer ce compte…', 'app.remove-account');
              menu.append('Diagnostic', 'app.diagnostics');
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
          $={(self: Gtk.SearchEntry) => {
            // Échap : recherche vidée et quittée (focus rendu à la liste)
            self.connect('stop-search', () => {
              self.text = '';
              self.get_root()?.set_focus(null);
            });
            // raccourcis de la fenêtre : Ctrl+K recherche, Alt+Haut / Alt+Bas discussion précédente / suivante
            const shortcuts = new Gtk.ShortcutController({ scope: Gtk.ShortcutScope.GLOBAL });
            const add = (accel: string, run: () => void): void => {
              shortcuts.add_shortcut(
                new Gtk.Shortcut({
                  trigger: Gtk.ShortcutTrigger.parse_string(accel),
                  action: Gtk.CallbackAction.new(() => {
                    // fenêtre (nouvelle discussion, préférences…) ouverte : raccourci laissé à la fenêtre
                    const root = self.get_root();
                    if (root instanceof Adw.ApplicationWindow && root.visibleDialog !== null) return false;
                    run();
                    return true;
                  }),
                }),
              );
            };
            add('<Control>k', () => {
              self.grab_focus();
              self.select_region(0, -1);
            });
            add('<Alt>Down', () => step(1));
            add('<Alt>Up', () => step(-1));
            self.add_controller(shortcuts);
          }}
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
        {/* liste toujours en place (dimensionnée dès le lancement : seules les lignes visibles sont
            créées), message « aucune discussion » par-dessus quand elle est vide */}
        <Gtk.Overlay>
          {/* liste virtuelle : enfant direct de la zone défilante (sinon toutes les lignes existent) */}
          <Gtk.ScrolledWindow
            hscrollbarPolicy={Gtk.PolicyType.NEVER}
            vexpand
            $={(self: Gtk.ScrolledWindow) => {
              const { view: list, dispose } = chatListView({ store, pictures, rows, openEntry, menu: (w) => chatMenuActions(w, store, toast) });
              self.child = list;
              onCleanup(dispose);
            }}
          />
          <Adw.StatusPage
            $type="overlay"
            visible={createMemo(() => rows().length === 0)}
            iconName="chat-message-new-symbolic"
            title={createMemo(() => (query() === '' ? (view() === 'channels' ? 'Aucune chaîne' : archived() ? 'Aucune discussion archivée' : filter() === 'all' ? 'Aucune discussion' : 'Aucune discussion dans cette liste') : 'Aucun résultat'))}
            cssClasses={['compact']}
          />
        </Gtk.Overlay>
      </Adw.ToolbarView>
    </Adw.NavigationPage>
  );
}

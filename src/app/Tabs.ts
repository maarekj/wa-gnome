// Onglets des discussions ouvertes, au-dessus de la zone de conversation. Une seule zone est
// partagée : l'Adw.TabView n'a que des pages vides (affichées par l'Adw.TabBar), changer
// d'onglet ouvre la discussion dans le Store (`store.tabs`, `store.current`).
import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';
import { onCleanup } from 'gnim';
import type { Store } from '../shared/store.ts';
import type { Pictures } from './pictures.ts';

/** Barre d'onglets du Store (cachée sans onglet). */
export function tabBar(store: Store, pictures: Pictures): Gtk.Widget {
  const view = new Adw.TabView({ visible: false, shortcuts: Adw.TabViewShortcuts.NONE });
  const bar = new Adw.TabBar({ view, autohide: false, expandTabs: false });
  const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
  box.append(bar);
  // la vue doit être dans l'arbre des widgets (glisser-déposer des onglets) ; jamais affichée
  box.append(view);
  /** page de chaque discussion */
  const pages = new Map<string, Adw.TabPage>();
  /** abonnement à la photo de chaque onglet (retiré avec lui) */
  const icons = new Map<string, () => void>();
  const forget = (id: string): void => {
    pages.delete(id);
    icons.get(id)?.();
    icons.delete(id);
  };
  /** synchronisation en cours : les signaux de la vue ne repartent pas vers le Store */
  let syncing = false;

  const nameOf = (id: string): string => store.chats.peek().find((c) => c.id === id)?.name ?? store.nameHint(id) ?? id.split('@')[0] ?? id;
  const label = (page: Adw.TabPage, id: string): void => {
    const chat = store.chats.peek().find((c) => c.id === id);
    page.title = nameOf(id);
    page.tooltip = nameOf(id);
    // non lue : onglet signalé (point de la barre)
    page.needsAttention = chat !== undefined && id !== store.current.peek() && (chat.unread > 0 || chat.markedUnread);
  };
  const pageFor = (id: string): Adw.TabPage => {
    let page = pages.get(id);
    if (page === undefined) {
      page = view.append(new Gtk.Box());
      const p = page;
      // photo de la discussion en icône de l'onglet (une texture est une Gio.Icon)
      const texture = pictures.texture(id);
      const setIcon = (): void => {
        p.icon = texture.peek();
      };
      setIcon();
      icons.set(id, texture.subscribe(setIcon));
      pages.set(id, page);
    }
    return page;
  };

  const sync = (): void => {
    syncing = true;
    try {
      const ids = store.tabs.peek();
      for (const [id, page] of pages)
        if (!ids.includes(id)) {
          forget(id);
          view.close_page(page);
        }
      ids.forEach((id, i) => {
        const page = pageFor(id);
        if (view.get_page_position(page) !== i) view.reorder_page(page, i);
        label(page, id);
      });
      const current = store.current.peek();
      const selected = current === null ? undefined : pages.get(current);
      if (selected !== undefined && view.selectedPage !== selected) view.selectedPage = selected;
      bar.visible = ids.length > 0;
    } finally {
      syncing = false;
    }
  };

  view.connect('notify::selected-page', () => {
    if (syncing) return;
    const page = view.selectedPage;
    const id = [...pages].find(([, p]) => p === page)?.[0];
    if (id !== undefined && id !== store.current.peek()) store.open(id);
  });
  // fermeture (bouton, clic du milieu) : confirmée, puis retirée du Store
  view.connect('close-page', (_v: Adw.TabView, page: Adw.TabPage) => {
    view.close_page_finish(page, true);
    if (syncing) return true;
    const id = [...pages].find(([, p]) => p === page)?.[0];
    if (id !== undefined) {
      forget(id);
      store.closeTab(id);
    }
    return true;
  });
  // onglet glissé : nouvel ordre
  view.connect('page-reordered', () => {
    if (syncing) return;
    const order = Array.from({ length: view.nPages }, (_, i) => view.get_nth_page(i));
    store.setTabs(order.flatMap((p) => [...pages].filter(([, q]) => q === p).map(([id]) => id)));
  });

  sync();
  onCleanup(store.tabs.subscribe(sync));
  onCleanup(store.current.subscribe(sync));
  onCleanup(store.chats.subscribe(sync));
  onCleanup(() => {
    for (const off of icons.values()) off();
  });
  return box;
}

/** Onglet voisin de l'actif (Ctrl+Tab : +1, Ctrl+Maj+Tab : -1), en boucle. */
export function stepTab(store: Store, delta: number): void {
  const tabs = store.tabs.peek();
  if (tabs.length === 0) return;
  const at = tabs.indexOf(store.current.peek() ?? '');
  const next = tabs[(((at < 0 ? 0 : at + delta) % tabs.length) + tabs.length) % tabs.length];
  if (next !== undefined) store.open(next);
}

/** N-ième onglet (Alt+1…8 ; Alt+9 : le dernier). */
export function nthTab(store: Store, n: number): void {
  const tabs = store.tabs.peek();
  const id = n >= 9 ? tabs.at(-1) : tabs[n - 1];
  if (id !== undefined) store.open(id);
}

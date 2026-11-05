// Conteneur dont les enfants suivent une liste réactive, dans l'ordre exact de la liste.
// (<For> de gnim ajoute les nouveaux éléments à la fin, sans insertion à un index.)
// Chaque enfant vit dans sa propre racine gnim, libérée quand l'élément disparaît.
import Gtk from 'gi://Gtk?version=4.0';
import { createRoot, createState, type Accessor, type Setter } from 'gnim';

interface Child<T> {
  readonly widget: Gtk.Widget;
  readonly dispose: () => void;
  /** dernière valeur de l'élément (accessor `live` du rendu) */
  readonly set: Setter<T>;
}

/**
 * Rendu d'un élément : `item` à la création ; `live` suit les valeurs suivantes de l'élément de
 * même clé (clé stable + mise à jour sur place, au lieu de reconstruire le widget).
 */
export type Render<T> = (item: T, live: Accessor<T>) => Gtk.Widget;

/** Opérations d'un conteneur ordonné : insérer à un index, retirer. */
interface Container {
  /** `after` : widget qui précède l'index (null : en tête) */
  insert: (widget: Gtk.Widget, index: number, after: Gtk.Widget | null) => void;
  remove: (widget: Gtk.Widget) => void;
}

function keyed<T>(container: Container, items: Accessor<readonly T[]>, key: (item: T) => string, render: Render<T>): () => void {
  const children = new Map<string, Child<T>>();
  /** ordre actuel des clés dans le conteneur */
  let order: string[] = [];

  /** widget placé juste avant `index` (insertion en O(1), sans parcourir les enfants) */
  const previous = (index: number): Gtk.Widget | null => (index === 0 ? null : (children.get(order[index - 1] ?? '')?.widget ?? null));

  const sync = (): void => {
    const list = items.peek();
    const keys = list.map((it) => key(it));
    const wanted = new Set(keys);
    for (const [k, c] of children) {
      if (!wanted.has(k)) {
        container.remove(c.widget);
        c.dispose();
        children.delete(k);
      }
    }
    order = order.filter((k) => wanted.has(k));
    list.forEach((it, index) => {
      const k = keys[index] ?? '';
      let c = children.get(k);
      if (c === undefined) {
        c = createRoot((dispose) => {
          const [live, set] = createState(it);
          return { widget: render(it, live), dispose, set };
        });
        children.set(k, c);
        container.insert(c.widget, index, previous(index));
        order.splice(index, 0, k);
      } else {
        c.set(it);
      }
      if (order[index] !== k) {
        container.remove(c.widget);
        order.splice(order.indexOf(k), 1);
        container.insert(c.widget, index, previous(index));
        order.splice(index, 0, k);
      }
    });
  };

  sync();
  const unsubscribe = items.subscribe(sync);
  return () => {
    unsubscribe();
    for (const c of children.values()) c.dispose();
    children.clear();
  };
}

/** Gtk.Box ordonné selon `items`. */
export function keyedBox<T>(box: Gtk.Box, items: Accessor<readonly T[]>, key: (item: T) => string, render: Render<T>): () => void {
  return keyed(
    {
      insert: (w, _index, after) => box.insert_child_after(w, after),
      remove: (w) => box.remove(w),
    },
    items,
    key,
    render,
  );
}

/** Gtk.ListBox ordonné selon `items` (sans fonction de tri). */
export function keyedListBox<T>(list: Gtk.ListBox, items: Accessor<readonly T[]>, key: (item: T) => string, render: Render<T>): () => void {
  return keyed(
    {
      insert: (w, index) => list.insert(w, index),
      remove: (w) => list.remove(w instanceof Gtk.ListBoxRow ? w : (w.get_parent() ?? w)),
    },
    items,
    key,
    render,
  );
}

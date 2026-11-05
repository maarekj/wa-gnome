// Utilitaires de widgets.
import Gtk from 'gi://Gtk?version=4.0';

/** Élément JSX vérifié comme widget GTK. */
export function asWidget(o: JSX.Element): Gtk.Widget {
  if (!(o instanceof Gtk.Widget)) throw new TypeError('widget attendu');
  return o;
}

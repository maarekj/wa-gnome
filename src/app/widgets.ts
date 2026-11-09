// Utilitaires de widgets.
import type Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';

/** Élément JSX vérifié comme widget GTK. */
export function asWidget(o: JSX.Element): Gtk.Widget {
  if (!(o instanceof Gtk.Widget)) throw new TypeError('widget attendu');
  return o;
}

/**
 * Liens d'un libellé ouverts dans l'application par défaut (navigateur, messagerie).
 * Tests (WA_GNOME_TEST_LINKS) : journalisés (`LIEN url`) au lieu d'être ouverts.
 */
export function openLinks(label: Gtk.Label): void {
  label.connect('activate-link', (_l: Gtk.Label, uri: string) => {
    if (GLib.getenv('WA_GNOME_TEST_LINKS') !== null) {
      console.log(`LIEN ${uri}`);
      return true;
    }
    const root = label.get_root();
    new Gtk.UriLauncher({ uri }).launch(root instanceof Gtk.Window ? root : null, null, (launcher: Gtk.UriLauncher | null, res: Gio.AsyncResult) => {
      try {
        launcher?.launch_finish(res);
      } catch (error) {
        console.error(`lien ${uri} : ${error instanceof Error ? error.message : String(error)}`);
      }
    });
    return true;
  });
}

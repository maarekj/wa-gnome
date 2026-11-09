// Appels qui sonnent, en surimpression en haut de la fenêtre : photo, nom, type d'appel, boutons
// Refuser / Refuser avec un message (décrocher se fait sur le téléphone).
import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';
import type { Call } from '../shared/api.ts';

/** Appel affiché : textes et actions déjà préparés par l'application. */
export interface RingingCall {
  /** clé unique (compte et identifiant de l'appel) */
  key: string;
  call: Call;
  name: string;
  /** compte, s'il y en a plusieurs */
  account: string | null;
  picture: Gtk.Widget | null;
  open: () => void;
  reject: (withMessage: boolean) => void;
}

export class CallBanner {
  /** à placer en surimpression (Gtk.Overlay) */
  readonly widget: Gtk.Box;
  readonly #rows = new Map<string, Gtk.Widget>();

  constructor() {
    this.widget = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 8, halign: Gtk.Align.CENTER, valign: Gtk.Align.START, marginTop: 56, visible: false });
  }

  ring(r: RingingCall): void {
    this.end(r.key);
    const card = new Gtk.Box({ spacing: 12, cssClasses: ['card', 'call-banner'], widthRequest: 420 });
    card.update_property([Gtk.AccessibleProperty.LABEL], [`Appel de ${r.name}`]);
    card.append(r.picture ?? new Adw.Avatar({ size: 48, text: r.name, showInitials: true }));
    const texts = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, valign: Gtk.Align.CENTER, hexpand: true, spacing: 2 });
    texts.append(new Gtk.Label({ label: `${r.name} vous appelle`, xalign: 0, ellipsize: Pango.EllipsizeMode.END, cssClasses: ['heading'] }));
    const kind = `${r.call.video ? 'Appel vidéo' : 'Appel vocal'}${r.call.group ? ' de groupe' : ''}${r.account === null ? '' : ` · ${r.account}`}`;
    texts.append(new Gtk.Label({ label: kind, xalign: 0, ellipsize: Pango.EllipsizeMode.END, cssClasses: ['caption'] }));
    texts.append(new Gtk.Label({ label: 'Décrochez sur votre téléphone', xalign: 0, cssClasses: ['caption', 'dim-label'] }));
    card.append(texts);
    const icon = new Gtk.Image({ iconName: r.call.video ? 'camera-video-symbolic' : 'call-start-symbolic', pixelSize: 20, cssClasses: ['ringing'] });
    card.append(icon);
    const buttons = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6, valign: Gtk.Align.CENTER });
    const reject = new Gtk.Button({ label: 'Refuser', cssClasses: ['destructive-action', 'pill'] });
    reject.connect('clicked', () => r.reject(false));
    const message = new Gtk.Button({ label: 'Refuser avec un message', cssClasses: ['pill'] });
    message.connect('clicked', () => r.reject(true));
    buttons.append(reject);
    buttons.append(message);
    card.append(buttons);
    // clic sur la carte (hors boutons) : discussion de l'appelant
    const click = new Gtk.GestureClick();
    click.connect('released', () => r.open());
    texts.add_controller(click);
    this.#rows.set(r.key, card);
    this.widget.append(card);
    this.widget.visible = true;
  }

  end(key: string): void {
    const row = this.#rows.get(key);
    if (row === undefined) return;
    this.#rows.delete(key);
    this.widget.remove(row);
    this.widget.visible = this.#rows.size > 0;
  }
}

// Forme d'onde d'un vocal (comme WhatsApp) : barres arrondies, partie écoutée en couleur
// d'accent ; clic ou glisser pour se déplacer dans le vocal.
import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import Gtk from 'gi://Gtk?version=4.0';

/** Barres affichées : la forme d'onde (64 valeurs) ramenée à `count` barres (maximum par groupe). */
export function bars(values: readonly number[], count: number): number[] {
  if (values.length === 0 || count <= 0) return [];
  return Array.from({ length: count }, (_, i) => {
    const from = Math.floor((i * values.length) / count);
    const to = Math.max(from + 1, Math.floor(((i + 1) * values.length) / count));
    return Math.max(...values.slice(from, to)) / 100;
  });
}

/** Largeur d'une barre et espace entre deux barres (px). */
const BAR = 3;
const GAP = 2;

export interface WaveformView {
  readonly widget: Gtk.Widget;
  /** part écoutée (0 à 1) */
  setProgress: (fraction: number) => void;
}

/** Forme d'onde ; `seek` reçoit la position visée (0 à 1) au clic ou au glissement. */
export function waveformView(values: readonly number[], seek: (fraction: number) => void): WaveformView {
  let progress = 0;
  // curseur pour l'accessibilité (lecteur d'écran) et le clavier (flèches : ±5 %)
  const area = new Gtk.DrawingArea({ hexpand: true, contentHeight: 30, valign: Gtk.Align.CENTER, tooltipText: 'Position dans le vocal', accessibleRole: Gtk.AccessibleRole.SLIDER, focusable: true, sensitive: false });
  const announce = (): void => {
    area.update_property([Gtk.AccessibleProperty.VALUE_MIN, Gtk.AccessibleProperty.VALUE_MAX, Gtk.AccessibleProperty.VALUE_NOW], [0, 100, Math.round(progress * 100)]);
  };
  announce();
  const keys = new Gtk.EventControllerKey();
  keys.connect('key-pressed', (_c: Gtk.EventControllerKey, keyval: number) => {
    if (keyval !== Gdk.KEY_Left && keyval !== Gdk.KEY_Right) return false;
    seek(Math.max(0, Math.min(1, progress + (keyval === Gdk.KEY_Right ? 0.05 : -0.05))));
    return true;
  });
  area.add_controller(keys);
  area.set_draw_func((self: Gtk.DrawingArea, cr, w: number, h: number) => {
    const list = bars(values, Math.max(1, Math.floor((w + GAP) / (BAR + GAP))));
    const fg = self.get_color();
    const accent = Adw.StyleManager.get_default().get_accent_color_rgba();
    for (const [i, v] of list.entries()) {
      const height = Math.max(3, v * h);
      const x = i * (BAR + GAP);
      const y = (h - height) / 2;
      const played = (i + 0.5) / list.length <= progress;
      const c = played ? accent : fg;
      cr.setSourceRGBA(c.red, c.green, c.blue, played ? 1 : 0.35);
      // barre arrondie : rectangle aux bouts en demi-cercles
      const r = BAR / 2;
      cr.arc(x + r, y + r, r, Math.PI, 0);
      cr.arc(x + r, y + height - r, r, 0, Math.PI);
      cr.closePath();
      cr.fill();
    }
  });
  const at = (x: number): number => Math.max(0, Math.min(1, x / Math.max(1, area.get_width())));
  const click = new Gtk.GestureClick();
  click.connect('pressed', (_g: Gtk.GestureClick, _n: number, x: number) => seek(at(x)));
  area.add_controller(click);
  const drag = new Gtk.GestureDrag();
  let startX = 0;
  drag.connect('drag-begin', (_g: Gtk.GestureDrag, x: number) => {
    startX = x;
  });
  drag.connect('drag-update', (_g: Gtk.GestureDrag, dx: number) => seek(at(startX + dx)));
  area.add_controller(drag);
  return {
    widget: area,
    setProgress: (fraction) => {
      if (Math.abs(fraction - progress) < 0.002) return;
      progress = fraction;
      announce();
      area.queue_draw();
    },
  };
}

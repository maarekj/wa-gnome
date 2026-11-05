// Image à taille fixe dans une bulle (Gtk.Picture prend la taille naturelle de l'image).
import Gdk from 'gi://Gdk?version=4.0';
import GObject from 'gi://GObject';
import Graphene from 'gi://Graphene';
import Gsk from 'gi://Gsk';
import Gtk from 'gi://Gtk?version=4.0';

/**
 * Image à taille fixe, recadrée pour remplir son cadre (comme `object-fit: cover`), coins
 * arrondis. Gtk.Picture prend la taille naturelle de l'image : inutilisable dans une bulle.
 */
export const MediaFrame = GObject.registerClass(
  class MediaFrame extends Gtk.Widget {
    #paintable: Gdk.Paintable | null = null;
    #w = 0;
    #h = 0;
    #radius = 10;
    /** `contain` : image entière (autocollants), `cover` : cadre rempli (photos) */
    #fit: 'cover' | 'contain' = 'cover';

    setup(w: number, h: number, fit: 'cover' | 'contain', radius: number): void {
      this.#w = w;
      this.#h = h;
      this.#fit = fit;
      this.#radius = radius;
      this.queue_resize();
    }

    setPaintable(p: Gdk.Paintable | null): void {
      this.#paintable = p;
      this.queue_draw();
    }

    override vfunc_get_request_mode(): Gtk.SizeRequestMode {
      return Gtk.SizeRequestMode.CONSTANT_SIZE;
    }

    override vfunc_measure(orientation: Gtk.Orientation): [number, number, number, number] {
      const size = orientation === Gtk.Orientation.HORIZONTAL ? this.#w : this.#h;
      return [size, size, -1, -1];
    }

    override vfunc_snapshot(snapshot: Gtk.Snapshot): void {
      const p = this.#paintable;
      const W = this.get_width();
      const H = this.get_height();
      const bounds = new Graphene.Rect().init(0, 0, W, H);
      snapshot.push_rounded_clip(new Gsk.RoundedRect().init_from_rect(bounds, this.#radius));
      if (this.#fit === 'cover') snapshot.append_color(placeholderColor(this), bounds);
      if (p !== null) {
        const iw = p.get_intrinsic_width() || W;
        const ih = p.get_intrinsic_height() || H;
        const scale = this.#fit === 'cover' ? Math.max(W / iw, H / ih) : Math.min(W / iw, H / ih);
        const dw = iw * scale;
        const dh = ih * scale;
        snapshot.save();
        snapshot.translate(new Graphene.Point().init((W - dw) / 2, (H - dh) / 2));
        p.snapshot(snapshot, dw, dh);
        snapshot.restore();
      }
      snapshot.pop();
    }
  },
);
export type MediaFrame = InstanceType<typeof MediaFrame>;

/** Fond du cadre pendant le chargement : couleur du texte très atténuée. */
function placeholderColor(w: Gtk.Widget): Gdk.RGBA {
  const c = w.get_color();
  return new Gdk.RGBA({ red: c.red, green: c.green, blue: c.blue, alpha: 0.08 });
}


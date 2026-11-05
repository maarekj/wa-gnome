// QR code d'un texte réactif (le QR d'appairage WhatsApp change toutes les ~20 s), dessiné en
// modules noirs sur fond blanc : lisible quel que soit le thème.
import Gtk from 'gi://Gtk?version=4.0';
import { onCleanup, type Accessor } from 'gnim';
import qrGenerator from 'qrcode-generator';

type Matrix = { readonly n: number; readonly dark: (y: number, x: number) => boolean } | null;

const matrix = (text: string): Matrix => {
  if (text === '') return null;
  const qr = qrGenerator(0, 'L');
  qr.addData(text);
  qr.make();
  return { n: qr.getModuleCount(), dark: (y, x) => qr.isDark(y, x) };
};

export function qrCode(text: Accessor<string>, size = 264): Gtk.Widget {
  let m = matrix(text.peek());
  const area = new Gtk.DrawingArea({ contentWidth: size, contentHeight: size, halign: Gtk.Align.CENTER, cssClasses: ['qr-code'] });
  area.set_draw_func((_a: Gtk.DrawingArea, cr, w: number, h: number) => {
    if (m === null) return;
    const quiet = 3;
    const side = Math.min(w, h);
    const cell = Math.floor(side / (m.n + quiet * 2));
    const offset = (side - cell * m.n) / 2;
    cr.setSourceRGB(1, 1, 1);
    cr.rectangle(0, 0, side, side);
    cr.fill();
    cr.setSourceRGB(0, 0, 0);
    for (let y = 0; y < m.n; y += 1) for (let x = 0; x < m.n; x += 1) if (m.dark(y, x)) cr.rectangle(offset + x * cell, offset + y * cell, cell, cell);
    cr.fill();
  });
  onCleanup(
    text.subscribe(() => {
      m = matrix(text.peek());
      area.queue_draw();
    }),
  );
  return area;
}

// Messages programmés : choix de l'heure d'envoi (raccourcis et date précise) et bandeau des
// messages en attente de la discussion (annulables). L'envoi est fait par le démon à l'heure dite,
// même si l'application est fermée.
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';
import { onCleanup } from 'gnim';
import type { Scheduled } from '../shared/api.ts';
import { errorMessage } from '../shared/errors.ts';
import { fmtDateTime } from '../shared/format.ts';
import type { Store } from '../shared/store.ts';

/** Heure locale (secondes) du jour `day` (0 : aujourd'hui) à `hour`:`minute`. */
function localAt(now: GLib.DateTime, day: number, hour: number, minute = 0): number {
  const d = now.add_days(day) ?? now;
  return GLib.DateTime.new_local(d.get_year(), d.get_month(), d.get_day_of_month(), hour, minute, 0)?.to_unix() ?? now.to_unix();
}

/** Raccourcis proposés : dans 1 h, ce soir 20 h (s'il est avant 19 h), demain 9 h, lundi 9 h. */
export function scheduleChoices(now = GLib.DateTime.new_now_local()): { label: string; at: number }[] {
  const out = [{ label: 'Dans 1 heure', at: now.to_unix() + 3600 }];
  if (now.get_hour() < 19) out.push({ label: 'Ce soir à 20:00', at: localAt(now, 0, 20) });
  out.push({ label: 'Demain à 09:00', at: localAt(now, 1, 9) });
  // lundi prochain (jamais aujourd'hui ni demain)
  const toMonday = ((8 - now.get_day_of_week()) % 7) || 7;
  if (toMonday > 1) out.push({ label: 'Lundi à 09:00', at: localAt(now, toMonday, 9) });
  return out;
}

/**
 * Bouton « Programmer l'envoi » : raccourcis, ou date (calendrier) et heure précises.
 * `schedule` reçoit l'heure choisie (secondes) et programme le texte de la saisie.
 */
export function scheduleButton(schedule: (at: number) => void): Gtk.MenuButton {
  const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6, marginTop: 6, marginBottom: 6, marginStart: 6, marginEnd: 6 });
  box.append(new Gtk.Label({ label: 'Programmer l’envoi', xalign: 0, cssClasses: ['heading'] }));
  const quick = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
  box.append(quick);
  const calendar = new Gtk.Calendar();
  const hour = new Gtk.SpinButton({ adjustment: new Gtk.Adjustment({ lower: 0, upper: 23, stepIncrement: 1 }), numeric: true, wrap: true, orientation: Gtk.Orientation.VERTICAL, tooltipText: 'Heure' });
  const minute = new Gtk.SpinButton({ adjustment: new Gtk.Adjustment({ lower: 0, upper: 55, stepIncrement: 5 }), numeric: true, wrap: true, orientation: Gtk.Orientation.VERTICAL, tooltipText: 'Minutes' });
  // minutes sur deux chiffres
  minute.connect('output', () => {
    minute.text = String(minute.value).padStart(2, '0');
    return true;
  });
  const time = new Gtk.Box({ spacing: 4, halign: Gtk.Align.CENTER });
  time.append(hour);
  time.append(new Gtk.Label({ label: ':' }));
  time.append(minute);
  const custom = new Gtk.Button({ label: 'Programmer', cssClasses: ['suggested-action', 'pill'], halign: Gtk.Align.CENTER });
  const exact = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 8 });
  exact.append(calendar);
  exact.append(time);
  exact.append(custom);
  const expander = new Gtk.Expander({ label: 'Choisir la date et l’heure…', child: exact });
  box.append(new Gtk.Separator());
  box.append(expander);
  const popover = new Gtk.Popover({ child: box });
  const button = new Gtk.MenuButton({ iconName: 'alarm-symbolic', tooltipText: 'Programmer l’envoi', popover, cssClasses: ['circular', 'flat'], valign: Gtk.Align.END });
  const pick = (at: number): void => {
    popover.popdown();
    schedule(at);
  };
  popover.connect('show', () => {
    // raccourcis et heure par défaut (dans une heure, arrondie) recalculés à l'ouverture
    for (let c = quick.get_first_child(); c !== null; c = quick.get_first_child()) quick.remove(c);
    const now = GLib.DateTime.new_now_local();
    for (const c of scheduleChoices(now)) {
      const b = new Gtk.Button({ cssClasses: ['flat'] });
      const row = new Gtk.Box({ spacing: 12 });
      row.append(new Gtk.Label({ label: c.label, xalign: 0, hexpand: true }));
      row.append(new Gtk.Label({ label: fmtDateTime(c.at), cssClasses: ['dim-label', 'caption'] }));
      b.child = row;
      b.update_property([Gtk.AccessibleProperty.LABEL], [c.label]);
      b.connect('clicked', () => pick(c.at));
      quick.append(b);
    }
    const later = now.add_hours(1) ?? now;
    calendar.set_date(later);
    hour.value = later.get_hour();
    minute.value = Math.floor(later.get_minute() / 5) * 5;
    expander.expanded = false;
  });
  custom.connect('clicked', () => {
    const d = calendar.get_date();
    const at = GLib.DateTime.new_local(d.get_year(), d.get_month(), d.get_day_of_month(), hour.get_value_as_int(), minute.get_value_as_int(), 0)?.to_unix() ?? 0;
    pick(at);
  });
  return button;
}

/** Bandeau des messages programmés de la discussion ouverte (au-dessus de la saisie). */
export function ScheduledBar(store: Store, toast: (t: string) => void): Gtk.Widget {
  const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2, visible: false, cssClasses: ['scheduled-bar'] });
  const row = (s: Scheduled): Gtk.Widget => {
    const line = new Gtk.Box({ spacing: 8 });
    line.append(new Gtk.Image({ iconName: s.error === null ? 'alarm-symbolic' : 'dialog-warning-symbolic' }));
    const texts = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, hexpand: true });
    texts.append(new Gtk.Label({ label: `Programmé · ${fmtDateTime(s.at)}${s.error === null ? '' : ` · échec : ${s.error}`}`, xalign: 0, ellipsize: Pango.EllipsizeMode.END, cssClasses: ['caption-heading', s.error === null ? 'accent' : 'error'] }));
    texts.append(new Gtk.Label({ label: s.text.replaceAll('\n', ' '), xalign: 0, ellipsize: Pango.EllipsizeMode.END, singleLineMode: true }));
    line.append(texts);
    const cancel = new Gtk.Button({ iconName: 'window-close-symbolic', tooltipText: 'Annuler le message programmé', cssClasses: ['flat', 'circular'], valign: Gtk.Align.CENTER });
    cancel.connect('clicked', () => {
      store.client.cancelScheduled(s.id).then(
        () => toast('Message programmé annulé'),
        (error: unknown) => toast(`Annulation impossible : ${errorMessage(error)}`),
      );
    });
    line.append(cancel);
    return line;
  };
  const render = (): void => {
    for (let c = box.get_first_child(); c !== null; c = box.get_first_child()) box.remove(c);
    const list = store.scheduled.peek();
    box.visible = list.length > 0;
    for (const s of list) box.append(row(s));
  };
  render();
  onCleanup(store.scheduled.subscribe(render));
  return box;
}

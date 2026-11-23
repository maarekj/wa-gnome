// Barre du lecteur audio de l'application, sous les onglets : visible tant qu'un vocal est
// chargé, quelle que soit la discussion affichée.
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';
import { onCleanup } from 'gnim';
import type { Store } from '../shared/store.ts';
import { nextSpeed, speedLabel } from './AudioPlayer.ts';
import { fmtDuration } from './media.ts';
import { playback } from './Playback.ts';

/** `selectAccount` : vocal d'un autre compte, affiché avant d'aller au message. */
export function playbackBar(store: Store, selectAccount?: (account: string) => Store | null): Gtk.Widget {
  const bar = new Gtk.Box({ spacing: 8, cssClasses: ['playback-bar'], visible: false });
  const play = new Gtk.Button({ iconName: 'media-playback-pause-symbolic', tooltipText: 'Pause', valign: Gtk.Align.CENTER, cssClasses: ['circular', 'flat'] });
  play.connect('clicked', () => playback.toggle());
  // auteur et discussion : clic, retour au message
  const title = new Gtk.Label({ xalign: 0, ellipsize: Pango.EllipsizeMode.END, cssClasses: ['caption-heading'] });
  const where = new Gtk.Label({ xalign: 0, ellipsize: Pango.EllipsizeMode.END, cssClasses: ['caption', 'dim-label'] });
  const text = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, valign: Gtk.Align.CENTER });
  text.append(title);
  text.append(where);
  const goTo = new Gtk.Button({ child: text, hexpand: true, cssClasses: ['flat', 'playback-title'], tooltipText: 'Aller au message' });
  goTo.connect('clicked', () => {
    const t = playback.state.peek().track;
    if (t === null) return;
    const target = t.account === store.client.account ? store : (selectAccount?.(t.account) ?? null);
    target?.openAt(t.chatId, t.messageId, t.timestamp);
  });
  const scale = new Gtk.Scale({
    orientation: Gtk.Orientation.HORIZONTAL,
    drawValue: false,
    widthRequest: 160,
    adjustment: new Gtk.Adjustment({ lower: 0, upper: 1 }),
  });
  let syncing = false;
  scale.connect('value-changed', () => {
    if (!syncing) playback.seek(scale.get_value());
  });
  const time = new Gtk.Label({ widthChars: 11, xalign: 1, cssClasses: ['caption', 'dim-label', 'numeric'] });
  const speed = new Gtk.Button({ tooltipText: 'Vitesse de lecture', valign: Gtk.Align.CENTER, cssClasses: ['flat', 'pill', 'speed', 'caption-heading'] });
  speed.connect('clicked', () => playback.setSpeed(nextSpeed(playback.state.peek().speed)));
  const close = new Gtk.Button({
    iconName: 'window-close-symbolic',
    tooltipText: 'Arrêter la lecture',
    valign: Gtk.Align.CENTER,
    cssClasses: ['circular', 'flat'],
  });
  close.connect('clicked', () => playback.stop());
  for (const w of [play, goTo, scale, time, speed, close]) bar.append(w);

  const show = (): void => {
    const st = playback.state.peek();
    bar.visible = st.track !== null;
    if (st.track === null) return;
    play.iconName = st.playing ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
    play.tooltipText = st.playing ? 'Pause' : 'Lire';
    title.label = `Vocal de ${st.track.author}`;
    where.label = st.track.account === store.client.account ? st.track.chatName : `${st.track.chatName} · autre compte`;
    const duration = st.duration > 0 ? st.duration : st.track.seconds;
    syncing = true;
    scale.adjustment.upper = Math.max(1, duration);
    scale.set_value(st.position);
    syncing = false;
    time.label = `${fmtDuration(st.position)} / ${fmtDuration(duration)}`;
    speed.label = speedLabel(st.speed);
  };
  show();
  onCleanup(playback.state.subscribe(show));
  return bar;
}

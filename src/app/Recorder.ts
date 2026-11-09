// Enregistrement d'un message vocal (GStreamer) : micro → Opus dans un conteneur Ogg, comme les
// notes vocales de WhatsApp ; niveaux sonores relevés pour la forme d'onde et l'animation.
// Tests et captures (WA_GNOME_SILENT) : son de test à la place du micro.
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gst from 'gi://Gst?version=1.0';
import { waveform } from '../shared/api.ts';
import { errorMessage } from '../shared/errors.ts';

/** Durée maximale d'un vocal (s) : arrêt automatique. */
export const MAX_SECONDS = 15 * 60;

/** Vocal enregistré. */
export interface Recording {
  readonly bytes: GLib.Bytes;
  readonly seconds: number;
  /** 64 valeurs de 0 à 100 */
  readonly waveform: number[];
}

/** Durée affichée pendant l'enregistrement (`0:07`). */
export const fmtRecording = (seconds: number): string => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

export class Recorder {
  readonly #pipeline: Gst.Element;
  readonly #file: string;
  readonly #levels: number[] = [];
  #started = 0;
  #done: ((r: Recording | null) => void) | null = null;
  #cancelled = false;
  #watch = 0;
  /** niveau (dB) et durée (s) à chaque relevé, pour l'animation */
  onLevel: ((db: number, seconds: number) => void) | null = null;
  /** erreur (micro absent ou refusé) : enregistrement arrêté */
  onError: ((message: string) => void) | null = null;

  constructor() {
    Gst.init([]);
    const dir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'wa-gnome']);
    GLib.mkdir_with_parents(dir, 0o700);
    this.#file = GLib.build_filenamev([dir, `vocal-${Date.now()}.ogg`]);
    const source = GLib.getenv('WA_GNOME_SILENT') === null ? 'autoaudiosrc' : 'audiotestsrc is-live=true wave=sine freq=330 volume=0.4';
    this.#pipeline = Gst.parse_launch(
      `${source} ! audioconvert ! audioresample ! audio/x-raw,rate=48000,channels=1 ! level interval=100000000 post-messages=true ! opusenc bitrate=32000 ! oggmux ! filesink location="${this.#file}"`,
    );
    const bus = this.#pipeline.get_bus();
    if (bus === null) throw new Error('GStreamer : bus indisponible');
    bus.add_signal_watch();
    this.#watch = bus.connect('message', (_b: Gst.Bus, m: Gst.Message) => this.#message(m));
  }

  /** Secondes enregistrées. */
  get seconds(): number {
    return this.#started === 0 ? 0 : (GLib.get_monotonic_time() - this.#started) / 1_000_000;
  }

  start(): void {
    this.#started = GLib.get_monotonic_time();
    if (this.#pipeline.set_state(Gst.State.PLAYING) === Gst.StateChangeReturn.FAILURE) throw new Error('micro indisponible');
  }

  /** Fin de l'enregistrement : vocal prêt (null s'il est vide ou en erreur). */
  stop(): Promise<Recording | null> {
    return new Promise((resolve) => {
      this.#done = resolve;
      this.#pipeline.send_event(Gst.Event.new_eos());
    });
  }

  /** Abandon : rien n'est gardé. */
  cancel(): void {
    this.#cancelled = true;
    this.#finish(null);
  }

  #message(m: Gst.Message): void {
    if (m.type === Gst.MessageType.ELEMENT) {
      const s = m.get_structure();
      if (s?.get_name() !== 'level') return;
      const rms: unknown = s.get_value('rms');
      // niveau (dB) du canal unique : GValueArray, seule forme exposée par l'élément « level »
      // oxlint-disable-next-line typescript/no-deprecated -- type imposé par GStreamer
      const db = rms instanceof GObject.ValueArray ? Number(rms.get_nth(0)) : -100;
      this.#levels.push(Number.isFinite(db) ? db : -100);
      this.onLevel?.(db, this.seconds);
      if (this.seconds >= MAX_SECONDS) void this.#autoStop();
      return;
    }
    if (m.type === Gst.MessageType.EOS) {
      this.#finish(this.#read());
      return;
    }
    if (m.type === Gst.MessageType.ERROR) {
      const [error] = m.parse_error();
      this.onError?.(error?.message ?? 'erreur GStreamer');
      this.#finish(null);
    }
  }

  async #autoStop(): Promise<void> {
    if (this.#done !== null) return;
    await this.stop();
  }

  #read(): Recording | null {
    if (this.#cancelled) return null;
    try {
      const [ok, data] = GLib.file_get_contents(this.#file);
      if (!ok || data.length === 0) return null;
      return { bytes: new GLib.Bytes(data), seconds: Math.max(1, Math.round(this.seconds)), waveform: waveform(this.#levels) };
    } catch (error) {
      this.onError?.(errorMessage(error));
      return null;
    }
  }

  #finish(r: Recording | null): void {
    this.#pipeline.set_state(Gst.State.NULL);
    const bus = this.#pipeline.get_bus();
    if (bus !== null && this.#watch !== 0) {
      bus.disconnect(this.#watch);
      bus.remove_signal_watch();
      this.#watch = 0;
    }
    GLib.unlink(this.#file);
    const done = this.#done;
    this.#done = null;
    done?.(r);
  }
}

// Mesures de performance pour `pnpm bench` (WA_GNOME_PERF=1) : temps jusqu'à l'image affichée.
//   PERF liste <ms>       lancement → première image de la liste des discussions
//   PERF ouverture <ms>   ouverture de WA_GNOME_PERF_CHAT → première image de ses messages
// (WA_GNOME_PERF_RUNS passes), puis « PERF fin » et l'application se termine.
// Aucun effet sans la variable.
import GLib from 'gi://GLib';
import type Gtk from 'gi://Gtk?version=4.0';
import type { Store } from '../shared/store.ts';

export const PERF = GLib.getenv('WA_GNOME_PERF') === '1';
/** chargement du module : au plus tôt dans le processus (importé par main) */
const START = GLib.get_monotonic_time();

const elapsed = (from: number): number => Math.round((GLib.get_monotonic_time() - from) / 1000);

/** Une fois l'image suivante dessinée (début de la seconde image : la première est finie). */
function afterFrame(widget: Gtk.Widget, done: () => void): void {
  let frames = 0;
  widget.add_tick_callback(() => {
    frames += 1;
    if (frames < 2) return true;
    done();
    return false;
  });
}

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
      resolve();
      return GLib.SOURCE_REMOVE;
    });
  });

/** Attend que `ready()` soit vrai (vérifié à chaque changement de `on`). */
function until(on: { subscribe: (fn: () => void) => () => void }, ready: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    if (ready()) {
      resolve();
      return;
    }
    const off = on.subscribe(() => {
      if (!ready()) return;
      off();
      resolve();
    });
  });
}

/** Scénario de mesure : liste au lancement, puis ouvertures répétées de la discussion choisie. */
export async function runBench(store: Store, window: Gtk.Widget, quit: () => void): Promise<void> {
  await until(store.chats, () => store.chats.peek().length > 0);
  await new Promise<void>((resolve) => {
    afterFrame(window, resolve);
  });
  printerr(`PERF liste ${elapsed(START)}`);
  // laisse passer le second rechargement et les photos de la liste
  await wait(3000);
  const name = (GLib.getenv('WA_GNOME_PERF_CHAT') ?? '').toLowerCase();
  const chat = store.chats.peek().find((c) => c.name.toLowerCase().includes(name));
  if (chat === undefined) printerr(`PERF erreur discussion introuvable : ${name}`);
  else {
    // 0 : liste seule (lancements de `pnpm bench` hors du dernier)
    const raw = Number(GLib.getenv('WA_GNOME_PERF_RUNS') ?? '5');
    const runs = Number.isInteger(raw) && raw >= 0 && GLib.getenv('WA_GNOME_PERF_RUNS') !== '' ? raw : 5;
    /** une ouverture mesurée (discussion fermée, puis rouverte) */
    const measure = async (): Promise<void> => {
      store.open(null);
      await wait(800);
      const t0 = GLib.get_monotonic_time();
      store.open(chat.id);
      await until(store.messages, () => store.messages.peek().length > 0);
      await new Promise<void>((resolve) => {
        afterFrame(window, resolve);
      });
      printerr(`PERF ouverture ${elapsed(t0)}`);
      await wait(1500);
    };
    for (let i = 0; i < runs; i += 1) {
      // oxlint-disable-next-line no-await-in-loop -- passes successives, jamais simultanées
      await measure();
    }
  }
  printerr('PERF fin');
  quit();
}

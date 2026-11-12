// Mesures de performance pour `pnpm bench` (WA_GNOME_PERF=1) : temps jusqu'à l'image affichée.
//   PERF liste <ms>       lancement → première image de la liste des discussions
//   PERF ouverture <ms>   ouverture de WA_GNOME_PERF_CHAT → première image de ses messages
//   PERF complète <ms>    … → image où tous ses messages chargés sont affichés (affichage progressif)
//   PERF bloquée <ms>     plus longue image pendant l'ouverture (jusqu'à « complète ») : au-delà de
//                         ~50 ms, l'app ne répond plus (défilement, frappe) le temps de cette image
//   PERF décalées <n>     images dessinées pendant cette ouverture avec la conversation pas en bas
//                         alors qu'elle devrait l'être (sauts visibles : doit rester à 0)
// (WA_GNOME_PERF_RUNS passes), puis « PERF fin » et l'application se termine.
// Aucun effet sans la variable.
import GLib from 'gi://GLib';
import type Gtk from 'gi://Gtk?version=4.0';
import type { Store } from '../shared/store.ts';

export const PERF = GLib.getenv('WA_GNOME_PERF') === '1';
/** chargement du module : au plus tôt dans le processus (importé par main) */
const START = GLib.get_monotonic_time();

const elapsed = (from: number): number => Math.round((GLib.get_monotonic_time() - from) / 1000);

/** Fin du dessin de la prochaine image de la fenêtre de `widget`. */
function afterFrame(widget: Gtk.Widget, done: () => void): void {
  const clock = widget.get_frame_clock();
  if (clock === null) {
    done();
    return;
  }
  const id = clock.connect('after-paint', () => {
    clock.disconnect(id);
    done();
  });
  widget.queue_draw();
}

const counts = new Map<string, number>();

/** Évènement compté (sans effet hors mesure) : ex. « décalée », image dessinée hors du bas. */
export function perfCount(name: string): void {
  if (PERF) counts.set(name, (counts.get(name) ?? 0) + 1);
}

/** Repères posés par l'app (voir `perfMark`), attendus par le scénario. */
const marks = new Map<string, () => void>();

/** Repère atteint (sans effet hors mesure) : ex. « complète », tous les messages affichés. */
export function perfMark(name: string): void {
  if (!PERF) return;
  marks.get(name)?.();
  marks.delete(name);
}

const mark = (name: string): Promise<void> =>
  new Promise((resolve) => {
    marks.set(name, resolve);
  });

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
      const complete = mark('complète');
      counts.clear();
      // plus long intervalle entre deux images (travail bloquant le fil principal)
      const clock = window.get_frame_clock();
      let lastFrame = GLib.get_monotonic_time();
      let longest = 0;
      const frameId = clock?.connect('after-paint', () => {
        const now = GLib.get_monotonic_time();
        longest = Math.max(longest, now - lastFrame);
        lastFrame = now;
      });
      // une image par tour tant que la mesure dure (sinon l'intervalle serait l'inactivité)
      const ticking = window.add_tick_callback(() => GLib.SOURCE_CONTINUE);
      store.open(chat.id);
      await until(store.messages, () => store.messages.peek().length > 0);
      await new Promise<void>((resolve) => {
        afterFrame(window, resolve);
      });
      printerr(`PERF ouverture ${elapsed(t0)}`);
      await complete;
      await new Promise<void>((resolve) => {
        afterFrame(window, resolve);
      });
      printerr(`PERF complète ${elapsed(t0)}`);
      window.remove_tick_callback(ticking);
      if (frameId !== undefined) clock?.disconnect(frameId);
      printerr(`PERF bloquée ${Math.round(longest / 1000)}`);
      // quelques images de plus (photos, fin du placement)
      await wait(1000);
      printerr(`PERF décalées ${counts.get('décalée') ?? 0}`);
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

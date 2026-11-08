// Sélection de messages en glissant (comme Telegram Desktop) : appui sur un message puis
// glissement ; dès que le pointeur passe sur un autre message, tous ceux entre le message de
// départ et celui sous le pointeur sont sélectionnés (revenir en arrière désélectionne).
// Tant que le pointeur reste dans le message de départ, rien n'est capté (sélection de texte).
import GLib from 'gi://GLib';
import Graphene from 'gi://Graphene';
import Gdk from 'gi://Gdk?version=4.0';
import Gtk from 'gi://Gtk?version=4.0';

/** Préfixe du nom des lignes de message dans la conversation (`m:<id>`). */
const PREFIX = 'm:';
/** Zone (px) près du haut / bas de la conversation qui la fait défiler pendant le glissement. */
const EDGE = 48;

/** Sélection : la sélection de départ, plus les messages de `from` à `to` (indices, dans un sens ou l'autre). */
export function rangeSelection(ids: readonly string[], base: ReadonlySet<string>, from: number, to: number): Set<string> {
  const out = new Set(base);
  const [a, b] = from <= to ? [from, to] : [to, from];
  for (let i = Math.max(0, a); i <= Math.min(b, ids.length - 1); i++) {
    const id = ids[i];
    if (id !== undefined) out.add(id);
  }
  return out;
}

/** Lignes de message de la conversation, dans l'ordre, avec leurs bornes verticales. */
function rows(box: Gtk.Widget): { id: string; top: number; bottom: number }[] {
  const out: { id: string; top: number; bottom: number }[] = [];
  for (let c = box.get_first_child(); c !== null; c = c.get_next_sibling()) {
    if (!c.name.startsWith(PREFIX) || !c.get_visible()) continue;
    const [ok, b] = c.compute_bounds(box);
    if (ok) out.push({ id: c.name.slice(PREFIX.length), top: b.get_y(), bottom: b.get_y() + b.get_height() });
  }
  return out;
}

/** Indice de la ligne sous `y` (entre deux lignes : la plus proche au-dessus), -1 au-dessus de la première. */
export function rowAt(list: readonly { top: number; bottom: number }[], y: number): number {
  let found = -1;
  for (const [i, r] of list.entries()) {
    if (r.top <= y) found = i;
    else break;
  }
  return found;
}

/** Libellés sélectionnables d'un widget : sélection de texte commencée par le glissement, retirée. */
function clearTextSelection(w: Gtk.Widget): void {
  if (w instanceof Gtk.Label && w.selectable) w.select_region(0, 0);
  for (let c = w.get_first_child(); c !== null; c = c.get_next_sibling()) clearTextSelection(c);
}

/** Position d'un événement dans les coordonnées de `widget`, ou null. */
function positionIn(widget: Gtk.Widget, event: Gdk.Event): { x: number; y: number } | null {
  const [ok, sx, sy] = event.get_position();
  const native = widget.get_native();
  if (!ok || native === null) return null;
  const [nx, ny] = native.get_surface_transform();
  const [done, p] = native.compute_point(widget, new Graphene.Point({ x: sx - nx, y: sy - ny }));
  return done ? { x: p.x, y: p.y } : null;
}

/**
 * Sélection en glissant sur la boîte des messages `box`, placée dans `scroller`.
 * `selection` lit la sélection, `select` la remplace. Événements bruts en phase de capture : un
 * libellé sélectionnable qui prend le geste (sélection de texte) n'empêche pas de les voir.
 */
export function attachDragSelect(box: Gtk.Widget, scroller: () => Gtk.ScrolledWindow | null, selection: () => ReadonlySet<string>, select: (ids: Set<string>) => void): void {
  const legacy = new Gtk.EventControllerLegacy({ propagationPhase: Gtk.PropagationPhase.CAPTURE });
  let pressed = false;
  let startY = 0;
  let startScroll = 0;
  let lastY = 0;
  let startIndex = -1;
  let startRow: Gtk.Widget | null = null;
  let base: ReadonlySet<string> = new Set();
  let active = false;
  let timer = 0;
  const stopTimer = (): void => {
    if (timer !== 0) GLib.source_remove(timer);
    timer = 0;
  };
  const scrollValue = (): number => scroller()?.vadjustment.value ?? 0;
  /** position du pointeur dans la boîte (le contenu a pu défiler depuis le dernier mouvement) */
  let lastScroll = 0;
  const pointerY = (): number => lastY + (scrollValue() - lastScroll);
  const update = (): void => {
    const list = rows(box);
    const i = rowAt(list, pointerY());
    if (i < 0 || startIndex < 0) return;
    if (!active) {
      // encore dans le message de départ : sélection de texte possible
      if (i === startIndex) return;
      active = true;
      if (startRow !== null) clearTextSelection(startRow);
      // défilement automatique près des bords
      timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 40, () => {
        const sw = scroller();
        if (sw === null) return GLib.SOURCE_CONTINUE;
        const [ok, p] = box.compute_point(sw, new Graphene.Point({ x: 0, y: pointerY() }));
        if (!ok) return GLib.SOURCE_CONTINUE;
        const h = sw.get_height();
        const adj = sw.vadjustment;
        const step = p.y < EDGE ? -Math.ceil((EDGE - p.y) / 3) : p.y > h - EDGE ? Math.ceil((p.y - (h - EDGE)) / 3) : 0;
        if (step !== 0) {
          adj.value = Math.max(0, Math.min(adj.upper - adj.pageSize, adj.value + step));
          update();
        }
        return GLib.SOURCE_CONTINUE;
      });
    }
    select(rangeSelection(list.map((r) => r.id), base, startIndex, i));
  };
  const end = (): void => {
    stopTimer();
    const row = active ? startRow : null;
    pressed = false;
    active = false;
    startIndex = -1;
    startRow = null;
    // sélection de texte du message de départ : retirée après le relâchement (libellé)
    if (row !== null) {
      GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        clearTextSelection(row);
        return GLib.SOURCE_REMOVE;
      });
    }
  };
  legacy.connect('event', (_c: Gtk.EventControllerLegacy, event: Gdk.Event): boolean => {
    // oxlint-disable-next-line typescript/switch-exhaustiveness-check -- seuls les boutons et mouvements comptent
    switch (event.get_event_type()) {
      case Gdk.EventType.BUTTON_PRESS: {
        if (!(event instanceof Gdk.ButtonEvent) || event.get_button() !== Gdk.BUTTON_PRIMARY) return false;
        const p = positionIn(box, event);
        if (p === null) return false;
        stopTimer();
        pressed = true;
        active = false;
        startY = p.y;
        lastY = p.y;
        startScroll = scrollValue();
        lastScroll = startScroll;
        base = new Set(selection());
        const list = rows(box);
        startIndex = rowAt(list, p.y);
        startRow = null;
        const id = list[startIndex]?.id;
        if (id !== undefined) for (let c = box.get_first_child(); c !== null; c = c.get_next_sibling()) if (c.name === `${PREFIX}${id}`) startRow = c;
        return false;
      }
      case Gdk.EventType.MOTION_NOTIFY: {
        if (!pressed) return false;
        const p = positionIn(box, event);
        if (p === null) return false;
        lastY = p.y;
        lastScroll = scrollValue();
        // petit mouvement : pas encore un glissement
        if (!active && Math.abs(p.y - startY) < 4) return false;
        update();
        // en mode sélection : le libellé de départ n'étend plus sa sélection de texte
        return active;
      }
      case Gdk.EventType.BUTTON_RELEASE:
        if (pressed) end();
        return false;
      default:
        // autres événements (clavier, molette…) : laissés passer
        return false;
    }
  });
  box.add_controller(legacy);
}

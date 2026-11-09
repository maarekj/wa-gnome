// Fond des conversations : motif de petits pictogrammes au trait (dessiné ici, en mosaïque),
// couleur unie, image de l'utilisateur, ou rien. Appliqué par une feuille de style globale.
import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import { errorMessage } from '../shared/errors.ts';

/** Côté de la tuile du motif (px). */
const TILE = 520;

/** Pictogrammes au trait, dans une boîte de 24×24 (chemins SVG). */
const DOODLES: readonly string[] = [
  // cœur
  'M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z',
  // étoile
  'M12 3l2.6 5.6 6 .7-4.5 4.1 1.2 6L12 16.4 6.7 19.4l1.2-6L3.4 9.3l6-.7z',
  // bulle de discussion
  'M4 5h16v10H9l-5 4z M8 9h8 M8 12h5',
  // lune
  'M15 4a8 8 0 1 0 5 13A7 7 0 0 1 15 4z',
  // note de musique
  'M9 18V6l10-2v12 M9 18a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z M19 16a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z',
  // appareil photo
  'M4 8h4l2-2h4l2 2h4v10H4z M12 16a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  // nuage
  'M7 18h10a4 4 0 0 0 0-8 6 6 0 0 0-11.5 1.5A3.3 3.3 0 0 0 7 18z',
  // éclair
  'M13 3L5 14h6l-1 7 8-11h-6z',
  // visage souriant
  'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M8.5 14a4 4 0 0 0 7 0 M9 9.5h.01 M15 9.5h.01',
  // étincelle
  'M12 3v6 M12 15v6 M3 12h6 M15 12h6',
  // cadeau
  'M4 10h16v10H4z M3 7h18v3H3z M12 7v13 M12 7c-2-4-6-3-4 0 M12 7c2-4 6-3 4 0',
  // tasse
  'M5 9h11v6a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4z M16 11h2a2 2 0 0 1 0 4h-2',
  // ballon
  'M12 15c-3 0-5-3-5-6a5 5 0 0 1 10 0c0 3-2 6-5 6z M12 15l-1 2h2z M12 17c0 2-2 2-2 4',
  // feuille
  'M5 19C5 10 11 5 19 5c0 8-5 14-14 14z M5 19l8-8',
  // avion en papier
  'M3 11l18-7-6 17-3-7z M12 14l9-10',
  // cadenas
  'M6 11h12v9H6z M8.5 11V8a3.5 3.5 0 0 1 7 0v3',
  // soleil
  'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M12 2v3 M12 19v3 M2 12h3 M19 12h3 M5 5l2 2 M17 17l2 2 M5 19l2-2 M17 7l2-2',
  // fleur
  'M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4z M12 10c-1-4 3-4 2-1 M14 12c4-1 4 3 1 2 M12 14c1 4-3 4-2 1 M10 12c-4 1-4-3-1-2 M12 16v6',
  // pizza
  'M4 6c5-3 11-3 16 0L12 21z M9 9h.01 M14 10h.01 M12 14h.01',
  // glace
  'M8 10a4 4 0 0 1 8 0z M8 10l4 11 4-11',
  // sapin
  'M12 3l5 7h-3l4 6H6l4-6H7z M12 16v4',
  // maison
  'M4 11l8-7 8 7 M6 9v11h12V9 M10 20v-6h4v6',
  // clé
  'M8 16a4 4 0 1 1 3.5-6H21v3h-2v2h-3v-2h-4.5A4 4 0 0 1 8 16z',
  // horloge
  'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 7v5l3 2',
  // ampoule
  'M9 18h6 M10 21h4 M12 3a6 6 0 0 0-3.5 10.9c.5.4.5 1 .5 2.1h6c0-1.1 0-1.7.5-2.1A6 6 0 0 0 12 3z',
  // poisson
  'M3 12c4-6 11-6 15 0-4 6-11 6-15 0z M18 12l3-3v6z M8 11h.01',
  // chat (animal)
  'M5 20v-9l2-6 3 4h4l3-4 2 6v9z M9.5 13h.01 M14.5 13h.01 M11 16h2',
  // ancre
  'M12 6a2 2 0 1 0 0-4 2 2 0 0 0 0 4z M12 6v15 M8 10h8 M4 14a8 8 0 0 0 16 0',
  // téléphone
  'M8 3h8v18H8z M11 18h2',
  // casque audio
  'M4 15v-3a8 8 0 0 1 16 0v3 M4 15h3v5H4z M17 15h3v5h-3z',
  // goutte
  'M12 3c4 5 6 8 6 11a6 6 0 0 1-12 0c0-3 2-6 6-11z',
  // diamant
  'M6 4h12l3 5-9 11L3 9z M3 9h18 M9 4l3 16 3-16',
  // montagne
  'M2 20l7-12 4 6 3-4 6 10z',
  // livre
  'M4 5c3-1 6-1 8 1v14c-2-2-5-2-8-1z M20 5c-3-1-6-1-8 1v14c2-2 5-2 8-1z',
  // pouce levé
  'M7 11v9H4v-9z M7 11l4-7c2 0 2 2 1.5 4H19a2 2 0 0 1 2 2l-1.5 8a2 2 0 0 1-2 2H7',
  // fusée
  'M12 3c4 3 5 8 3 13H9C7 11 8 6 12 3z M9 16l-3 4 4-1 M15 16l3 4-4-1 M12 9h.01',
  // trombone
  'M8 12l6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l7-7',
  // lunettes
  'M3 13a3 3 0 1 0 6 0 3 3 0 0 0-6 0z M15 13a3 3 0 1 0 6 0 3 3 0 0 0-6 0z M9 13h6 M3 13l2-6 M21 13l-2-6',
];

/** Générateur pseudo-aléatoire reproductible (même motif à chaque lancement). */
function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1_664_525) + 1_013_904_223) >>> 0;
    return s / 2 ** 32;
  };
}

/** Tailles des pictogrammes (px) : quelques grands, des moyens, beaucoup de petits. */
const SIZES = [
  { min: 58, max: 76, tries: 16 },
  { min: 34, max: 46, tries: 90 },
  { min: 18, max: 26, tries: 400 },
] as const;
/** Espace minimal entre deux éléments (px). */
const GAP = 3;

/**
 * Tuile du motif (SVG), traits de la couleur donnée, sur fond transparent : pictogrammes de tailles
 * variées, inclinés, posés librement sans se chevaucher (raccord invisible entre les tuiles), puis
 * petits cercles et étincelles dans les vides.
 */
export function patternSvg(stroke: string): string {
  const rnd = random(11);
  const placed: { x: number; y: number; r: number }[] = [];
  /** distance sur la tuile repliée sur elle-même (le motif se répète sans couture) */
  const dist = (ax: number, ay: number, bx: number, by: number): number => {
    const dx = Math.min(Math.abs(ax - bx), TILE - Math.abs(ax - bx));
    const dy = Math.min(Math.abs(ay - by), TILE - Math.abs(ay - by));
    return Math.hypot(dx, dy);
  };
  const free = (x: number, y: number, r: number): boolean => placed.every((p) => dist(x, y, p.x, p.y) >= p.r + r + GAP);
  const items: string[] = [];
  /** élément dessiné aussi de l'autre côté quand il déborde (raccord des tuiles) */
  const draw = (x: number, y: number, r: number, svg: (cx: number, cy: number) => string): void => {
    for (const ox of [-TILE, 0, TILE]) {
      for (const oy of [-TILE, 0, TILE]) {
        const cx = x + ox;
        const cy = y + oy;
        if (cx + r < 0 || cx - r > TILE || cy + r < 0 || cy - r > TILE) continue;
        items.push(svg(cx, cy));
      }
    }
  };
  const bag: string[] = [];
  for (const tier of SIZES) {
    for (let t = 0; t < tier.tries; t++) {
      const size = tier.min + rnd() * (tier.max - tier.min);
      const r = size * 0.48;
      // plusieurs essais de position pour chaque pictogramme
      for (let k = 0; k < 40; k++) {
        const x = rnd() * TILE;
        const y = rnd() * TILE;
        if (!free(x, y, r)) continue;
        placed.push({ x, y, r });
        if (bag.length === 0) bag.push(...DOODLES);
        const path = bag.splice(Math.floor(rnd() * bag.length), 1)[0] ?? '';
        const angle = Math.round((rnd() - 0.5) * 60);
        const scale = size / 24;
        // trait de 1 px quelle que soit la taille
        draw(x, y, r, (cx, cy) => `<path stroke-width="${(1 / scale).toFixed(3)}" transform="translate(${(cx - size / 2).toFixed(1)} ${(cy - size / 2).toFixed(1)}) scale(${scale.toFixed(3)}) rotate(${angle} 12 12)" d="${path}"/>`);
        break;
      }
    }
  }
  // remplissage : petits cercles, points et étincelles dans les vides
  for (let t = 0; t < 4000; t++) {
    const x = rnd() * TILE;
    const y = rnd() * TILE;
    const kind = rnd();
    const r = kind < 0.5 ? 1.5 : kind < 0.85 ? 3 : 4.5;
    if (!free(x, y, r)) continue;
    placed.push({ x, y, r });
    draw(x, y, r, (cx, cy) =>
      r === 4.5
        ? `<path d="M${cx.toFixed(1)} ${(cy - 4.5).toFixed(1)}v9 M${(cx - 4.5).toFixed(1)} ${cy.toFixed(1)}h9"/>`
        : `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r}"/>`,
    );
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${TILE}" height="${TILE}" viewBox="0 0 ${TILE} ${TILE}"><g fill="none" stroke="${stroke}" stroke-width="1" stroke-linecap="round" stroke-linejoin="round">${items.join('')}</g></svg>`;
}

/** Couleurs unies proposées (clair / sombre). */
export const WALLPAPER_COLORS = [
  { id: 'sable', name: 'Sable', light: '#efe7dc', dark: '#2a2622' },
  { id: 'menthe', name: 'Menthe', light: '#dcefe4', dark: '#1f2b25' },
  { id: 'ciel', name: 'Ciel', light: '#dde9f5', dark: '#1e2733' },
  { id: 'lavande', name: 'Lavande', light: '#e8e1f3', dark: '#29243a' },
  { id: 'rose', name: 'Rose', light: '#f5e0e4', dark: '#33232a' },
  { id: 'gris', name: 'Gris', light: '#e6e6e6', dark: '#262626' },
] as const;

/** Fond choisi : motif (défaut), aucun, couleur unie (`color:<id>`) ou image de l'utilisateur. */
export type Wallpaper = 'pattern' | 'none' | 'image' | `color:${(typeof WALLPAPER_COLORS)[number]['id']}`;
export const WALLPAPER_DEFAULT: Wallpaper = 'pattern';
export const isWallpaper = (w: string | undefined): w is Wallpaper => w === 'pattern' || w === 'none' || w === 'image' || WALLPAPER_COLORS.some((c) => `color:${c.id}` === w);

/** Fichier du motif (écrit une fois dans le cache), pour la feuille de style. */
function patternFile(theme: 'light' | 'dark'): string {
  const dir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'wa-gnome']);
  const file = GLib.build_filenamev([dir, `motif-${theme}-v6.svg`]);
  if (!GLib.file_test(file, GLib.FileTest.EXISTS)) {
    GLib.mkdir_with_parents(dir, 0o700);
    GLib.file_set_contents(file, patternSvg(theme === 'light' ? '#e4ddd3' : '#2f2c29'));
  }
  return file;
}

const url = (file: string): string => `url("${GLib.filename_to_uri(file, null).replaceAll('"', '%22')}")`;

/** Bulles opaques sur un fond (sinon le motif se voit à travers) ; plus claires que le fond en sombre. */
function opaque(dark: boolean): string {
  const base = dark ? 'color-mix(in srgb, white 9%, var(--view-bg-color))' : 'var(--view-bg-color)';
  return `
.wallpaper .bubble.incoming { background: ${base}; box-shadow: 0 1px 1px alpha(black, 0.08); }
.wallpaper .bubble.outgoing { background: color-mix(in srgb, var(--accent-bg-color) ${dark ? 35 : 22}%, ${base}); box-shadow: 0 1px 1px alpha(black, 0.08); }
.wallpaper .day-separator, .wallpaper .composer-entry, .wallpaper .sticker > label.caption { background: ${base}; }
.wallpaper .bubble.emoji-only { background: none; box-shadow: none; }`;
}

/** Couleur de fond du motif par défaut (clair / sombre). */
const PATTERN_BG = { light: '#f2eee8', dark: '#121110' } as const;

/**
 * Barres latérales (liste des discussions, panneau de recherche) teintées comme le fond, un peu
 * plus foncées en clair, un peu plus claires en sombre (pour rester distinctes).
 */
export function sidebarCss(base: string, dark: boolean): string {
  const tint = dark ? `color-mix(in srgb, ${base} 95%, white)` : `color-mix(in srgb, ${base} 97%, black)`;
  return `:root { --sidebar-bg-color: ${tint}; --secondary-sidebar-bg-color: ${tint}; --sidebar-shade-color: alpha(black, ${dark ? 0.25 : 0.06}); }`;
}

/** Feuille de style du fond choisi (thème clair ou sombre) ; `image` : fichier de l'image de l'utilisateur. */
export function wallpaperCss(w: Wallpaper, image: string | null, pattern: string | null, dark = false): string {
  if (w === 'none') return '';
  if (w === 'image' && image !== null) return `.wallpaper { background: ${url(image)} center / cover no-repeat; }${opaque(dark)}`;
  const color = WALLPAPER_COLORS.find((c) => `color:${c.id}` === w);
  if (color !== undefined) {
    const base = dark ? color.dark : color.light;
    return `.wallpaper { background-color: ${base}; }${opaque(dark)}\n${sidebarCss(base, dark)}`;
  }
  if (pattern === null) return '';
  const base = dark ? PATTERN_BG.dark : PATTERN_BG.light;
  return `.wallpaper { background: ${base} ${url(pattern)} repeat; background-size: ${TILE}px ${TILE}px; }${opaque(dark)}\n${sidebarCss(base, dark)}`;
}

let provider: Gtk.CssProvider | null = null;
let chosen: { w: Wallpaper; image: string | null } = { w: WALLPAPER_DEFAULT, image: null };

function load(): void {
  if (provider === null) return;
  const dark = Adw.StyleManager.get_default().dark;
  let pattern: string | null = null;
  try {
    if (chosen.w === 'pattern') pattern = patternFile(dark ? 'dark' : 'light');
  } catch (error) {
    console.error(`fond : ${errorMessage(error)}`);
  }
  provider.load_from_string(wallpaperCss(chosen.w, chosen.image, pattern, dark));
}

/** Applique le fond à toutes les conversations (au démarrage, à chaque changement et de thème). */
export function applyWallpaper(w: Wallpaper, image: string | null): void {
  const display = Gdk.Display.get_default();
  if (display === null) return;
  chosen = { w, image };
  if (provider === null) {
    provider = new Gtk.CssProvider();
    // oxlint-disable-next-line typescript/no-deprecated -- seule API exposée par GJS pour un style global
    Gtk.StyleContext.add_provider_for_display(display, provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION + 1);
    // thème clair / sombre changé : fond adapté
    Adw.StyleManager.get_default().connect('notify::dark', load);
  }
  load();
}

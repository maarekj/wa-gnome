// Préférences de l'application (fichier `settings.json` du dossier de données) et leur fenêtre.
import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import * as z from 'zod/mini';
import { dataDir } from '../shared/client.ts';
import { errorMessage } from '../shared/errors.ts';

/** Couleur d'accent : celle du système, le vert de WhatsApp, ou une couleur d'accent de GNOME. */
export const ACCENTS = [
  { id: 'system', name: 'Système', color: null },
  { id: 'whatsapp', name: 'WhatsApp', color: '#00a884' },
  { id: 'blue', name: 'Bleu', color: Adw.AccentColor.BLUE },
  { id: 'teal', name: 'Sarcelle', color: Adw.AccentColor.TEAL },
  { id: 'green', name: 'Vert', color: Adw.AccentColor.GREEN },
  { id: 'yellow', name: 'Jaune', color: Adw.AccentColor.YELLOW },
  { id: 'orange', name: 'Orange', color: Adw.AccentColor.ORANGE },
  { id: 'red', name: 'Rouge', color: Adw.AccentColor.RED },
  { id: 'pink', name: 'Rose', color: Adw.AccentColor.PINK },
  { id: 'purple', name: 'Violet', color: Adw.AccentColor.PURPLE },
  { id: 'slate', name: 'Ardoise', color: Adw.AccentColor.SLATE },
] as const;
export type AccentId = (typeof ACCENTS)[number]['id'];

/** Fichier tel qu'écrit (champs inconnus ou invalides : valeurs par défaut). */
const SettingsFile = z.object({ accent: z.optional(z.string()), notify: z.optional(z.boolean()), preview: z.optional(z.boolean()) });
export interface Settings {
  readonly accent: AccentId;
  /** notifications des messages reçus */
  readonly notify: boolean;
  /** auteur et texte dans la notification (sinon « Nouveau message ») */
  readonly preview: boolean;
}
const DEFAULTS: Settings = { accent: 'system', notify: true, preview: true };
const asAccent = (id: string | undefined): AccentId => ACCENTS.find((a) => a.id === id)?.id ?? 'system';

/** Réglages lus (valeurs par défaut si absents ou invalides). */
export function parseSettings(text: string | null): Settings {
  if (text === null) return DEFAULTS;
  try {
    const raw = SettingsFile.safeParse(JSON.parse(text)).data;
    return raw === undefined ? DEFAULTS : { accent: asAccent(raw.accent), notify: raw.notify ?? DEFAULTS.notify, preview: raw.preview ?? DEFAULTS.preview };
  } catch {
    return DEFAULTS;
  }
}

const file = (): string => GLib.build_filenamev([dataDir(), 'settings.json']);

export function loadSettings(): Settings {
  try {
    const [ok, bytes] = GLib.file_get_contents(file());
    return parseSettings(ok ? new TextDecoder().decode(bytes) : null);
  } catch {
    return DEFAULTS;
  }
}

function saveSettings(s: Settings): void {
  try {
    GLib.mkdir_with_parents(dataDir(), 0o700);
    GLib.file_set_contents(file(), JSON.stringify(s, null, 2));
  } catch (error) {
    console.error(`préférences : ${errorMessage(error)}`);
  }
}

/** Couleur (CSS) d'un accent, null pour celle du système. */
export function accentColor(id: AccentId): string | null {
  const a = ACCENTS.find((x) => x.id === id);
  if (a === undefined || a.color === null) return null;
  return typeof a.color === 'string' ? a.color : Adw.accent_color_to_rgba(a.color).to_string();
}

/** CSS de l'accent choisi (vide : celui du système). `--accent-color` en découle (libadwaita). */
export function accentCss(id: AccentId): string {
  const c = accentColor(id);
  return c === null ? '' : `:root { --accent-bg-color: ${c}; }`;
}

let provider: Gtk.CssProvider | null = null;
let current: Settings = DEFAULTS;

/** Applique l'accent à toute l'application (au démarrage puis à chaque changement). */
function applyAccent(id: AccentId): void {
  const display = Gdk.Display.get_default();
  if (display === null) return;
  if (provider === null) {
    provider = new Gtk.CssProvider();
    // oxlint-disable-next-line typescript/no-deprecated -- seule API exposée par GJS pour un style global
    Gtk.StyleContext.add_provider_for_display(display, provider, Gtk.STYLE_PROVIDER_PRIORITY_USER);
  }
  provider.load_from_string(accentCss(id));
}

/** Accent choisi : appliqué et enregistré. */
function chooseAccent(id: AccentId): void {
  current = { ...current, accent: id };
  applyAccent(id);
  saveSettings(current);
}

/** Réglages en cours. */
export const settings = (): Settings => current;

/** Réglage modifié et enregistré. */
function update(patch: Partial<Settings>): void {
  current = { ...current, ...patch };
  saveSettings(current);
}

/** Interrupteur d'une ligne de préférences. */
function switchRow(title: string, subtitle: string, active: boolean, changed: (on: boolean) => void): Adw.SwitchRow {
  const row = new Adw.SwitchRow({ title, subtitle, active });
  row.connect('notify::active', () => changed(row.active));
  return row;
}

/** Réglages lus et appliqués (au démarrage de l'application). */
export function initSettings(): void {
  current = loadSettings();
  applyAccent(current.accent);
}

/** Pastille de couleur (bouton à cocher rond). */
function swatch(a: (typeof ACCENTS)[number], group: Gtk.ToggleButton | null): Gtk.ToggleButton {
  const color = accentColor(a.id);
  const b = new Gtk.ToggleButton({ tooltipText: a.name, cssClasses: ['accent-swatch', ...(color === null ? ['system'] : [])], widthRequest: 34, heightRequest: 34, valign: Gtk.Align.CENTER });
  if (group !== null) b.set_group(group);
  if (color !== null) {
    const css = new Gtk.CssProvider();
    css.load_from_string(`button { background: ${color}; }`);
    // oxlint-disable-next-line typescript/no-deprecated -- style propre à ce bouton
    b.get_style_context().add_provider(css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
  }
  b.set_child(new Gtk.Image({ iconName: 'object-select-symbolic', cssClasses: ['check'] }));
  return b;
}

/** Fenêtre des préférences. */
export function openPreferences(parent: Gtk.Widget): void {
  const page = new Adw.PreferencesPage({ title: 'Général', iconName: 'preferences-system-symbolic' });
  const appearance = new Adw.PreferencesGroup({ title: 'Apparence', description: 'Couleur d’accent de l’application (boutons, sélection, liens)' });
  const row = new Adw.ActionRow({ title: 'Couleur d’accent' });
  const label = new Gtk.Label({ cssClasses: ['dim-label'] });
  const box = new Gtk.FlowBox({ selectionMode: Gtk.SelectionMode.NONE, maxChildrenPerLine: 11, minChildrenPerLine: 6, columnSpacing: 6, rowSpacing: 6, marginTop: 10, marginBottom: 10, marginStart: 12, marginEnd: 12, homogeneous: true });
  let first: Gtk.ToggleButton | null = null;
  for (const a of ACCENTS) {
    const b = swatch(a, first);
    first ??= b;
    b.active = current.accent === a.id;
    b.connect('toggled', () => {
      if (!b.active) return;
      label.label = a.name;
      chooseAccent(a.id);
    });
    box.append(b);
  }
  label.label = ACCENTS.find((a) => a.id === current.accent)?.name ?? '';
  row.add_suffix(label);
  appearance.add(row);
  appearance.add(new Adw.PreferencesRow({ child: box, activatable: false }));
  page.add(appearance);
  const notifications = new Adw.PreferencesGroup({ title: 'Notifications', description: 'Le son et l’affichage sur l’écran verrouillé se règlent dans Paramètres › Notifications' });
  const preview = switchRow('Afficher le contenu', 'Auteur et texte du message dans la notification', current.preview, (on) => update({ preview: on }));
  preview.sensitive = current.notify;
  notifications.add(
    switchRow('Notifications des messages', 'Pour les discussions hors mode silencieux', current.notify, (on) => {
      update({ notify: on });
      preview.sensitive = on;
    }),
  );
  notifications.add(preview);
  page.add(notifications);
  const dialog = new Adw.PreferencesDialog({ title: 'Préférences' });
  dialog.add(page);
  dialog.present(parent);
}

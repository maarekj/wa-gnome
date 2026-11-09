// Préférences de l'application (fichier `settings.json` du dossier de données) et leur fenêtre.
import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import * as z from 'zod/mini';
import { DEFAULT_ACCOUNT } from '../shared/api.ts';
import { dataDir } from '../shared/client.ts';
import { errorMessage } from '../shared/errors.ts';
import { cancelWhisper, DownloadCancelled, deleteWhisper, downloads, downloadWhisper, hasWhisper, models, whisperDir } from './Whisper.ts';
import { applyWallpaper, isWallpaper, WALLPAPER_COLORS, WALLPAPER_DEFAULT, type Wallpaper } from './Wallpaper.ts';

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
const SettingsFile = z.object({
  accent: z.optional(z.string()),
  notify: z.optional(z.boolean()),
  preview: z.optional(z.boolean()),
  wallpaper: z.optional(z.string()),
  translator: z.optional(z.string()),
  opencodeModel: z.optional(z.string()),
  translateTo: z.optional(z.string()),
  whisperModel: z.optional(z.string()),
  voiceLanguages: z.optional(z.array(z.string())),
  chatVoiceLanguages: z.optional(z.record(z.string(), z.string())),
  account: z.optional(z.string()),
  rejectMessage: z.optional(z.string()),
});

/** Outil de traduction : CLI installée par l'utilisateur (ses identifiants). */
export const TRANSLATORS = [
  { id: 'claude', name: 'Claude Code' },
  { id: 'opencode', name: 'opencode' },
] as const;
export type TranslatorId = (typeof TRANSLATORS)[number]['id'];
/** Modèles de transcription (whisper.cpp), du plus rapide au plus précis. */
export const WHISPER_MODELS = [
  { id: 'base', name: 'Rapide (base, 148 Mo)', size: 148 },
  { id: 'small', name: 'Équilibré (small, 488 Mo)', size: 488 },
  { id: 'medium', name: 'Précis (medium, 1,5 Go)', size: 1530 },
] as const;
export type WhisperModel = (typeof WHISPER_MODELS)[number]['id'];
/** Langues proposées pour les vocaux (codes de whisper), nommées en français. */
export const VOICE_LANGUAGES = [
  { code: 'fr', name: 'français' },
  { code: 'he', name: 'hébreu' },
  { code: 'en', name: 'anglais' },
  { code: 'ar', name: 'arabe' },
  { code: 'es', name: 'espagnol' },
  { code: 'ru', name: 'russe' },
  { code: 'de', name: 'allemand' },
  { code: 'it', name: 'italien' },
  { code: 'pt', name: 'portugais' },
  { code: 'yi', name: 'yiddish' },
  { code: 'am', name: 'amharique' },
  { code: 'uk', name: 'ukrainien' },
] as const;

export interface Settings {
  readonly accent: AccentId;
  /** notifications des messages reçus */
  readonly notify: boolean;
  /** auteur et texte dans la notification (sinon « Nouveau message ») */
  readonly preview: boolean;
  /** fond des conversations (Wallpaper.ts) */
  readonly wallpaper: Wallpaper;
  /** traduction : outil, modèle opencode (vide : celui d'opencode), langue cible */
  readonly translator: TranslatorId;
  readonly opencodeModel: string;
  readonly translateTo: string;
  /** transcription des vocaux */
  readonly whisperModel: WhisperModel;
  /** langues de mes vocaux (codes de whisper) : détection limitée à celles-ci */
  readonly voiceLanguages: readonly string[];
  /** langue retenue par discussion (choisie à la main) */
  readonly chatVoiceLanguages: Readonly<Record<string, string>>;
  /** compte affiché au dernier lancement */
  readonly account: string;
  /** message envoyé par « Refuser avec un message » (notification d'appel) */
  readonly rejectMessage: string;
}
const DEFAULTS: Settings = { accent: 'system', notify: true, preview: true, wallpaper: WALLPAPER_DEFAULT, translator: 'claude', opencodeModel: '', translateTo: 'français', whisperModel: 'small', voiceLanguages: ['fr', 'he', 'en'], chatVoiceLanguages: {}, account: DEFAULT_ACCOUNT, rejectMessage: 'Je ne peux pas répondre, je te rappelle' };
const asAccent = (id: string | undefined): AccentId => ACCENTS.find((a) => a.id === id)?.id ?? 'system';

/** Texte sans espaces autour, ou null s'il est absent ou vide. */
const nonEmpty = (s: string | undefined | null): string | null => {
  const t = s?.trim() ?? '';
  return t === '' ? null : t;
};

/** Réglages lus (valeurs par défaut si absents ou invalides). */
export function parseSettings(text: string | null): Settings {
  if (text === null) return DEFAULTS;
  try {
    const raw = SettingsFile.safeParse(JSON.parse(text)).data;
    if (raw === undefined) return DEFAULTS;
    return {
      accent: asAccent(raw.accent),
      notify: raw.notify ?? DEFAULTS.notify,
      preview: raw.preview ?? DEFAULTS.preview,
      wallpaper: isWallpaper(raw.wallpaper) ? raw.wallpaper : DEFAULTS.wallpaper,
      translator: TRANSLATORS.find((t) => t.id === raw.translator)?.id ?? DEFAULTS.translator,
      opencodeModel: raw.opencodeModel?.trim() ?? '',
      translateTo: nonEmpty(raw.translateTo) ?? DEFAULTS.translateTo,
      whisperModel: WHISPER_MODELS.find((m) => m.id === raw.whisperModel)?.id ?? DEFAULTS.whisperModel,
      voiceLanguages: raw.voiceLanguages ?? DEFAULTS.voiceLanguages,
      chatVoiceLanguages: raw.chatVoiceLanguages ?? {},
      account: nonEmpty(raw.account) ?? DEFAULT_ACCOUNT,
      rejectMessage: nonEmpty(raw.rejectMessage) ?? DEFAULTS.rejectMessage,
    };
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

/** Langue des vocaux d'une discussion (null : détection automatique), retenue. */
export function setChatVoiceLanguage(chatId: string, lang: string | null): void {
  const next = { ...current.chatVoiceLanguages };
  if (lang === null) delete next[chatId];
  else next[chatId] = lang;
  update({ chatVoiceLanguages: next });
}

/** Réglages en cours. */
export const settings = (): Settings => current;

/** Compte affiché, retenu pour le prochain lancement. */
export function rememberAccount(account: string): void {
  if (current.account !== account) update({ account });
}

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
  const image = wallpaperImage();
  applyWallpaper(current.wallpaper === 'image' && image === null ? WALLPAPER_DEFAULT : current.wallpaper, image);
}

Gio._promisify(Gtk.FileDialog.prototype, 'open', 'open_finish');
Gio._promisify(Gio.DBusConnection.prototype, 'call', 'call_finish');
Gio._promisify(Gio.File.prototype, 'load_bytes_async', 'load_bytes_finish');

/**
 * Image de fond choisie par l'utilisateur (copiée dans le dossier de données sous un nom nouveau à
 * chaque choix : la feuille de style recharge bien l'image), la plus récente si elle existe.
 */
function wallpaperImage(): string | null {
  const dir = Gio.File.new_for_path(dataDir());
  try {
    const names: string[] = [];
    const list = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
    for (let info = list.next_file(null); info !== null; info = list.next_file(null)) if (info.get_name().startsWith('fond-')) names.push(info.get_name());
    const last = names.toSorted().at(-1);
    return last === undefined ? null : GLib.build_filenamev([dataDir(), last]);
  } catch {
    return null;
  }
}

/** Fond choisi : appliqué et enregistré (image absente : motif par défaut). */
function chooseWallpaper(w: Wallpaper): void {
  update({ wallpaper: w });
  const image = wallpaperImage();
  applyWallpaper(w === 'image' && image === null ? WALLPAPER_DEFAULT : w, image);
}

/** Image choisie par l'utilisateur, vérifiée, copiée puis appliquée comme fond ; false si annulé ou illisible. */
async function pickWallpaper(parent: Gtk.Widget, toast: (t: string) => void): Promise<boolean> {
  const filter = new Gtk.FileFilter({ name: 'Images' });
  filter.add_mime_type('image/*');
  const filters = new Gio.ListStore({ itemType: Gtk.FileFilter.$gtype });
  filters.append(filter);
  const root = parent.get_root();
  try {
    const picked = await new Gtk.FileDialog({ title: 'Image de fond', filters, modal: true }).open(root instanceof Gtk.Window ? root : null, null);
    if (picked === null) return false;
    const [bytes] = await picked.load_bytes_async(null);
    // image illisible : l'ancienne est gardée
    Gdk.Texture.new_from_bytes(bytes);
    const previous = wallpaperImage();
    GLib.mkdir_with_parents(dataDir(), 0o700);
    GLib.file_set_contents(GLib.build_filenamev([dataDir(), `fond-${Date.now()}`]), bytes.toArray());
    if (previous !== null) GLib.unlink(previous);
    chooseWallpaper('image');
    return true;
  } catch (error) {
    if (error instanceof GLib.Error && error.matches(Gtk.DialogError, Gtk.DialogError.DISMISSED)) return false;
    toast(`Image inutilisable : ${errorMessage(error)}`);
    return false;
  }
}

/** Pastille de fond cochée : fond choisi. */
const choose = (w: Wallpaper) => (b: Gtk.ToggleButton): void => {
  if (b.active) chooseWallpaper(w);
};

/** Choix du fond : motif, aucun, couleurs unies, image (chaque clic sur « image » en choisit une). */
function wallpaperChooser(toast: (t: string) => void): Gtk.Widget {
  const box = new Gtk.FlowBox({ selectionMode: Gtk.SelectionMode.NONE, maxChildrenPerLine: 10, minChildrenPerLine: 4, columnSpacing: 6, rowSpacing: 6, marginTop: 10, marginBottom: 10, marginStart: 12, marginEnd: 12, homogeneous: true });
  const buttons = new Map<Wallpaper, Gtk.ToggleButton>();
  let first: Gtk.ToggleButton | null = null;
  const option = (w: Wallpaper, tooltip: string, css: string, icon: string | null): Gtk.ToggleButton => {
    const b = new Gtk.ToggleButton({ tooltipText: tooltip, cssClasses: ['accent-swatch', 'wallpaper-swatch'], widthRequest: 34, heightRequest: 34, valign: Gtk.Align.CENTER, active: current.wallpaper === w });
    if (first !== null) b.set_group(first);
    first ??= b;
    const style = new Gtk.CssProvider();
    style.load_from_string(`button { ${css} }`);
    // oxlint-disable-next-line typescript/no-deprecated -- style propre à ce bouton
    b.get_style_context().add_provider(style, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
    b.set_child(new Gtk.Image({ iconName: icon ?? 'object-select-symbolic', cssClasses: icon === null ? ['check'] : [] }));
    box.append(b);
    buttons.set(w, b);
    return b;
  };
  option('pattern', 'Motif (par défaut)', 'background: #f2eee8; color: #8a7f72;', 'starred-symbolic').connect('toggled', choose('pattern'));
  option('none', 'Aucun fond', 'background: var(--view-bg-color);', 'action-unavailable-symbolic').connect('toggled', choose('none'));
  for (const c of WALLPAPER_COLORS) option(`color:${c.id}`, c.name, `background: ${c.light};`, null).connect('toggled', choose(`color:${c.id}`));
  const image = option('image', 'Choisir une image…', 'background: var(--view-bg-color);', 'image-x-generic-symbolic');
  // « clicked » : aussi quand l'image est déjà le fond (choisir une autre image)
  image.connect('clicked', () => {
    const before = current.wallpaper;
    image.active = true;
    void (async (): Promise<void> => {
      if (await pickWallpaper(image, toast)) return;
      // annulé : retour au fond précédent
      buttons.get(before)?.set_active(true);
    })();
  });
  return box;
}

/** Langue des vocaux ajoutée ou retirée ; liste enregistrée renvoyée. */
function toggleVoiceLanguage(code: string, on: boolean): string[] {
  const set = new Set(current.voiceLanguages);
  if (on) set.add(code);
  else set.delete(code);
  const list = VOICE_LANGUAGES.map((x) => x.code).filter((c) => set.has(c));
  update({ voiceLanguages: list });
  return list;
}

/** Résumé des langues des vocaux (« français, hébreu, anglais »). */
const voiceLanguagesText = (codes: readonly string[]): string => (codes.length === 0 ? 'Toutes (détection automatique)' : codes.map((c) => VOICE_LANGUAGES.find((l) => l.code === c)?.name ?? c).join(', '));

/** Préférences de la traduction et de la transcription. */
function translationGroup(): Adw.PreferencesGroup {
  const group = new Adw.PreferencesGroup({ title: 'Traduction', description: 'Le texte à traduire est envoyé à l’outil choisi, avec votre compte.' });
  const tool = new Adw.ComboRow({ title: 'Outil de traduction', model: Gtk.StringList.new(TRANSLATORS.map((t) => t.name)), selected: Math.max(0, TRANSLATORS.findIndex((t) => t.id === current.translator)) });
  const model = new Adw.EntryRow({ title: 'Modèle opencode (fournisseur/modèle, vide : celui d’opencode)', text: current.opencodeModel, visible: current.translator === 'opencode' });
  tool.connect('notify::selected', () => {
    const id = TRANSLATORS[tool.selected]?.id ?? 'claude';
    update({ translator: id });
    model.visible = id === 'opencode';
  });
  model.connect('changed', () => update({ opencodeModel: model.text.trim() }));
  const target = new Adw.EntryRow({ title: 'Traduire en', text: current.translateTo });
  target.connect('changed', () => update({ translateTo: nonEmpty(target.text) ?? DEFAULTS.translateTo }));
  group.add(tool);
  group.add(model);
  group.add(target);
  return group;
}

/** Taille lisible d'un modèle (« 488 Mo », « 1,5 Go »). */
const modelSize = (mo: number): string => (mo >= 1000 ? `${(mo / 1000).toFixed(1).replace('.', ',')} Go` : `${mo} Mo`);

/** Ligne d'un modèle de transcription : état, téléchargement suivi, annulation, suppression. */
function modelRow(m: (typeof WHISPER_MODELS)[number], toast: (t: string) => void): Adw.ActionRow {
  const row = new Adw.ActionRow({ title: `${m.name.replace(/ \(.*$/u, '')} (${m.id})`, subtitle: '' });
  const bar = new Gtk.ProgressBar({ valign: Gtk.Align.CENTER, widthRequest: 120 });
  const download = new Gtk.Button({ iconName: 'folder-download-symbolic', tooltipText: `Télécharger (${modelSize(m.size)})`, valign: Gtk.Align.CENTER, cssClasses: ['flat'] });
  const cancel = new Gtk.Button({ iconName: 'process-stop-symbolic', tooltipText: 'Annuler le téléchargement', valign: Gtk.Align.CENTER, cssClasses: ['flat'] });
  const remove = new Gtk.Button({ iconName: 'user-trash-symbolic', tooltipText: 'Supprimer le modèle', valign: Gtk.Align.CENTER, cssClasses: ['flat'] });
  for (const w of [bar, download, cancel, remove]) row.add_suffix(w);
  const sync = (): void => {
    const st = downloads.peek().get(m.id);
    const present = hasWhisper(m.id);
    const busy = st?.status === 'downloading';
    bar.visible = busy;
    cancel.visible = busy;
    download.visible = !busy && !present;
    remove.visible = !busy && present;
    if (busy) bar.fraction = st.fraction;
    row.subtitle = busy
      ? `Téléchargement… ${Math.round(st.fraction * 100)} % de ${modelSize(m.size)}`
      : st?.status === 'error'
        ? `Échec du téléchargement : ${st.error}`
        : present
          ? `Téléchargé · ${modelSize(m.size)}`
          : `Non téléchargé · ${modelSize(m.size)}`;
  };
  sync();
  const subs = [downloads.subscribe(sync), models.subscribe(sync)];
  row.connect('destroy', () => {
    for (const u of subs) u();
  });
  download.connect('clicked', () => {
    downloadWhisper(m.id).catch((error: unknown) => {
      if (!(error instanceof DownloadCancelled)) toast(`Téléchargement impossible : ${errorMessage(error)}`);
    });
  });
  cancel.connect('clicked', () => cancelWhisper(m.id));
  remove.connect('clicked', () => {
    try {
      deleteWhisper(m.id);
    } catch (error) {
      toast(`Suppression impossible : ${errorMessage(error)}`);
    }
  });
  return row;
}

/**
 * Ouvre un dossier dans le gestionnaire de fichiers : interface D-Bus standard des gestionnaires
 * de fichiers (Fichiers de GNOME, Dolphin…), sinon application par défaut des dossiers.
 */
async function openFolder(dir: string): Promise<void> {
  const uri = GLib.filename_to_uri(dir, null);
  try {
    await Gio.DBus.session.call('org.freedesktop.FileManager1', '/org/freedesktop/FileManager1', 'org.freedesktop.FileManager1', 'ShowFolders', new GLib.Variant('(ass)', [[uri], '']), null, Gio.DBusCallFlags.NONE, 5000, null);
  } catch {
    Gio.AppInfo.launch_default_for_uri(uri, null);
  }
}

/** Préférences de la transcription des vocaux : modèle utilisé, modèles téléchargés, langues. */
function transcriptionGroup(toast: (t: string) => void): Adw.PreferencesGroup {
  const group = new Adw.PreferencesGroup({ title: 'Transcription des vocaux', description: 'Sur cet ordinateur, avec whisper.cpp. Un modèle plus grand reconnaît mieux les langues moins courantes (hébreu), mais il est plus lent.' });
  const whisper = new Adw.ComboRow({
    title: 'Modèle utilisé',
    model: Gtk.StringList.new(WHISPER_MODELS.map((m) => m.name)),
    selected: Math.max(0, WHISPER_MODELS.findIndex((m) => m.id === current.whisperModel)),
  });
  whisper.connect('notify::selected', () => update({ whisperModel: WHISPER_MODELS[whisper.selected]?.id ?? DEFAULTS.whisperModel }));
  group.add(whisper);
  for (const m of WHISPER_MODELS) group.add(modelRow(m, toast));
  // dossier des modèles : ménage à la main
  const folder = new Adw.ActionRow({ title: 'Dossier des modèles', subtitle: whisperDir(), subtitleSelectable: true });
  const open = new Gtk.Button({ iconName: 'folder-open-symbolic', tooltipText: 'Ouvrir le dossier des modèles', valign: Gtk.Align.CENTER, cssClasses: ['flat'] });
  open.connect('clicked', () => {
    GLib.mkdir_with_parents(whisperDir(), 0o700);
    openFolder(whisperDir()).catch((error: unknown) => toast(`Ouverture impossible : ${errorMessage(error)}`));
  });
  folder.add_suffix(open);
  group.add(folder);
  // langues parlées dans mes vocaux : détection automatique limitée à celles-ci
  const langs = new Adw.ExpanderRow({ title: 'Langues de mes vocaux', subtitle: voiceLanguagesText(current.voiceLanguages) });
  for (const l of VOICE_LANGUAGES) {
    const row = new Adw.SwitchRow({ title: l.name.replace(/^./u, (c) => c.toUpperCase()), active: current.voiceLanguages.includes(l.code) });
    row.connect('notify::active', () => {
      langs.subtitle = voiceLanguagesText(toggleVoiceLanguage(l.code, row.active));
    });
    langs.add_row(row);
  }
  group.add(langs);
  return group;
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
  const dialog = new Adw.PreferencesDialog({ title: 'Préférences' });
  // messages affichés dans la fenêtre des préférences (au-dessus de la fenêtre principale)
  const toast = (t: string): void => dialog.add_toast(new Adw.Toast({ title: t, timeout: 5 }));
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
  appearance.add(new Adw.ActionRow({ title: 'Fond des conversations', subtitle: 'Motif, couleur unie ou image' }));
  appearance.add(new Adw.PreferencesRow({ child: wallpaperChooser(toast), activatable: false }));
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
  const reject = new Adw.EntryRow({ title: 'Message de refus d’un appel', text: current.rejectMessage });
  reject.connect('changed', () => update({ rejectMessage: nonEmpty(reject.text) ?? DEFAULTS.rejectMessage }));
  notifications.add(reject);
  page.add(notifications);
  page.add(translationGroup());
  page.add(transcriptionGroup(toast));
  dialog.add(page);
  dialog.present(parent);
}

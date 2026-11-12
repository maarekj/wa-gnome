// Écran de diagnostic : versions (app, démon, Baileys, bibliothèques), état de chaque compte
// (connexion, dernière erreur, coupures), tailles des données et derniers avertissements du démon ;
// « Copier » pour joindre le tout à un signalement.
import Adw from 'gi://Adw?version=1';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';
import type { Diagnostics } from '../shared/api.ts';
import type { WaClient } from '../shared/client.ts';
import { errorMessage } from '../shared/errors.ts';
import { fmtDateTime } from '../shared/format.ts';

const STATE: Readonly<Record<string, string>> = { starting: 'démarrage', qr: 'appairage nécessaire', connecting: 'connexion…', open: 'connecté', 'logged-out': 'déconnecté du téléphone', closed: 'connexion perdue' };

/** Taille lisible (« 112 Mo »). */
export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} o`;
  if (n < 1024 ** 2) return `${Math.round(n / 1024)} Ko`;
  if (n < 1024 ** 3) return `${Math.round(n / 1024 ** 2)} Mo`;
  return `${(n / 1024 ** 3).toFixed(1).replace('.', ',')} Go`;
}

/** Versions de l'application et des bibliothèques (côté app). */
export function appVersions(appVersion: string): [string, string][] {
  return [
    ['Application', appVersion],
    ['GTK', `${Gtk.get_major_version()}.${Gtk.get_minor_version()}.${Gtk.get_micro_version()}`],
    ['libadwaita', `${Adw.get_major_version()}.${Adw.get_minor_version()}.${Adw.get_micro_version()}`],
    // GJS : 18801 → 1.88.1
    ['GJS', ((v: number): string => `${Math.floor(v / 10_000)}.${Math.floor(v / 100) % 100}.${v % 100}`)(imports.system.version)],
  ];
}

/** Date d'un événement, « — » s'il n'a pas eu lieu. */
const when = (t: number | null): string => (t === null ? '—' : fmtDateTime(t));

/** Rapport texte complet (copié dans le presse-papier). */
export function diagnosticsText(d: Diagnostics, app: readonly [string, string][]): string {
  const lines = [
    'WhatsApp pour GNOME — diagnostic',
    ...app.map(([k, v]) => `${k} : ${v}`),
    `Démon : ${d.daemon.version} (Baileys ${d.daemon.baileys}, Node ${d.daemon.node}), démarré ${when(d.daemon.startedAt)}`,
    `Données : ${d.daemon.dataDir}`,
    '',
  ];
  for (const a of d.accounts) {
    lines.push(
      `Compte ${a.id}${a.status.me === null ? '' : ` (${a.status.me.name ?? a.status.me.id})`} : ${STATE[a.status.state] ?? a.status.state}`,
      `  dernière erreur : ${a.status.error ?? '—'}`,
      `  connecté ${when(a.connectedAt)} ; dernière coupure ${when(a.disconnectedAt)} ; coupures : ${a.disconnects}`,
      `  version web : ${a.webVersion?.join('.') ?? '—'}`,
      `  base : ${fmtBytes(a.dbSize)} (${a.chats} discussions, ${a.messages} messages) ; médias en cache : ${fmtBytes(a.mediaSize)}`,
    );
  }
  lines.push('', `Journal (${d.logs.length} lignes) :`, ...d.logs.map((l) => `${GLib.DateTime.new_from_unix_local(Math.floor(l.time / 1000))?.format('%d/%m %H:%M:%S') ?? ''} [${l.level}] ${l.msg}`));
  return lines.join('\n');
}

const row = (title: string, value: string): Adw.ActionRow => {
  const r = new Adw.ActionRow({ title, subtitle: value, subtitleSelectable: true });
  r.add_css_class('property');
  return r;
};

/** Fenêtre de diagnostic (relue à l'ouverture et par « Actualiser »). */
export function openDiagnostics(parent: Gtk.Widget, client: WaClient, appVersion: string, toast: (t: string) => void): void {
  const app = appVersions(appVersion);
  const page = new Adw.PreferencesPage();
  const header = new Adw.HeaderBar();
  const copy = new Gtk.Button({ iconName: 'edit-copy-symbolic', tooltipText: 'Copier le diagnostic', sensitive: false });
  const refresh = new Gtk.Button({ iconName: 'view-refresh-symbolic', tooltipText: 'Actualiser' });
  header.pack_start(copy);
  header.pack_start(refresh);
  const view = new Adw.ToolbarView({ content: page });
  view.add_top_bar(header);
  const dialog = new Adw.Dialog({ title: 'Diagnostic', child: view, contentWidth: 620, contentHeight: 680 });
  let groups: Adw.PreferencesGroup[] = [];
  let report = '';
  const show = (d: Diagnostics | null, error: string | null): void => {
    for (const g of groups) page.remove(g);
    groups = [];
    const add = (g: Adw.PreferencesGroup): void => {
      page.add(g);
      groups.push(g);
    };
    const versions = new Adw.PreferencesGroup({ title: 'Versions' });
    for (const [k, v] of app) versions.add(row(k, v));
    if (d !== null) {
      versions.add(row('Démon', `${d.daemon.version} · Node ${d.daemon.node} · démarré ${fmtDateTime(d.daemon.startedAt)}`));
      versions.add(row('Baileys', d.daemon.baileys));
      versions.add(row('Dossier des données', d.daemon.dataDir));
    }
    add(versions);
    if (d === null) {
      const g = new Adw.PreferencesGroup({ title: 'Démon' });
      g.add(row('Démon injoignable', error ?? ''));
      add(g);
      return;
    }
    for (const a of d.accounts) {
      const g = new Adw.PreferencesGroup({ title: a.status.me === null ? `Compte ${a.id}` : `Compte ${a.status.me.name ?? a.status.me.id}`, description: a.status.me?.id ?? a.id });
      g.add(row('Connexion', STATE[a.status.state] ?? a.status.state));
      if (a.status.error !== null) g.add(row('Dernière erreur', a.status.error));
      g.add(row('Connecté depuis', a.connectedAt === null ? '—' : fmtDateTime(a.connectedAt)));
      g.add(row('Coupures', a.disconnects === 0 ? 'aucune depuis le démarrage' : `${a.disconnects} (dernière ${a.disconnectedAt === null ? '—' : fmtDateTime(a.disconnectedAt)})`));
      g.add(row('Version web annoncée', a.webVersion?.join('.') ?? '—'));
      g.add(row('Données', `base ${fmtBytes(a.dbSize)} (${a.chats} discussions, ${a.messages} messages) · médias en cache ${fmtBytes(a.mediaSize)}`));
      add(g);
    }
    const logs = new Adw.PreferencesGroup({ title: 'Journal du démon', description: d.logs.length === 0 ? 'Aucun avertissement depuis le démarrage' : `${d.logs.length} derniers avertissements et erreurs` });
    const text = d.logs
      .toReversed()
      .map((l) => `${GLib.DateTime.new_from_unix_local(Math.floor(l.time / 1000))?.format('%d/%m %H:%M:%S') ?? ''}  ${l.level}  ${l.msg}`)
      .join('\n');
    if (text !== '') {
      const label = new Gtk.Label({ label: text, xalign: 0, wrap: true, wrapMode: Pango.WrapMode.WORD_CHAR, selectable: true, cssClasses: ['monospace', 'caption'], marginTop: 8, marginBottom: 8, marginStart: 10, marginEnd: 10 });
      logs.add(new Gtk.Frame({ child: new Gtk.ScrolledWindow({ child: label, minContentHeight: 220, maxContentHeight: 320, propagateNaturalHeight: true, hscrollbarPolicy: Gtk.PolicyType.NEVER }) }));
    }
    add(logs);
  };
  const load = async (): Promise<void> => {
    try {
      const d = await client.diagnostics();
      report = diagnosticsText(d, app);
      show(d, null);
    } catch (error) {
      report = [...app.map(([k, v]) => `${k} : ${v}`), `Démon injoignable : ${errorMessage(error)}`].join('\n');
      show(null, errorMessage(error));
    }
    copy.sensitive = true;
  };
  copy.connect('clicked', () => {
    copy.get_clipboard().set(report);
    toast('Diagnostic copié');
  });
  refresh.connect('clicked', () => void load());
  show(null, 'chargement…');
  void load();
  dialog.present(parent);
}

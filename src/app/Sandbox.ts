// Paquet Flatpak : démon embarqué lancé par l'application, outils de l'utilisateur (opencode,
// claude) lancés hors du bac à sable par `flatpak-spawn --host`.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

/** Application lancée dans un Flatpak. */
export const inFlatpak = (): boolean => GLib.file_test('/.flatpak-info', GLib.FileTest.EXISTS);

/** Dossiers où chercher un outil de l'utilisateur, en plus du PATH (lancement depuis le bureau). */
export const USER_BIN_DIRS = (home: string, user: string): string[] => [
  `${home}/.local/bin`,
  `${home}/.nix-profile/bin`,
  `/etc/profiles/per-user/${user}/bin`,
  '/run/current-system/sw/bin',
  '/usr/local/bin',
  '/usr/bin',
];

/**
 * Commande lancée sur la machine hôte : PATH complété par les dossiers habituels, dossier de
 * travail `cwd` créé (privé) côté hôte, variables `env` transmises.
 */
export function hostArgv(name: string, args: readonly string[], cwd: string, env: Record<string, string>): string[] {
  const dirs = USER_BIN_DIRS('$HOME', '$(id -un)').join(':');
  const script = `PATH="$PATH:${dirs}"; mkdir -p -m 700 "$1" && cd "$1" || exit 1; shift; command -v "$1" >/dev/null || { echo "$1 introuvable sur la machine : installez-le ou choisissez un autre outil dans les préférences" >&2; exit 127; }; exec "$@"`;
  return ['flatpak-spawn', '--host', ...Object.entries(env).map(([k, v]) => `--env=${k}=${v}`), 'sh', '-c', script, 'sh', cwd, name, ...args];
}

/** Démon embarqué lancé par l'application (Flatpak), arrêté avec elle. */
let daemon: Gio.Subprocess | null = null;

/**
 * Lance le démon embarqué (`WA_GNOME_DAEMON` : sa commande) ; s'il en tourne déjà un (autre
 * instance), le nouveau s'arrête de lui-même (port occupé) et l'application utilise l'existant.
 */
export function startEmbeddedDaemon(): void {
  const cmd = GLib.getenv('WA_GNOME_DAEMON');
  if (cmd === null || cmd === '' || daemon !== null || GLib.getenv('WA_GNOME_URL') !== null) return;
  try {
    const launcher = new Gio.SubprocessLauncher({ flags: Gio.SubprocessFlags.NONE });
    // arrêt du démon si l'application disparaît sans l'arrêter (plantage)
    launcher.setenv('WA_GNOME_EXIT_WITH_PARENT', '1', true);
    daemon = launcher.spawnv([cmd]);
  } catch (error) {
    console.error(`démon embarqué : ${String(error)}`);
  }
}

/** Arrête le démon embarqué (application quittée). */
export function stopEmbeddedDaemon(): void {
  daemon?.send_signal(15);
  daemon = null;
}

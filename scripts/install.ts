// Installation locale (développement) :
//  - unité systemd utilisateur `wa-gnome-daemon` (démon Baileys, API sur 127.0.0.1:4180)
//  - ~/.local/bin/wa-gnome + fichier .desktop + service D-Bus : lance l'application
// À lancer depuis le shell devenv (node, gjs et les typelibs sont capturés depuis l'environnement courant).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from './build.ts';

const APP_ID = 'io.github.maarekj.WaGnome';
const UNIT = 'wa-gnome-daemon.service';
const LAUNCHER = 'wa-gnome';

const root = path.resolve(import.meta.dirname, '..');
const home = os.homedir();
const binDir = path.join(home, '.local', 'bin');
const unitDir = path.join(home, '.config', 'systemd', 'user');
const appsDir = path.join(home, '.local', 'share', 'applications');
const dbusDir = path.join(home, '.local', 'share', 'dbus-1', 'services');
const iconsDir = path.join(home, '.local', 'share', 'icons', 'hicolor');

const which = (bin: string): string => {
  const found = (process.env['PATH'] ?? '').split(':').map((d) => path.join(d, bin)).find((p) => fs.existsSync(p));
  if (found === undefined) throw new Error(`${bin} introuvable dans le PATH (lance ce script depuis le shell devenv)`);
  return fs.realpathSync(found);
};
/** Valeur d'unité systemd entre guillemets, `%` littéral. */
const unitQuote = (s: string): string => `"${s.replaceAll('%', '%%').replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
const shq = (s: string): string => `'${s.replaceAll("'", String.raw`'\''`)}'`;
const write = (file: string, content: string, mode = 0o644): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode });
  fs.chmodSync(file, mode);
  console.log(`  ${file.replace(home, '~')}`);
};

console.log('build…');
await buildApp();

console.log('fichiers :');
write(
  path.join(unitDir, UNIT),
  `[Unit]
Description=Démon WhatsApp (wa-gnome)
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${root.replaceAll('%', '%%')}
ExecStart=${unitQuote(which('node'))} ${unitQuote(path.join(root, 'src', 'daemon', 'main.ts'))}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`,
);

write(
  path.join(binDir, LAUNCHER),
  `#!/usr/bin/env bash
# Lance wa-gnome (version de développement : ${root}).
export GI_TYPELIB_PATH=${shq(process.env['GI_TYPELIB_PATH'] ?? '')}\${GI_TYPELIB_PATH:+:$GI_TYPELIB_PATH}
exec ${shq(which('gjs'))} -m ${shq(path.join(root, 'dist', 'app', 'main.js'))} "$@"
`,
  0o755,
);

write(path.join(iconsDir, 'scalable', 'apps', `${APP_ID}.svg`), fs.readFileSync(path.join(root, 'data', 'icons', 'app.svg'), 'utf8'));
write(path.join(iconsDir, 'symbolic', 'apps', `${APP_ID}-symbolic.svg`), fs.readFileSync(path.join(root, 'data', 'icons', 'app-symbolic.svg'), 'utf8'));
try {
  // le thème hicolor n'est relu qu'à la mise à jour de son horodatage
  fs.utimesSync(iconsDir, new Date(), new Date());
} catch {
  // dossier absent : rien à rafraîchir
}

write(
  path.join(appsDir, `${APP_ID}.desktop`),
  `[Desktop Entry]
Type=Application
Name=WhatsApp
Comment=Client WhatsApp pour GNOME
Exec=${path.join(binDir, LAUNCHER)}
Icon=${APP_ID}
Terminal=false
Categories=Network;InstantMessaging;Chat;
Keywords=whatsapp;chat;messages;
StartupNotify=true
DBusActivatable=true
`,
);

// Activation D-Bus : GNOME Shell active les actions des notifications (clic) via
// org.freedesktop.Application sur le nom de bus de l'application (DBusActivatable=true).
write(
  path.join(dbusDir, `${APP_ID}.service`),
  `[D-BUS Service]
Name=${APP_ID}
Exec=${path.join(binDir, LAUNCHER)} --gapplication-service
`,
);

console.log('systemd…');
execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' });
execFileSync('systemctl', ['--user', 'enable', UNIT], { stdio: 'inherit' });
// redémarré pour prendre en compte le nouveau code (la session WhatsApp est conservée sur disque)
execFileSync('systemctl', ['--user', 'restart', UNIT], { stdio: 'inherit' });
console.log(`ok — démon : ${UNIT} (journalctl --user -u ${UNIT})  ·  app : ${LAUNCHER}`);

// Construit le paquet Flatpak (flatpak/io.github.maarekj.WaGnome.yml) et son bundle
// dist/wa-gnome.flatpak, installable par `flatpak install --user dist/wa-gnome.flatpak`.
// Prérequis : flatpak-builder, et dans l'installation utilisateur org.gnome.Platform et
// org.gnome.Sdk (51), org.freedesktop.Sdk.Extension.node24 (26.08) — téléchargés sinon.
// Usage : node scripts/flatpak.ts [--install] (installe aussi le paquet pour l'utilisateur)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

const APP_ID = 'io.github.maarekj.WaGnome';
const root = path.resolve(import.meta.dirname, '..');
const { values } = parseArgs({ options: { install: { type: 'boolean', default: false } } });
const work = path.join(root, '.flatpak-builder');
const repo = path.join(work, 'repo');
const bundle = path.join(root, 'dist', 'wa-gnome.flatpak');
const run = (cmd: string, args: string[]): void => {
  console.log(`$ ${cmd} ${args.join(' ')}`);
  execFileSync(cmd, args, { stdio: 'inherit', cwd: root });
};

run('flatpak-builder', [
  '--user',
  '--install-deps-from=flathub',
  '--force-clean',
  // rofiles-fuse : fusermount souvent non setuid (NixOS, shell devenv)
  '--disable-rofiles-fuse',
  '--ccache',
  `--state-dir=${path.join(work, 'state')}`,
  `--repo=${repo}`,
  ...(values.install ? ['--install'] : []),
  path.join(work, 'build'),
  path.join(root, 'flatpak', `${APP_ID}.yml`),
]);
fs.mkdirSync(path.dirname(bundle), { recursive: true });
run('flatpak', ['build-bundle', '--runtime-repo=https://dl.flathub.org/repo/flathub.flatpakrepo', repo, bundle, APP_ID]);
console.log(`ok — ${bundle}${values.install ? ` (installé : flatpak run ${APP_ID})` : ''}`);

// Bundle l'application GTK (TSX + gnim) dans dist/app avec esbuild.
// Le démon n'est pas bundlé : Node 24 exécute directement src/daemon/main.ts.
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';

const root = path.resolve(import.meta.dirname, '..');
const dist = path.join(root, 'dist');

export const GJS_EXTERNALS = ['gi://*', 'resource://*', 'system', 'gettext', 'cairo'];
// config explicite : les `paths` du tsconfig (gnim -> déclarations) ne servent qu'au typecheck
export const GJS_TSCONFIG = { compilerOptions: { jsx: 'react-jsx', jsxImportSource: 'gnim/gtk4', experimentalDecorators: false } } as const;

export async function buildApp(): Promise<string> {
  const out = path.join(dist, 'app');
  fs.rmSync(out, { recursive: true, force: true });
  await build({
    entryPoints: [path.join(root, 'src', 'app', 'main.tsx')],
    outfile: path.join(out, 'main.js'),
    bundle: true,
    format: 'esm',
    // abaisse les décorateurs (@register de gnim) en JS simple
    target: 'es2022',
    sourcemap: 'inline',
    external: GJS_EXTERNALS,
    tsconfigRaw: GJS_TSCONFIG,
    logLevel: 'warning',
  });
  return out;
}

if (import.meta.main) console.log(`app: ${await buildApp()}`);

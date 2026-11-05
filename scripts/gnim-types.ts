// Génère les déclarations de gnim dans types/gnim.
// gnim publie des sources TypeScript qui ne passent pas le typecheck avec les typings @girs actuels :
// notre code est vérifié contre ces déclarations (tsconfig `paths`), esbuild bundle les vraies sources.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const src = path.join(root, 'node_modules', 'gnim', 'dist');
const types = path.join(root, 'types');
const work = path.join(types, '.gnim-src');
const out = path.join(types, 'gnim');

fs.rmSync(types, { recursive: true, force: true });
fs.cpSync(src, work, { recursive: true });
try {
  execFileSync(path.join(root, 'node_modules', '.bin', 'tsc'), ['-p', path.join(root, 'tsconfig.gnim.json')], { stdio: 'pipe' });
} catch {
  // erreurs de types internes à gnim attendues : les déclarations sont émises quand même (noEmitOnError: false)
}
fs.rmSync(work, { recursive: true, force: true });
const count = fs.readdirSync(out, { recursive: true }).filter((f) => String(f).endsWith('.d.ts')).length;
if (count === 0) throw new Error('aucune déclaration générée pour gnim');
console.log(`gnim: ${count} déclarations dans ${path.relative(root, out)}`);

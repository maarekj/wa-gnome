// keyedBox : les enfants suivent exactement l'ordre de la liste (insertions, déplacements,
// suppressions), insertion après le widget précédent (#74).
import Gtk from 'gi://Gtk?version=4.0';
import { createRoot, createState } from 'gnim';
import { keyedBox } from '../src/app/KeyedBox.ts';

Gtk.init();
const box = new Gtk.Box();
const [items, setItems] = createState<readonly string[]>([]);
createRoot(() => keyedBox(box, items, (s) => s, (s) => new Gtk.Label({ label: s })));
const labels = (): string[] => {
  const out: string[] = [];
  for (let c = box.get_first_child(); c !== null; c = c.get_next_sibling()) if (c instanceof Gtk.Label) out.push(c.label);
  return out;
};
let seed = 7;
const rand = (n: number): number => {
  seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
  return seed % n;
};
let ok = true;
for (let step = 0; step < 300 && ok; step += 1) {
  const pool = Array.from({ length: 30 }, (_, i) => `k${i}`);
  const next = pool.filter(() => rand(3) > 0);
  for (let i = next.length - 1; i > 0; i -= 1) {
    const j = rand(i + 1);
    [next[i], next[j]] = [next[j] ?? '', next[i] ?? ''];
  }
  setItems(next);
  ok = labels().join(',') === next.join(',');
  if (!ok) print(`ordre incorrect à l'étape ${step} : ${labels().join(',')} au lieu de ${next.join(',')}`);
}
if (ok) print('TEST OK');

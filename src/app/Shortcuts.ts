// Fenêtre des raccourcis clavier (Ctrl+?).
import Adw from 'gi://Adw?version=1';
import type Gtk from 'gi://Gtk?version=4.0';

/** Raccourcis, par section (libellé, accélérateur GTK). */
export const SHORTCUTS: readonly { title: string; items: readonly [string, string][] }[] = [
  {
    title: 'Discussions',
    items: [
      ['Palette de commandes', '<Control>p'],
      ['Rechercher', '<Control>k'],
      ['Discussion précédente', '<Alt>Up'],
      ['Discussion suivante', '<Alt>Down'],
      ['Nouvelle discussion', '<Control>n'],
    ],
  },
  {
    title: 'Onglets',
    items: [
      ['Onglet suivant', '<Control>Tab'],
      ['Onglet précédent', '<Control><Shift>Tab'],
      ['Aller à l’onglet 1 à 8 (Alt+9 : le dernier)', '<Alt>1'],
      ['Fermer l’onglet (sans discussion affichée : la fenêtre)', '<Control>w'],
    ],
  },
  {
    title: 'Discussion ouverte',
    items: [
      ['Rechercher dans la discussion', '<Control>f'],
      ['Envoyer', 'Return'],
      ['Nouvelle ligne', '<Shift>Return'],
      ['Annuler la réponse, la modification ou la sélection', 'Escape'],
    ],
  },
  {
    title: 'Application',
    items: [
      ['Préférences', '<Control>comma'],
      ['Raccourcis clavier', '<Control>question'],
      ['Quitter', '<Control>q'],
    ],
  },
];

export function openShortcuts(parent: Gtk.Widget): void {
  const dialog = new Adw.ShortcutsDialog();
  for (const s of SHORTCUTS) {
    const section = new Adw.ShortcutsSection({ title: s.title });
    for (const [title, accelerator] of s.items) section.add(new Adw.ShortcutsItem({ title, accelerator }));
    dialog.add(section);
  }
  dialog.present(parent);
}

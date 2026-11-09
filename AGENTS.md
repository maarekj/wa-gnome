# wa-gnome

Client WhatsApp pour GNOME : une application GTK 4 / libadwaita (GJS) et un démon Node qui tient
la connexion WhatsApp avec [Baileys](https://github.com/WhiskeySockets/Baileys) (protocole
multi-appareils, sans navigateur). Même pile technique qu'opencode-gnome.

## Architecture
- `src/daemon/` : démon **Node 24** (exécuté sans compilation : `node src/daemon/main.ts`), en
  service systemd utilisateur `wa-gnome-daemon`. GJS ne peut pas faire tourner Baileys (crypto,
  websockets Node) : d'où ce processus séparé.
  - `whatsapp.ts` : socket Baileys, appairage (QR), reconnexion, événements → Store.
  - `store.ts` : base SQLite (`node:sqlite`) des discussions, contacts et messages (WAMessage brut gardé
    dans `raw` pour les médias et le renvoi).
  - `convert.ts` : message protobuf → `Message` de l'API.
  - `server.ts` : API HTTP + SSE sur 127.0.0.1:4180, jeton `Authorization: Bearer` (fichier `token`).
    Plusieurs comptes : chacun sous `/accounts/:id/…` (mêmes routes) ; le premier (`default`) aussi
    sans préfixe. Données d'un compte ajouté dans `accounts/<id>/` (même structure que la racine).
- `src/shared/api.ts` : **contrat** démon ↔ app (schémas zod/mini), importé des deux côtés ; sans
  dépendance à Node ni à GJS.
- `src/shared/` (GJS) : client libsoup 3 (`client.ts`), état réactif (`store.ts`), formats.
- `src/app/` : application `Adw.Application` en TSX avec gnim (`gnim/gtk4`).
- Données : `$XDG_DATA_HOME/wa-gnome/` (`auth/` : session WhatsApp, `wa.db`, `token`).
  Variables : `WA_GNOME_DATA_DIR`, `WA_GNOME_URL` (app), `WA_GNOME_PORT`, `WA_GNOME_LOG` (démon),
  `WA_GNOME_APP_ID` (app).

## Commandes (dans le shell devenv)
- `pnpm check` : typecheck + lint (oxlint type-aware) + `pnpm test`. Doit passer avant chaque commit.
- `pnpm test` : specs jasmine-gjs (`specs/*.spec.ts`), puis tests GJS sous Xvfb (`tests/*.ts`) ;
  échec sur tout `Gtk-WARNING`/`Gtk-CRITICAL` ou délai dépassé.
- `pnpm e2e` : tests de bout en bout (`e2e/test_*.py`, pytest + dogtail, ≈ 40 s) sur le faux démon :
  l'app est pilotée par l'accessibilité (rôle et nom : texte affiché ou infobulle) sur un écran
  virtuel, bus D-Bus et bus d'accessibilité privés. Un seul : `pnpm e2e -k envoyer`. Le faux démon
  y est lancé avec `--control <port>` (`GET /calls` : appels reçus de l'app ; `POST /incoming`
  {chatId, text, account?} : message reçu ; `POST /pair` : appairage terminé, du dernier compte ajouté
  s'il y en a un) et `--no-replies`.
  Scénarios : appairage, ouverture, envoi, réception (liste et discussion ouverte), déconnexion,
  nouvelle discussion, recherche globale et dans la discussion, « Répondre » d’une notification,
  raccourcis (Alt+Haut/Bas, Ctrl+K) et fenêtre des raccourcis, galerie des médias, sélection en glissant, sélecteur d’émojis, fiche du groupe et du contact, liens cliquables (`WA_GNOME_TEST_LINKS` : `LIEN url` journalisé), message vocal (son de test à la place du micro), brouillon par discussion, émojis seuls en grand, forme d’onde des vocaux, traduction et transcription (`WA_GNOME_TEST_TRANSLATE` : simulées, aucun outil lancé), plusieurs comptes (ajout, sélecteur, notification d’un autre compte, retrait).
  À lancer avant de fusionner un changement d'interface ; ajouter le scénario de chaque fonctionnalité.
  Un bouton à icône sans infobulle est introuvable : toujours lui donner une infobulle.
- `pnpm daemon` : lance le démon au premier plan (`WA_GNOME_LOG=debug` pour les journaux Baileys).
- `pnpm fake-daemon [--state open|qr|connecting] [--port 4798]` : faux démon (même serveur HTTP, vrai
  Store SQLite) avec des discussions de démonstration et des réponses automatiques. Jeton dans
  `--dir` (défaut `/tmp/wa-gnome-fake`) : lancer l'app avec `WA_GNOME_DATA_DIR` et `WA_GNOME_URL`.
- `pnpm screenshot [sortie.png] [--state qr]` : lance l'app sur un écran virtuel (Xvfb), branchée sur
  le faux démon, et en fait une capture. **Toujours valider un changement d'interface ainsi**, jamais
  en ouvrant une fenêtre sur l'écran de l'utilisateur ni en utilisant son vrai compte WhatsApp.
  Interactions : `SCREENSHOT_XDOTOOL="mousemove 150 125 click 1; sleep 1; type bonjour; key Return; sleep 2"`
  (`sh: commande` pour une commande shell, ex. `xclip` pour remplir le presse-papier).
- `pnpm build` / `pnpm start` : construire / lancer l'application.
- `node scripts/install.ts` : installe le démon (systemd), le lanceur `wa-gnome`, le .desktop, le
  service D-Bus et les icônes.

## Conventions
- TypeScript strict ; données externes (HTTP, SQLite, événements) validées avec zod/mini.
- Interface, commentaires et messages de commit en français.
- Toute évolution de l'API passe par `src/shared/api.ts` (démon et app vérifiés contre le même schéma).
- gnim n'est pas React : un composant s'exécute une fois, seules les valeurs liées se mettent à jour.
  Pour une liste ordonnée, utiliser `keyedBox` / `keyedListBox` (`src/app/KeyedBox.ts`), pas `<For>`.
- Tout bouton à icône seule a une infobulle.
- Tests et captures **muets** : `WA_GNOME_SILENT=1` et aucun serveur son (déjà dans `pnpm test` et
  `pnpm screenshot`) ; tout script qui lit un média doit faire de même.
- Baileys est non officiel : ne jamais envoyer de message automatisé depuis un vrai compte en test.
- Messages de commit en français, courts, au style des commits existants.

## Flux de travail
- **Aucun commit, rebase, fusion ni push sans l'ordre explicite de l'utilisateur.** Une fois
  l'implémentation prête (`pnpm check` OK, captures faites), installer (`node scripts/install.ts`,
  redémarre le démon), présenter ce qu'il faut tester et attendre sa validation.
- **Une branche par issue** : `git switch -c issue-<numéro>` depuis `main` à jour
  (`git fetch && git merge --ff-only origin/main`). Jamais de commit direct sur `main`.
- **Fusion**, une fois l'issue validée et sur ordre de l'utilisateur :
  1. `git fetch && git rebase origin/main`, puis `pnpm check` ;
  2. `git push origin issue-<numéro>:main` (refusé si `main` a avancé : refaire l'étape 1) ;
  3. `git switch main && git merge --ff-only origin/main && git branch -D issue-<numéro>`.
- Travail en parallèle : un worktree par agent (`wa-gnome-2`, `wa-gnome-3`…), jamais deux agents
  dans le même dossier ; chacun lance son faux démon sur son propre port (`--port`).

## Suivi des fonctionnalités : issues GitHub
Dépôt : https://github.com/maarekj/wa-gnome
- **Chaque fonctionnalité ou correctif a son issue**, créée avant de commencer
  (`gh issue create`), avec le besoin, la solution envisagée et les critères de validation.
- Une issue = un seul agent : avant de commencer, vérifier qu'elle n'est pas déjà prise, puis
  commenter « En cours dans <dossier> » sur l'issue.
- Les commits y font référence (`#12`) ; `Closes #12` dans le commit qui la termine.
- **Quand l'implémentation est finie, commenter l'issue** (`gh issue comment`) avec un
  récapitulatif : ce qui a été fait, comment c'est vérifié (captures, tests), limites connues
  et ce qui n'a pas été testé.
- Les idées non encore planifiées restent dans `TODO.md` jusqu'à leur passage en issue.

# wa-gnome

Client WhatsApp pour GNOME (GTK 4 + libadwaita), non officiel.

- Appairage par QR code (WhatsApp → Appareils connectés), comme WhatsApp Web.
- Liste des discussions en direct, recherche, compteurs de non-lus.
- Conversation : bulles, séparateurs de jour, auteurs dans les groupes, envoi de texte.
- Notifications des nouveaux messages (clic : ouvre la discussion).

L'application (GJS) parle à un démon local (Node + [Baileys](https://github.com/WhiskeySockets/Baileys))
qui garde la connexion WhatsApp et l'historique, même fenêtre fermée.

> Baileys utilise le protocole de WhatsApp Web sans être une API officielle : un usage abusif
> (envois en masse) peut entraîner le bannissement du compte.

## Installation (développement)

```sh
devenv shell
pnpm install
node scripts/install.ts   # démon systemd + lanceur « WhatsApp »
```

Puis lancer « WhatsApp » depuis GNOME et scanner le QR code.

Journal du démon : `journalctl --user -u wa-gnome-daemon -f`.

## Installation avec Nix (NixOS, home-manager)

Essai sans installer : démon dans un terminal (`nix shell github:maarekj/wa-gnome -c wa-gnome-daemon`),
puis l'application (`nix run github:maarekj/wa-gnome`).

Avec home-manager (application, et démon en service systemd utilisateur `wa-gnome-daemon`) :

```nix
# flake.nix
inputs.wa-gnome.url = "github:maarekj/wa-gnome";
# module home-manager
imports = [ inputs.wa-gnome.homeManagerModules.default ];
programs.wa-gnome.enable = true;
```

Paquet seul : `inputs.wa-gnome.packages.${system}.default` (binaires `wa-gnome` et `wa-gnome-daemon`).

## Installation en Flatpak

```sh
devenv shell
pnpm flatpak                # construit dist/wa-gnome.flatpak (--install : l'installe aussi)
flatpak install --user dist/wa-gnome.flatpak
```

Le démon est embarqué : l'application le lance à l'ouverture et l'arrête en quittant (port 4181,
données dans `~/.var/app/io.github.maarekj.WaGnome/`). La transcription (whisper.cpp) est incluse ;
la traduction et le résumé lancent opencode ou claude installés sur la machine
(`flatpak-spawn --host`).

## Feuille de route

Voir les [issues](https://github.com/maarekj/wa-gnome/issues).

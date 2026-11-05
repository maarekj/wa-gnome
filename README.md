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

## À venir

- Médias : affichage des images, téléchargement des documents, envoi de fichiers.
- Réponses, réactions, accusés de lecture affichés, messages modifiés / supprimés.
- Fusion des identifiants LID / numéro de téléphone (WhatsApp ≥ 2025).
- Chargement de l'historique plus ancien (pagination vers le haut).

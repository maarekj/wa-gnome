{ pkgs, ... }:
let
  # Jasmine pour GJS (tests unitaires, `pnpm test`) : ni dans nixpkgs ni sur npm ; construit depuis
  # la version publiée par son auteur (ptomato, mainteneur de GJS). Repris d'opencode-gnome.
  jasmine-gjs = pkgs.stdenv.mkDerivation {
    pname = "jasmine-gjs";
    version = "3.10.1";
    src = pkgs.fetchFromGitHub {
      owner = "ptomato";
      repo = "jasmine-gjs";
      rev = "3.10.1";
      hash = "sha256-lVUd7kicl48T471QcRSUE1R/A0rQ0teAgrX+oHmfUEY=";
    };
    nativeBuildInputs = [ pkgs.meson pkgs.ninja ];
    buildInputs = [ pkgs.gjs ];
    doCheck = false;
    # GJS ≥ 1.80 : Gio.UnixOutputStream a migré dans GioUnix (sinon avertissement à chaque lancement)
    postPatch = ''
      substituteInPlace src/consoleReporter.js \
        --replace-fail "import Gio from 'gi://Gio';" "import Gio from 'gi://Gio';
      import GioUnix from 'gi://GioUnix';" \
        --replace-fail "new Gio.UnixOutputStream(" "new GioUnix.OutputStream("
    '';
  };
  # Chargeurs d'images de GTK : ceux de gdk-pixbuf + WebP (autocollants WhatsApp), réunis dans un
  # seul cache (GDK_PIXBUF_MODULE_FILE ; repris par le lanceur installé).
  pixbuf-loaders = pkgs.runCommand "wa-gnome-pixbuf-loaders" { } ''
    mkdir -p $out
    cat ${pkgs.gdk-pixbuf}/lib/gdk-pixbuf-2.0/2.10.0/loaders.cache \
      ${pkgs.webp-pixbuf-loader}/lib/gdk-pixbuf-2.0/2.10.0/webp-loaders.cache > $out/loaders.cache
  '';
in
{
  env.GDK_PIXBUF_MODULE_FILE = "${pixbuf-loaders}/loaders.cache";
  # schémas GSettings de GTK (sélecteur de fichiers intégré : sans eux, GTK interrompt l'app) ;
  # ajoutés à XDG_DATA_DIRS ici et par le lanceur installé
  env.WA_GNOME_GTK_DATA = "${pkgs.gtk4}/share/gsettings-schemas/${pkgs.gtk4.name}";

  # Node 24 : démon (Baileys, exécuté sans compilation) et outillage (TypeScript, esbuild, oxlint).
  languages.javascript = {
    enable = true;
    package = pkgs.nodejs_24;
    pnpm = {
      enable = true;
      install.enable = true;
    };
  };

  packages = [
    pkgs.gjs # runtime de l'app
    pkgs.gtk4
    pkgs.libadwaita
    pkgs.libsoup_3 # client HTTP/SSE vers le démon
    pkgs.glib
    pkgs.gobject-introspection
    pkgs.curl # debug de l'API du démon
    pkgs.jq
    # captures de l'interface sur un écran virtuel (scripts/screenshot.ts)
    pkgs.xvfb-run
    pkgs.imagemagick
    pkgs.xdotool
    jasmine-gjs # tests unitaires (specs/*.spec.ts)
  ];

  enterShell = ''
    export XDG_DATA_DIRS="$WA_GNOME_GTK_DATA''${XDG_DATA_DIRS:+:$XDG_DATA_DIRS}"
    echo "wa-gnome — node $(node --version), gjs $(gjs --version 2>/dev/null | cut -d' ' -f2)"
  '';
}

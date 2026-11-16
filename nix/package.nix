# Paquet wa-gnome : application GTK (bundlée par esbuild, lancée par gjs) et démon Node (exécuté
# sans compilation, avec les dépendances pnpm de production).
{
  lib,
  stdenv,
  nodejs_24,
  pnpm,
  fetchPnpmDeps,
  pnpmConfigHook,
  makeWrapper,
  wrapGAppsHook4,
  gobject-introspection,
  gjs,
  gtk4,
  libadwaita,
  libsoup_3,
  glib,
  gdk-pixbuf,
  webp-pixbuf-loader,
  librsvg,
  gst_all_1,
  whisper-cpp,
}:
let
  version = (lib.importJSON ../package.json).version;
  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../package.json
      ../pnpm-lock.yaml
      ../pnpm-workspace.yaml
      ../patches
      ../scripts/build.ts
      ../src
      ../data
    ];
  };
in
stdenv.mkDerivation (finalAttrs: {
  pname = "wa-gnome";
  inherit version src;

  pnpmDeps = fetchPnpmDeps {
    inherit (finalAttrs) pname version src;
    inherit pnpm;
    fetcherVersion = 4;
    hash = "sha256-+DDNi+hkZXpe4qA1vLkbSu3XrEkkUDk0Sy6qwEAkxYg=";
  };

  nativeBuildInputs = [
    nodejs_24
    pnpm
    pnpmConfigHook
    makeWrapper
    wrapGAppsHook4
    gobject-introspection
  ];

  buildInputs = [
    gjs
    gtk4
    libadwaita
    libsoup_3
    glib
    gdk-pixbuf
    webp-pixbuf-loader # autocollants WhatsApp
    librsvg # motif du fond des conversations
  ]
  ++ (with gst_all_1; [
    gstreamer
    gst-plugins-base
    gst-plugins-good
    gst-libav
  ]);

  buildPhase = ''
    runHook preBuild
    node scripts/build.ts
    # démon : dépendances de production seules
    rm -rf node_modules
    pnpm install --offline --prod --frozen-lockfile --ignore-scripts
    runHook postBuild
  '';

  # les binaires sont des scripts : enveloppés à la main avec les arguments de wrapGAppsHook4
  dontWrapGApps = true;

  installPhase = ''
    runHook preInstall
    share=$out/share/wa-gnome
    mkdir -p $share/src $out/bin
    cp -r package.json node_modules dist $share/
    cp -r src/daemon src/shared src/cli $share/src/
    rm -f $share/src/daemon/*.test.ts $share/src/cli/*.test.ts

    install -Dm644 data/icons/app.svg $out/share/icons/hicolor/scalable/apps/io.github.maarekj.WaGnome.svg
    install -Dm644 data/icons/app-symbolic.svg $out/share/icons/hicolor/symbolic/apps/io.github.maarekj.WaGnome-symbolic.svg

    mkdir -p $out/share/applications $out/share/dbus-1/services
    cat > $out/share/applications/io.github.maarekj.WaGnome.desktop <<EOF
    [Desktop Entry]
    Type=Application
    Name=WhatsApp
    Comment=Client WhatsApp pour GNOME
    Exec=$out/bin/wa-gnome
    Icon=io.github.maarekj.WaGnome
    Terminal=false
    Categories=Network;InstantMessaging;Chat;
    Keywords=whatsapp;chat;messages;
    StartupNotify=true
    DBusActivatable=true
    EOF
    cat > $out/share/dbus-1/services/io.github.maarekj.WaGnome.service <<EOF
    [D-BUS Service]
    Name=io.github.maarekj.WaGnome
    Exec=$out/bin/wa-gnome --gapplication-service
    EOF

    makeWrapper ${lib.getExe nodejs_24} $out/bin/wa-gnome-daemon \
      --add-flags $share/src/daemon/main.ts
    makeWrapper ${lib.getExe nodejs_24} $out/bin/wa \
      --add-flags $share/src/cli/main.ts
    runHook postInstall
  '';

  postFixup = ''
    makeWrapper ${lib.getExe gjs} $out/bin/wa-gnome \
      "''${gappsWrapperArgs[@]}" \
      --set WA_GNOME_WHISPER ${lib.getExe' whisper-cpp "whisper-cli"} \
      --add-flags "-m $out/share/wa-gnome/dist/app/main.js"
  '';

  meta = {
    description = "Client WhatsApp pour GNOME (GTK 4 + libadwaita, démon Baileys)";
    homepage = "https://github.com/maarekj/wa-gnome";
    platforms = lib.platforms.linux;
    mainProgram = "wa-gnome";
  };
})

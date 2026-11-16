# Module home-manager : application (lanceur, .desktop, service D-Bus, icônes) et démon en
# service systemd utilisateur `wa-gnome-daemon` (connexion WhatsApp, API sur 127.0.0.1:4180).
self:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.programs.wa-gnome;
in
{
  options.programs.wa-gnome = {
    enable = lib.mkEnableOption "wa-gnome, client WhatsApp pour GNOME";
    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.wa-gnome;
      description = "Paquet wa-gnome.";
    };
    logLevel = lib.mkOption {
      type = lib.types.enum [ "fatal" "error" "warn" "info" "debug" "trace" ];
      default = "warn";
      description = "Niveau de journal de Baileys (WA_GNOME_LOG).";
    };
  };

  config = lib.mkIf cfg.enable {
    home.packages = [ cfg.package ];
    systemd.user.services.wa-gnome-daemon = {
      Unit = {
        Description = "Démon WhatsApp (wa-gnome)";
        After = [ "network-online.target" ];
      };
      Service = {
        ExecStart = lib.getExe' cfg.package "wa-gnome-daemon";
        Environment = [ "WA_GNOME_LOG=${cfg.logLevel}" ];
        Restart = "on-failure";
        RestartSec = 5;
      };
      Install.WantedBy = [ "default.target" ];
    };
  };
}

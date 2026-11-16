{
  description = "wa-gnome : client WhatsApp pour GNOME (GTK 4 + libadwaita, démon Baileys)";

  inputs.nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAll = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      packages = forAll (pkgs: rec {
        wa-gnome = pkgs.callPackage ./nix/package.nix { };
        default = wa-gnome;
      });
      overlays.default = final: _prev: { wa-gnome = final.callPackage ./nix/package.nix { }; };
      homeManagerModules.default = import ./nix/home-manager.nix self;
    };
}

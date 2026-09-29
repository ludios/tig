# Model-output: Claude Opus 5.5
#
# tig with syntax-highlighted diffs, for Nix.
#
#   nix run github:ludios/tig             # try it
#   nix profile add github:ludios/tig     # install it
#   nix develop                           # hack on it: make src/tig, make test, ...
{
  description = "tig, the text-mode interface for git, with syntax-highlighted truecolor diffs";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

  outputs =
    { self, nixpkgs }:
    let
      # Linux only, as in meta.platforms of nix/package.nix.
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      for_all_systems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
      tig_for =
        pkgs:
        pkgs.callPackage ./nix/package.nix {
          src = self;
          rev = self.shortRev or self.dirtyShortRev or null;
        };
    in
    {
      packages = for_all_systems (pkgs: rec {
        tig = tig_for pkgs;
        default = tig;
      });

      overlays.default = final: prev: { tig = tig_for final; };

      devShells = for_all_systems (pkgs: {
        default = pkgs.mkShell {
          inputsFrom = [ (tig_for pkgs) ];
          # `node` for running the syntax daemon from source; pnpm comes
          # from the package's build inputs.
          packages = [ pkgs.nodejs-slim_26 ];
        };
      });
    };
}

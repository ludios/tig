# Model-output: Claude Opus 5.5
#
# tig with the syntax-highlighting filter, built from this checkout.  Adapted
# from pkgs/by-name/ti/tig/package.nix in nixpkgs; flake.nix calls it.
{
  lib,
  stdenv,
  fetchPnpmDeps,
  ncurses,
  asciidoc,
  xmlto,
  docbook_xsl,
  docbook_xml_dtd_45,
  readline,
  makeWrapper,
  git,
  libiconv,
  autoreconfHook,
  findXMLCatalogs,
  pkg-config,
  nodejs-slim_26,
  pnpm_11,
  pnpmConfigHook,

  # The tig source tree (the flake's own source).
  src,
  # Abbreviated commit id of `src`, with "-dirty" when it has uncommitted
  # changes; null when unknown (e.g. a `path:` flake).
  rev,
}:

let
  # The last tagged version: the Makefile's `VERSION = x.y.z` line, not the
  # `VERSION = $(COMMIT)...` one it computes in a git checkout.
  base_version = lib.head (
    lib.findFirst (match: match != null) (throw "tig: no `VERSION = x.y.z` line in Makefile") (
      map (builtins.match "VERSION[ \t]*=[ \t]*([0-9.]+)") (
        lib.splitString "\n" (builtins.readFile "${src}/Makefile")
      )
    )
  );
in
stdenv.mkDerivation (finalAttrs: {
  pname = "tig";
  version = base_version + lib.optionalString (rev != null) "-g${rev}";

  inherit src;

  # Without a .git directory, the Makefile would call this plain `x.y.z`;
  # add the commit, as it does itself when `git describe` finds no tag.
  env.DIST_VERSION = finalAttrs.version;

  nativeBuildInputs = [
    makeWrapper
    autoreconfHook
    asciidoc
    xmlto
    docbook_xsl
    docbook_xml_dtd_45
    findXMLCatalogs
    pkg-config
    pnpm_11
    pnpmConfigHook
  ];

  autoreconfFlags = [
    "-I"
    "tools"
    "-v"
  ];

  buildInputs = [
    ncurses
    readline
    git
  ]
  ++ lib.optionals stdenv.hostPlatform.isDarwin [ libiconv ];

  # The syntax-highlighting filter daemon's node dependencies (shiki etc.);
  # installed into tools/tig-syntax-filter/node_modules by pnpmConfigHook.
  # The devDependencies (typescript, vitest, ...) are neither fetched nor
  # installed, as they are not needed at runtime.
  #
  # Whenever tools/tig-syntax-filter/pnpm-lock.yaml changes, update the hash:
  # set it to "", run `nix build`, and copy the hash it reports.  (A stale
  # hash can also surface as `pnpm install` failing to find a package
  # offline, when the old dependencies are still in the store.)
  pnpmRoot = "tools/tig-syntax-filter";
  pnpmInstallFlags = [ "--prod" ];
  pnpmDeps = fetchPnpmDeps {
    inherit (finalAttrs)
      pname
      version
      src
      pnpmInstallFlags
      ;
    pnpm = pnpm_11;
    fetcherVersion = 4;
    sourceRoot = "source/tools/tig-syntax-filter";
    hash = "sha256-AlpWLhycmW0rHnkaiEO2DI4VXq1kAOy1Ij4yQ+E1Jjg=";
  };

  # those files are inherently impure, we'll handle the corresponding dependencies.
  postPatch = ''
    rm contrib/config.make-*

    # A `path:` flake of a work tree also carries its untracked build
    # outputs, which make would take as up to date.
    make clean
    make -C tools/tig-syntax-filter/client clean
    rm -rf tools/tig-syntax-filter/node_modules
  '';

  enableParallelBuilding = true;

  # The C client of the syntax filter is not covered by the top-level make.
  postBuild = ''
    make -C tools/tig-syntax-filter/client CC=$CC
  '';

  installPhase = ''
    runHook preInstall

    make install
    make install-doc

    # fixes tig-completion __git-complete dependency
    sed -i '1s;^;source ${git}/share/bash-completion/completions/git\n;' contrib/tig-completion.bash

    install -D contrib/tig-completion.bash $out/share/bash-completion/completions/tig
    cp contrib/vim.tigrc $out/etc/
    cp contrib/tig-syntax.tigrc $out/etc/

    # Note: Until https://github.com/jonas/tig/issues/940 is resolved it is best
    # not to install the ZSH completion so that the fallback implementation from
    # ZSH can be used (Completion/Unix/Command/_git: "_tig () { _git-log }"):
    #install -D contrib/tig-completion.zsh $out/share/zsh/site-functions/_tig

    # Syntax-highlighting filter: the C client plus the daemon sources with
    # their pnpm-installed node_modules (symlinks into the virtual store
    # must be preserved), minus pnpm's own metadata, which records build
    # timestamps and the sandbox store path.
    rm tools/tig-syntax-filter/node_modules/{.modules.yaml,.pnpm-workspace-state-v1.json}
    filter_root=$out/lib/tig-syntax-filter
    mkdir -p $filter_root
    cp -r tools/tig-syntax-filter/src \
          tools/tig-syntax-filter/themes \
          tools/tig-syntax-filter/package.json \
          tools/tig-syntax-filter/node_modules \
          $filter_root/
    install -Dm755 tools/tig-syntax-filter/bin/tig-syntax-filter \
      $out/bin/tig-syntax-filter

    # The daemon launcher pins the node runtime (node >= 23.6 runs the
    # TypeScript directly) and guarantees git for its cat-file/check-attr
    # calls.  The client finds this launcher next to its own binary.
    makeWrapper ${lib.getExe nodejs-slim_26} $out/bin/tig-syntax-daemon \
      --add-flags "$filter_root/src/daemon.ts" \
      --suffix PATH ':' "${git}/bin"

    # `set diff-syntax-filter = tig-syntax-filter` must find this build's
    # client even when another install's is on PATH, so it stays paired
    # with this tig.  For git, prefer the one in PATH, but add a fallback
    # one in case there isn't one.
    wrapProgram $out/bin/tig \
      --prefix PATH ':' "$out/bin" \
      --suffix PATH ':' "${git}/bin"

    runHook postInstall
  '';

  outputs = [
    "out"
    "doc"
    "man"
  ];

  meta = {
    homepage = "https://github.com/ludios/tig";
    description = "Text-mode interface for git, with syntax-highlighted truecolor diffs";
    license = lib.licenses.gpl2Plus;
    # Only tried on Linux so far; the Darwin libiconv input is upstream's.
    platforms = lib.platforms.linux;
    mainProgram = "tig";
  };
})

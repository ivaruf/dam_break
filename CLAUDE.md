# CLAUDE.md — dam_builder project overrides

These override the global rules in ../CLAUDE.md for THIS repository only.

## Git

- **Allowed**: `git add`, `git commit` (owner-granted, 2026-08-26).
- Everything else in the global restrictions still stands: never `git push`,
  `git pull`, `git merge`, `git rebase`, `git reset`, `git checkout`,
  `git stash`, or anything else that touches remotes or rewrites history.
  The user pushes.

## Release convention

- Bump `VERSION` in `sw.js` with every committed change that will deploy
  (the service worker's opt-in update model depends on it), and keep the
  one-line comment next to it describing the release.
- Commit messages follow the existing style: `vX.Y.Z: short title — detail`.
- Run the tests before committing: `node tests/build.test.js` and `npm test`
  at minimum; the ui-*/levels-* suites when the change touches what they cover.

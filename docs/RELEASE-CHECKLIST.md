# Release checklist (FDR row 89)

Row 89 is Complete when 1.0.0 is published with every item below done. Items marked
**(checked)** are verified by `npm run release:check`, which the Release workflow also runs before it
publishes anything.

## 1. Before tagging

- [ ] **Every other register row is Complete (checked).** What is left as of 0.1.5:
  - Rows 17, 21 and 82: run `npm run perf:reference` on the reference machine and keep
    `test-results/perf.json` (`docs/USER-DECISIONS.md` U-2).
  - Row 88: sign off `docs/SECURITY-REVIEW.md` (U-3), and get the D-1 licensing advice on the GPL-3.0
    DWG reader (U-4). If the advice is to ship its corresponding source or a written offer with the
    app, add it to the release before tagging.
- [ ] Recommended: the checks with your own material in `docs/USER-DECISIONS.md` §B.
- [ ] **Version 1.0.0 everywhere (checked):** `npm version 1.0.0 --no-git-tag-version` sets
      `package.json` and `package-lock.json`; set the FDR's "Current product version" to 1.0.0.
- [ ] **Changelog (checked):** a `## Product version 1.0.0 — <date>` section in `CHANGELOG.md`. It
      becomes the release notes.
- [ ] FDR: row 89 Complete, and a revision-history entry (§12).
- [ ] `npm run release:check` passes locally.
- [ ] Merged into `main` through a pull request, with CI green on `main`.

## 2. Tag and publish

- [ ] Tag the merge commit on `main` and push the tag:

  ```
  git tag -a v1.0.0 -m "Plot Analysis Tool 1.0.0"
  git push origin v1.0.0
  ```

- [ ] The **Release** workflow (GitHub → Actions → Release) runs the release check, lint, type check,
      unit tests, build, the Chromium end-to-end suite and the offline-bundle test on the tagged
      commit, then publishes a GitHub release with:
  - `plot-analysis-tool-1.0.0-offline.zip` (the offline bundle, with `THIRD-PARTY-NOTICES.txt` inside)
  - `plot-analysis-tool-1.0.0-THIRD-PARTY-NOTICES.txt` (licence notices)
  - the changelog section as release notes.

  If any step fails, nothing is published. Fix the cause, delete the tag
  (`git push --delete origin v1.0.0` and `git tag -d v1.0.0`) and tag again.

Tags for 0.x versions publish a GitHub pre-release; the check then lists the rows still Incomplete
instead of refusing.

## 3. After publishing

- [ ] Download the zip from the release page and start it on an air-gapped Windows PC
      (`docs/USER-DECISIONS.md` §B).
- [ ] Hosted mode: check that Cloudflare deployed the `main` commit (U-7).
- [ ] Keep `test-results/perf.json` from the reference run and the signed security review with the
      release records.

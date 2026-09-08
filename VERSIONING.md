# Versioning

`package.json`'s `version` is the source of truth. You bump it by hand, in the PR that makes the
change. Nothing is inferred from commit messages, and CI never writes to the repo — the version that
ships is the one you reviewed.

On merge to `main`, the [release workflow](.github/workflows/release.yml) cuts tag `v<version>` and
a matching [GitHub Release](../../releases) with notes from the changelog. It does **not** deploy.
Shipping is a separate manual step, because a deploy here rewrites a real Last.fm library and those
edits are irreversible — see [deploy/README.md](deploy/README.md).

## Which number to bump

| Bump | When | Examples |
|---|---|---|
| **major** | A breaking change for the person running it, or a generational rewrite | Removing a `RULES_ENABLED` group name; a required new `.env` key; a deploy needing manual DB work |
| **minor** | New user-visible behaviour, a new `/scrub` subcommand, or a new marker group | Shadow mode; custom replacements; the approval gate |
| **patch** | Everything else, including **catalogue changes that only widen what already-enabled rules catch** | Bug fixes, new word forms in an existing group, copy tweaks, refactors, docs, CI, tests |

"Breaking" is about the person running the service, not internal shape: renaming an exported
function is a patch, renaming a group in `RULES_ENABLED` is not.

**A catalogue widening is a patch, but it is not a small change.** New titles start matching, and
the next sweep writes them to Last.fm irreversibly. The version number tracks the interface; the
blast radius is a separate question, and the answer to it is the snapshot and the dry run, not a
bigger number.

## Every merge to `main` bumps

Including docs-only and CI-only PRs — those take a patch. Two reasons: the release step **fails on
a tag that already exists**, so a merge without a bump turns `main` red; and one release per merge
keeps releases and merge commits one-to-one, which is what makes the version a useful answer to
"what is actually running?".

The one exception is a tag that already points at *this* commit — a re-run, or a force-push after a
history rewrite. That is a no-op, not a forgotten bump, and the release step says so and passes.

Put the bump in its own final commit, with the changelog entry for the same version:

```sh
npm version 1.1.0 --no-git-tag-version   # updates package.json + package-lock.json
# add a "## [1.1.0] - YYYY-MM-DD" entry to CHANGELOG.md
git commit -am "chore(release): 1.1.0"
```

**Two open PRs both bumping to the same number will conflict** on that line — whichever merges
second needs a rebase and a re-bump. For stacked work, branch the second PR off the first and bump
past it rather than off `main`.

## Which version is live

- `/scrub status` in Discord — the first line.
- The startup line in journald: `journalctl -u scrubbler | grep 'starting | user' | tail -1`.
- On the box: `node -p "require('/opt/scrubbler/package.json').version"`.
- The deploy workflow's run summary, which reads it back off the box after the restart.

Because the release and the deploy are separate, **the newest tag is not necessarily what is
running.** That is the trade for keeping deploys manual; the three checks above are the truth.

## Versions as rollback targets

Every release tag is a point in time you can check out and deploy by hand. There is deliberately no
rollback-by-tag input on the deploy workflow, unlike feed1's — rolling scrubbler back has two
hazards that need a human reading `deploy/README.md` first:

- **Drizzle is forward-only.** Old code against a newer schema fails silently rather than loudly.
- **An old build does not recognise `awaiting_approval`** and would write the whole pending queue
  with no decision.

Neither is automatable behind a flag today. A change that adds a migration or touches the approval
states is a rollback boundary, which is worth knowing when deciding how much to put in one PR.

## The changelog

The bump commit carries a matching top entry in [CHANGELOG.md](CHANGELOG.md):
`## [x.y.z] - YYYY-MM-DD`, then one `-` bullet per change, newest release first, written for the
person running the service rather than for the diff. A release with nothing user-visible still gets
an entry naming what changed (e.g. "Internal: docs and CI only.") so no released version is missing.
The release step uses the matching section as the GitHub release body, falling back to
`--generate-notes` with a CI warning when a version has no entry.

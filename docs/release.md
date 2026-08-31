# Release Guide

The standard release path is automated GitHub Actions: prepare a release branch and PR, have a human merge it, then CI tags, verifies, publishes, and creates the GitHub Release.

## Stable Release

1. Start from an up-to-date `master` and create `YYYY-MM-DD_release-v<VERSION>`.
2. Update `package.json`'s version, `CHANGELOG.md`, and `CHANGELOG.zh-CN.md` with a `### v<VERSION>` entry.
3. Create the matching `devlog/YYYY-MM-DD_release-v<VERSION>/REQ.md` and `WORKLOG.md`.
4. Run the branch/Devlog/changelog check and package verification.
5. Commit, push, and create the PR.
6. Wait for `pr-validation`, `test`, and `build` checks.
7. A human merges the PR. Agents must not merge it.
8. The push to `master` triggers `release.yml`, which creates the tag, runs `npm ci`, `npm run check:package`, and `npm test`, publishes to npm, and creates the release.

Typical commands:

```bash
./scripts/ci/check-pr.sh YYYY-MM-DD_release-v<VERSION> origin/master
npm run check:package
npm test
```

Confirm the published version and GitHub Release after the workflow completes:

```bash
npm view opencode-acp version
```

## Prerelease

Prerelease versions contain a hyphen, for example `1.13.0-dev.1` or `1.13.0-rc.1`, and use the same release-branch, changelog, Devlog, PR, and human-merge process. CI publishes them to the npm `dev` tag and marks the GitHub Release as a prerelease.

```json
{
    "plugin": {
        "opencode-acp": "dev"
    }
}
```

Promote a prerelease by creating a new stable release branch with the suffix removed.

## Manual Fallback

Only use this when the automated workflow is unavailable or incorrectly configured. Confirm a clean `master` worktree, run `npm run check:package`, audit the package contents with `npm pack --dry-run`, then tag and publish using the repository's documented credentials. Never include `.git/config`, credentials, tokens, or private keys in the npm package.

## Safety

- Never modify the version on a normal feature/fix branch.
- Never force-push `master` or bypass branch protection.
- Never use `gh pr merge`; merging is a human-only operation.
- Keep `CHANGELOG.md`, `CHANGELOG.zh-CN.md`, and the matching Devlog in the release PR.

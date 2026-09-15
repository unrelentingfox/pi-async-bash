# Releasing

## Automated releases

Every push to `main` runs Release Please. It opens or updates a release pull
request from [Conventional Commits](https://github.com/googleapis/release-please#how-should-i-write-my-commits).
Use `feat` for a minor release, `fix` for a patch release, `deps` for a
dependency release, and `!` in the pull request title for a major release.
Merging the release pull request creates the matching GitHub release. The
workflow publishes that version when it is missing from npm, so rerunning a
failed publish is safe.

Repository rules for `main` must require `Validate Conventional Commit title`.
Enable this requirement after the title workflow first lands on `main`.

The `npm` GitHub environment must exist, and npm trusted publishing must
authorize:

- Repository: `unrelentingfox/pi-async-bash`
- Workflow: `release.yml`
- Environment: `npm`

Confirm each release in the GitHub Actions Release run and on npm.

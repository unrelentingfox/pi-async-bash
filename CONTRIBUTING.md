# Contributing

1. Use Node 22.19 or newer and pnpm 10.33.1.
2. Run `pnpm install --frozen-lockfile`.
3. Run `pnpm run check` before opening a pull request.
4. Never commit credentials, environment files, or runtime job logs.

## Commit messages

Use [Release Please Conventional Commits](https://github.com/googleapis/release-please#how-should-i-write-my-commits):

```text
type(scope)!: description
```

The scope and `!` are optional. Use `feat` for a minor release, `fix` for a
patch release, and `deps` for a dependency release. Mark a breaking change
with `!` in the pull request title for a major release. Squash is the only
enabled merge strategy because GitHub uses the pull request title as the final
commit subject. Repository rules must require `Validate Conventional Commit
title` after the workflow first lands on `main`; the check appears only on
subsequent pull requests.

Follow [RELEASING.md](RELEASING.md) for release configuration and operations.

# Contributing

Thanks for contributing to Browser Image Editor.

## Run locally

```sh
bun install
bun run gen
bun run dev
```

## Test

```sh
bun test
```

## Commit style

Use Conventional Commits, for example `feat: add a tool` or `fix: preserve EXIF orientation`.

## Pull request checklist

- [ ] Tests pass with `bun test`.
- [ ] Generated artifacts are current (`bun run gen`).
- [ ] No dependency was added without prior discussion.
- [ ] Changes preserve the client-side privacy model: no uploads, server, or account.

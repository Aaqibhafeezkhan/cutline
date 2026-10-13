# Changesets

Add a changeset for every user-facing change:

```bash
pnpm changeset
```

All `@cutline/*` packages are versioned together. Merging the "Version
Packages" PR opened by the release workflow tags the release and creates a
GitHub Release.

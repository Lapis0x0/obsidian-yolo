# YOLO releases

GitHub Release is the immutable archive. The signed current Feed and the
Cloudflare Pages mirror are generated after publication; never edit or upload
them by hand.

## Core

```bash
npm run release:prepare -- core <version>
# Write latest-release-note.md.
npm run release:check -- core <version>
git push origin main
git tag <version>
git push origin <version>
```

Wait for `Release Obsidian plugin`, then `Reconcile signed update distribution`.

## First-party module

```bash
npm run release:prepare -- module <id> <version>
# Update modules/<id>/module.config.json only when product metadata changes.
# Write modules/<id>/latest-release-note.md.
npm run release:check -- module <id> <version>
git push origin main
git tag <id>/v<version>
git push origin <id>/v<version>
```

All modules use `module-release.yml`. For a coordinated release, publish and
fully distribute Core before tagging modules that need its Host API.

## Automation and recovery

The distribution workflow reconstructs the complete current snapshot from all
published stable Releases. A dispatch only wakes it; manual and hourly runs use
the same reconcile path. Cloudflare failure never removes a Release or the
GitHub Raw Feed fallback. Rerun `distribution-publish.yml`; do not recreate or
overwrite a Release.

Required Actions secrets:

- `DISTRIBUTION_SIGNING_SECRET_KEY`
- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`

Before the first run, create the Direct Upload Pages project `yolo-updates`,
bind `updates.yoloapp.dev`, and add the two Cloudflare secrets. Then run
`distribution-publish.yml` once and verify its summary before releasing the
first Core version that consumes the signed Feed.

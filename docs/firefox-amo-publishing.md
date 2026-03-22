# Firefox AMO Publishing Notes

## Build Targets

- `npm run build:firefox`
  Firefox dev/debug build using `manifest.firefox.json`
- `npm run build:firefox:amo`
  Firefox AMO build using `manifest.firefox.amo.json`
- `npm run package:firefox:amo`
  Creates the AMO submission `.xpi`

## Live Listing

- Firefox Add-ons: https://addons.mozilla.org/en-US/firefox/addon/kekw-blocker/

## Why There Are Two Firefox Manifests

`manifest.firefox.json` remains the dev/debug manifest so temporary installs continue to work with the broader local testing setup.

`manifest.firefox.amo.json` is the submission-targeted manifest and is stricter:

- `strict_min_version` is raised to `140.0`
- built-in Firefox data-collection metadata is declared for AMO review/install disclosure

This avoids weakening the AMO package requirements just to preserve older local dev installs.

## Recommended Submission / Update Checklist

1. Run `npm ci`
2. Run `npm run build:firefox:amo`
3. Run `npm run lint:firefox:amo`
4. Run `npm run package:firefox:amo`
5. Run `npm run package:source`
6. Upload the packaged AMO `.xpi`
7. Upload the source package for review
8. Paste the contents of `docs/amo-review-notes.md` into AMO reviewer notes as needed
9. Use `PRIVACY.md` as the basis for the AMO privacy policy
10. Use `docs/amo-listing.md` as the basis for the AMO listing text

## Current AMO-Oriented Decisions

- Twitch worker reconstruction no longer relies on `eval`
- remote configuration is treated as signed data, not remote code
- AMO-targeted Firefox builds disclose data access more conservatively than the dev build

## Portal-Managed Listing Metadata

These are not generated from the repo automatically and should be maintained in the AMO developer portal:

- listing summary
- full listing description
- screenshots
- support link / support email
- categories / keywords
- privacy-policy URL or pasted privacy-policy content

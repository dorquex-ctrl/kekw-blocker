# AMO Listing Copy

Live listing:

- https://addons.mozilla.org/en-US/firefox/addon/kekw-blocker/

## Current Summary

Twitch ad blocker with self-healing config and playback recovery.

## Current Description

KEKW Blocker is a Twitch-focused ad blocker for Firefox.

It blocks Twitch ads primarily by intercepting Twitch's player worker, requesting backup player variants, and switching to a clean stream when ad markers appear. When Twitch playback becomes unstable around ad transitions, the extension also applies stream recovery logic to reduce stalls, loops, and commercial-break overlays.

Key features:

- backup player switching for pre-roll and mid-roll ads
- adaptive pre-warming to reduce recovery latency
- stitched ad-segment fallback handling
- buffering and commercial-break recovery
- optional ad-tracking blocking
- auto-claim for Twitch channel points
- signed remote configuration with runtime fallback logic to keep Twitch request constants current

This extension is intended only for Twitch pages and related Twitch media endpoints.

## Support / Notes

- Support page: repository issues or project homepage
- Privacy policy: use the contents of `PRIVACY.md` or host that file at a stable public URL

## Permissions / Data Disclosure Notes

Suggested listing-language explanation:

KEKW Blocker needs access to Twitch pages and Twitch media requests so it can detect ad markers, request clean playback variants, and recover playback when Twitch injects ad-related interruptions. It also fetches a signed remote configuration file used to keep Twitch request constants current.

The extension does not send analytics, telemetry, or advertising data to the developer.

## Categories / Keywords

Categories:

- Privacy & Security
- Social & Communication

Keywords:

- twitch
- ad blocker
- streaming
- video
- privacy

## Portal-Managed Listing Metadata

These are maintained manually in the AMO portal rather than generated from this file:

- screenshots
- support URL or support email
- privacy-policy URL or pasted privacy-policy content
- final short summary and long description review

# Changelog

## Unreleased

- Simplified the README copy flow with a rendered helper link and clearer clipboard-copy button labels.

## v1.3.0 - 2026-06-30

- Added `copy.html`, a one-click copy page for the self-check script, public-account script, and both bookmarklets.
- Added a live status bar to the self-check progress overlay.
- Added self-check comparison against Instagram's `follows_viewer` signal, with an optional `compareFollowingFeed` mode to explain differences from simpler unfollower tools.
- Kept final results read-only: the scripts report verified accounts but do not follow, unfollow, message, post, or change the Instagram account.
- Added regression coverage for following-feed hint comparison and copy-page synchronization.
- Regenerated bookmarklets from the current source scripts.

## Project History Before First GitHub Release

- 2026-06-13: Added the public-account checker, public bookmarklet, and scale simulation scripts.
- 2026-06-07: Added safer handling for Instagram rate-limit and HTML response walls.
- 2026-06-07: Added exact follower verification so tentative misses are not counted blindly.
- 2026-06-03: Added one-by-one follow-back checking.
- 2026-05-26: Fixed follow-back false positives.
- 2026-05-20: Made username detection generic and added repository checks.
- 2026-05-20: Initial project release.

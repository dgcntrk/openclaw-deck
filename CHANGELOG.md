# Changelog

## 2026-02-24
- Added a lightweight Vitest regression harness for streaming noise-filter behavior in `src/lib/store.ts`.
- Covered chunked spacing/punctuation preservation, suppression/removal of `NO_REPLY` + `HEARTBEAT_OK`, and non-suppression/disambiguation cases for legitimate `N*`/`H*` user-visible text.

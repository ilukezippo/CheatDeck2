# CheatDeck 2 — Future Work

Tracked here so nothing gets lost between sessions. Nothing in this file is implemented yet.

## 1. Search-result focus/indicator bug (unresolved, deferred)

Pressing search still loses the gamepad focus highlight to the sidebar instead of landing
on the first result. Three separate fix attempts (ref/effect/retry-loop based, in
`src/views/Trainers.tsx`) all failed to hold focus reliably against SteamUI's own async
"restore focus" pass. Needs a fresh approach — worth checking whether newer `@decky/ui`
releases expose a more direct focus-restoration hook before trying another timing-based
workaround.

## 2. Auto-set Steam Play compatibility tool to Steam Tinker Launch after download

Today, after a trainer is downloaded and set as the Sidecar Program, the user still has to
manually go to the game's Properties → Compatibility → "Force the use of a specific Steam
Play compatibility tool" → Steam Tinker Launch. Goal: do this automatically as part of
`download_trainer()` / the frontend download flow.

Direction: `src/infra/steam.ts` already calls `SteamClient.Apps.SetAppLaunchOptions` for
launch options — there's very likely an equivalent `SteamClient.Apps` method for setting
the per-app compat tool override (community references call it something like
`SpecifyCompatTool`, unconfirmed exact signature — check the SteamClient TS typings at
docs.steambrew.app before implementing). Requires Steam Tinker Launch to already be
installed as a compat tool on the system; the plugin should detect whether it's installed
and skip/notify rather than fail silently if it isn't.

## 3. Ideas for future features (not yet requested/approved — for discussion)

- **Downloaded Trainers manager** — a list of previously downloaded trainers (per game or
  global) to re-attach or delete without re-searching/re-downloading from flingtrainer.com.
- **Stale-trainer warning** — trainers often break after a game update; warn if the
  attached trainer predates the game's last update.
- **Deeper Steam Tinker Launch integration** — beyond just setting the compat tool (item 2),
  pre-populate STL's own per-game config with the sidecar exe. STL is purpose-built for this
  and might be a more reliable fix for the documented Proton `PROTON_REMOTE_DEBUG_CMD` hook
  issue (GloriousEggroll/proton-ge-custom#664) than the current wrapper-script workaround.
- **Search result caching** — avoid re-hitting flingtrainer.com for a repeat search of the
  same game within some TTL.
- **Cleanup action** — a button to clear the Sidecar Program setting and delete the
  downloaded trainer file together, to keep `Downloads/CheatDeck 2/` tidy.
- **In-plugin log/troubleshooting view** — surface recent download/search errors in Settings
  so users don't need SSH/Konsole access to debug a failed download.
- **Alternate trainer sources** (WeMod, Cheat Engine tables) — much larger effort, only
  worth considering if FLiNG coverage turns out to be a frequent gap.

import { ButtonItem, Field, Focusable, PanelSection, PanelSectionRow, SteamSpinner, TextField } from "@decky/ui";
import { type FC, useEffect, useRef, useState } from "react";
import { FaArrowLeft, FaCheck } from "react-icons/fa6";

import { sidecarProgram } from "../domain/features";
import { findSteamTinkerLaunch } from "../domain/steamTinkerLaunch";
import { useOptions, useSidecarWrapperPath, useTrainersState } from "../hooks";
import { sendNotice, type TrainerDownloadOption, type TrainerSearchResult, trainers } from "../infra/decky";
import { getAvailableCompatTools, specifyCompatTool } from "../infra/steam";
import { t } from "../utils/translate";

// FLiNG Trainer (https://flingtrainer.com) search + download, run entirely
// from the plugin's Python backend (see main.py) so the user never has to
// leave Gaming Mode to find a trainer. The downloaded .exe is attached the
// same way as a manually browsed Sidecar Program (domain/features.ts), so it
// benefits from the same Wine-fallback launch reliability.
//
// Search/selection state itself lives in TrainersStateProvider (see
// hooks/useTrainersState.tsx), not in this component's own useState - decky's
// SidebarNavigation unmounts this whole view whenever the user switches to
// another tab (Normal/Advanced/Custom) and remounts it fresh on return,
// which would otherwise silently wipe any results the user had already
// found.

// SteamUI's own native loading animation (resolved out of its webpack
// bundle, same pattern as Focusable - see @decky/ui/dist/components/
// SteamSpinner.js's findModuleExport call) rather than @decky/ui's plain
// `Spinner`, which is just a small static icon. Sized down to sit inline in
// a button's text slot, the same spot the icon spinner occupied.
const BusySpinner: FC = () => <SteamSpinner style={{ width: "1.5em", height: "1.5em" }} />;

const Trainers: FC = () => {
  const { options, appid, applyEdit } = useOptions();
  const wrapperPath = useSidecarWrapperPath();
  const { query, setQuery, results, setResults, selection, setSelection, statusMessage, setStatusMessage } =
    useTrainersState();
  // Tracks which action is in flight, not just whether one is, so the Search
  // button's own spinner only appears while a search is actually running -
  // not while a game's downloads are loading or a download is in progress,
  // both of which now show their own spinner on their own button instead.
  const [busyAction, setBusyAction] = useState<"search" | "open" | "download" | null>(null);
  const busy = busyAction !== null;
  // Which specific download is currently in flight, so only that row's
  // button swaps to a spinner - busyAction alone can't tell the rows apart.
  const [activeDownloadUrl, setActiveDownloadUrl] = useState<string | undefined>(undefined);
  // Lets a stale openGame() response (the user pressed Back before it
  // resolved) recognize itself and skip applying its result - see the
  // "Third update" note below.
  const openGameRequestRef = useRef<string | undefined>(undefined);

  // Each of the three panels below (search form / results list / downloads
  // list) used to be wrapped in its *own* <Focusable>, mounted/unmounted as
  // `view` changed. That's different from every other tab in this plugin
  // (Normal/Advanced/Custom - see their return statements), which each wrap
  // their whole tab in exactly one <Focusable> that's never conditionally
  // unmounted, and none of them have this bug. The reason that difference
  // matters: `Focusable` isn't a plain styling wrapper - it's resolved at
  // runtime straight out of SteamUI's own webpack bundle (see
  // @decky/ui/dist/components/Focusable.js's findModuleExport call), so it
  // *is* SteamUI's real gamepad-navigation-tree node, not a cosmetic div.
  // Destroying and recreating that registered node on every view change (as
  // the old per-view wrapper did) leaves a real gap in SteamUI's nav tree
  // for a moment - its own "restore focus" pass runs somewhere in that gap
  // and, finding nothing to land on, commits the highlight to the Quick
  // Access Menu's sidebar. A brand new Focusable mounting moments later
  // doesn't reclaim it, no matter how long a manual .focus() call waits
  // (three earlier attempts here all only ever tuned that wait). So this
  // version keeps exactly the one persistent, never-unmounted <Focusable>
  // for the whole tab (below, same as every working tab) and swaps the
  // per-view *content* as plain <div>/fragment children instead of separate
  // Focusables - a plain <div> doesn't register with SteamUI at all, so
  // there's nothing for it to lose when the results/selection list swaps.
  //
  // A per-item Focusable around each panel's first real row (not the "Back"
  // button above it) is still used, same pattern every other tab already
  // relies on for a single item - and SteamUI still doesn't always move its
  // own highlight onto a freshly mounted child on its own, so the retry loop
  // below nudges a manual .focus() onto it, timed to run after SteamUI's own
  // async restore pass rather than racing it (the ~100ms figure matches
  // SDH-CssLoader's ThemeBrowserPage.tsx, a shipped Decky plugin with the
  // same list-refresh timing problem).
  //
  // Update, confirmed on real hardware: the fix above (one persistent outer
  // Focusable, plain div/fragment content) wasn't the whole story. The
  // search form's TextField and "Search" ButtonItem are themselves real
  // SteamUI-registered controls (same as any other TextField/ButtonItem in
  // this plugin), not cosmetic - so conditionally unmounting the whole form
  // the moment results.length > 0 (the previous behavior) still tore down
  // and recreated registered nav nodes on every search, same class of
  // problem as the outer-Focusable churn, just one level in. The form
  // (formRef's div, with the TextField + Search button) now stays mounted
  // continuously across both the empty and results states - only `!selection`
  // gates it, not `results.length === 0` - so a search only adds the results
  // list below it instead of unmounting the form to show them. (Superseded
  // by the "Second update" below, which drops the `!selection` gate too.)
  //
  // Caveat: gamepad focus/highlight behavior can only really be verified on
  // real Deck hardware with a controller. If it's still wrong, the next
  // thing to check is whether PanelSection itself is quietly reintroducing a
  // similar mount/unmount, since it also isn't a plain div.
  //
  // Second update: the same reasoning now applies to the "selection"
  // (per-game downloads) view too - it used to swap the form out entirely,
  // which meant leaving a search's results to look at a game's downloads
  // (and coming back) tore down and rebuilt the TextField/Search button pair
  // a second time. The form div is now unconditionally mounted (no `!selection`
  // gate) for all three states, and a single persistent "Back" ButtonItem
  // lives inside it too (replacing the two separate Back buttons that used
  // to live inside the results/selection blocks), so the only thing that
  // ever mounts/unmounts per view is the plain <Field> separator and the
  // results/downloads list below it - neither of which is a real
  // SteamUI-registered control, so there's nothing there for the nav tree to
  // lose.
  //
  // Third update: `disabled` turned out to be its own version of the same
  // bug. Clicking a result to open its downloads (or clicking a download to
  // fetch it) set a shared `busy` flag that disabled every control in the
  // top box (search/search-button/back) *and* every row in the list below,
  // including the row the user had just pressed - i.e. the row that
  // currently held focus. A disabled control can't hold focus, so SteamUI's
  // nav tree loses its anchor exactly like the unmount case above, just
  // triggered by a prop flip instead of a mount/unmount. Fix: nothing is
  // ever disabled because of an in-flight fetch anymore. The Search button
  // and TextField only disable for the input-validity case (empty query),
  // the Back button only disables when there's genuinely nowhere to go back
  // to, and list rows are never disabled - re-entrancy is prevented by the
  // `if (busy) return` guard already at the top of each handler, not by the
  // `disabled` prop. Busy state is now communicated purely by swapping
  // content (a `SteamSpinner` in place of the results list while a game's
  // downloads are loading - the "loading" view below - and a per-row
  // spinner via `activeDownloadUrl` while that specific download runs),
  // never by disabling something that might be focused.
  const view = selection ? "selection" : busyAction === "open" ? "loading" : results.length > 0 ? "results" : "form";
  const formRef = useRef<HTMLDivElement>(null);
  const firstResultRef = useRef<HTMLDivElement>(null);
  const firstDownloadRef = useRef<HTMLDivElement>(null);
  const loadingRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = { form: formRef, results: firstResultRef, selection: firstDownloadRef, loading: loadingRef }[view]
      .current;
    if (!container) return;
    const target = container.querySelector<HTMLElement>("[tabindex]") ?? container;

    let attempt = 0;
    let timer: ReturnType<typeof setTimeout>;
    const tryFocus = () => {
      target.focus();
      attempt += 1;
      if (document.activeElement !== target && attempt < 6) {
        timer = setTimeout(tryFocus, 100);
      }
    };
    timer = setTimeout(tryFocus, 100);
    return () => clearTimeout(timer);
  }, [view]);

  const reset = () => {
    setResults([]);
    setSelection(undefined);
    setStatusMessage(undefined);
  };

  // Single handler for the one persistent Back button: steps out of the
  // downloads list to the results (if a game is selected), otherwise clears
  // the results back to the empty form.
  const goBack = () => {
    // Invalidate any in-flight openGame() request so its response is
    // ignored if it resolves after the user has already navigated away.
    openGameRequestRef.current = undefined;
    if (selection) {
      setSelection(undefined);
    } else {
      reset();
      if (busyAction === "open") setBusyAction(null);
    }
  };

  const runSearch = async () => {
    const trimmed = query.trim();
    if (trimmed.length === 0 || busy) return;
    setBusyAction("search");
    setStatusMessage(undefined);
    try {
      const found = await trainers.search(trimmed);
      // A new search always replaces whatever was being browsed, even if the
      // user ran it while looking at a specific game's downloads.
      setSelection(undefined);
      setResults(found);
      if (found.length === 0) setStatusMessage(t("TRAINERS_NO_RESULTS"));
    } catch {
      setStatusMessage(t("TRAINERS_SEARCH_ERROR"));
    } finally {
      setBusyAction(null);
    }
  };

  const openGame = async (game: TrainerSearchResult) => {
    if (busy) return;
    openGameRequestRef.current = game.url;
    setBusyAction("open");
    setStatusMessage(undefined);
    try {
      const downloads = await trainers.listDownloads(game.url);
      // The user may have pressed Back while this was in flight - don't
      // resurrect a selection (or an error/empty message) for a request
      // they've already backed out of.
      if (openGameRequestRef.current !== game.url) return;
      if (downloads.length === 0) {
        setStatusMessage(t("TRAINERS_NO_RESULTS"));
        return;
      }
      setSelection({ game, downloads });
    } catch {
      if (openGameRequestRef.current === game.url) setStatusMessage(t("TRAINERS_SEARCH_ERROR"));
    } finally {
      // Always clear busy, even for a stale request, so the UI never gets
      // stuck "busy" after the user has already navigated away.
      setBusyAction(null);
    }
  };

  const downloadLabel = (download: TrainerDownloadOption) => (
    <>
      {download.label}
      {download.downloaded && (
        <FaCheck title={t("TRAINERS_ALREADY_DOWNLOADED")} color="#2ecc71" style={{ marginLeft: "0.5em" }} />
      )}
    </>
  );

  // Mirrors what Properties > Compatibility > "Force the use of a specific
  // Steam Play compatibility tool" > Steam Tinker Launch does manually -
  // GetAvailableCompatTools/SpecifyCompatTool are the actual SteamClient
  // methods behind that checkbox (see infra/steam.ts). Best-effort: a
  // missing/renamed tool, or the call itself failing, just means the
  // trainer stays attached without STL forced on it rather than failing the
  // whole download - the caller decides what to tell the user based on the
  // boolean result instead of this throwing.
  const trySetSteamTinkerLaunch = async (targetAppid: number): Promise<boolean> => {
    try {
      const tools = await getAvailableCompatTools(targetAppid);
      const tool = findSteamTinkerLaunch(tools);
      if (!tool) return false;
      specifyCompatTool(targetAppid, tool.strToolName);
      return true;
    } catch {
      return false;
    }
  };

  const downloadAndAttach = async (download: TrainerDownloadOption) => {
    if (busy || !selection) return;
    const game = selection.game;
    setBusyAction("download");
    setActiveDownloadUrl(download.url);
    setStatusMessage(t("TRAINERS_DOWNLOADING"));
    try {
      const result = await trainers.download(download.url, appid, selection.game.title, download.label);
      if (!result.ok || !result.path) {
        setStatusMessage(result.error ?? t("TRAINERS_DOWNLOAD_ERROR"));
        return;
      }
      const edit = sidecarProgram.set(options, result.path, wrapperPath);
      if (!edit.ok || !applyEdit(edit)) {
        setStatusMessage(t("TRAINERS_DOWNLOAD_ERROR"));
        return;
      }

      const stlSet = await trySetSteamTinkerLaunch(appid);
      sendNotice(stlSet ? t("TRAINERS_DOWNLOAD_SUCCESS_STL") : t("TRAINERS_DOWNLOAD_SUCCESS"));
      // Stay on this game's downloads screen instead of resetting back to
      // the empty form - the user may want to grab a different version, or
      // just wants confirmation this one attached. Mark this specific
      // download as downloaded (the same flag `downloadLabel` already
      // checks to show a checkmark) rather than re-fetching the list.
      // Guarded by game URL in case the user opened a different game while
      // this download was still running.
      setSelection((current) =>
        current && current.game.url === game.url
          ? {
              ...current,
              downloads: current.downloads.map((item) =>
                item.url === download.url ? { ...item, downloaded: true } : item,
              ),
            }
          : current,
      );
      // Told as a persistent panel message rather than only the toast above
      // (which disappears after ~2s) - the user may want to go install STL,
      // so this stays up until their next search.
      setStatusMessage(stlSet ? undefined : t("TRAINERS_STL_NOT_FOUND"));
    } catch {
      setStatusMessage(t("TRAINERS_DOWNLOAD_ERROR"));
    } finally {
      setBusyAction(null);
      setActiveDownloadUrl(undefined);
    }
  };

  return (
    <Focusable style={{ display: "flex", flexDirection: "column" }}>
      <PanelSection title={t("TRAINERS_TITLE")}>
        <PanelSectionRow>
          <Field description={t("TRAINERS_SOURCE_DESC")} padding="standard" bottomSeparator="none" />
        </PanelSectionRow>

        <div ref={formRef} style={{ display: "flex", flexDirection: "column" }}>
          <PanelSectionRow>
            <TextField
              label={t("TRAINERS_SEARCH_LABEL")}
              description={t("TRAINERS_SEARCH_PLACEHOLDER")}
              value={query}
              disabled={busyAction === "search"}
              onChange={(event) => setQuery(event.target.value)}
            />
          </PanelSectionRow>
          <PanelSectionRow>
            <ButtonItem layout="below" disabled={query.trim().length === 0} onClick={() => void runSearch()}>
              {busyAction === "search" ? <BusySpinner /> : t("TRAINERS_SEARCH_BUTTON")}
            </ButtonItem>
          </PanelSectionRow>
          <PanelSectionRow>
            <ButtonItem layout="below" disabled={!selection && results.length === 0} onClick={goBack}>
              <FaArrowLeft /> {t("TRAINERS_BACK")}
            </ButtonItem>
          </PanelSectionRow>
        </div>

        {view !== "form" && (
          <PanelSectionRow>
            <Field padding="none" bottomSeparator="standard" />
          </PanelSectionRow>
        )}

        {view === "loading" && (
          <PanelSectionRow>
            <Focusable ref={loadingRef} style={{ display: "flex", justifyContent: "center", padding: "1.5em 0" }}>
              <SteamSpinner style={{ width: "3em", height: "3em" }} />
            </Focusable>
          </PanelSectionRow>
        )}

        {view === "results" &&
          results.map((result, index) =>
            index === 0 ? (
              <PanelSectionRow key={result.url}>
                <Focusable ref={firstResultRef}>
                  <ButtonItem layout="below" onClick={() => void openGame(result)}>
                    {result.title}
                  </ButtonItem>
                </Focusable>
              </PanelSectionRow>
            ) : (
              <PanelSectionRow key={result.url}>
                <ButtonItem layout="below" onClick={() => void openGame(result)}>
                  {result.title}
                </ButtonItem>
              </PanelSectionRow>
            ),
          )}

        {selection && (
          <>
            <PanelSectionRow>
              <Field label={t("TRAINERS_SELECT_VERSION")} description={selection.game.title} padding="none" />
            </PanelSectionRow>
            {selection.downloads.map((download, index) =>
              index === 0 ? (
                <PanelSectionRow key={download.url}>
                  <Focusable ref={firstDownloadRef}>
                    <ButtonItem layout="below" onClick={() => void downloadAndAttach(download)}>
                      {activeDownloadUrl === download.url ? <BusySpinner /> : downloadLabel(download)}
                    </ButtonItem>
                  </Focusable>
                </PanelSectionRow>
              ) : (
                <PanelSectionRow key={download.url}>
                  <ButtonItem layout="below" onClick={() => void downloadAndAttach(download)}>
                    {activeDownloadUrl === download.url ? <BusySpinner /> : downloadLabel(download)}
                  </ButtonItem>
                </PanelSectionRow>
              ),
            )}
          </>
        )}

        {statusMessage && (
          <PanelSectionRow>
            <Field description={statusMessage} padding="standard" bottomSeparator="none" />
          </PanelSectionRow>
        )}
      </PanelSection>
    </Focusable>
  );
};

export default Trainers;

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
  const [busy, setBusy] = useState(false);

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
  // list below it instead of unmounting the form to show them. The deeper
  // "selection" (per-game downloads) view still swaps out the form, since
  // that's a distinct step the user takes deliberately, not part of the
  // same search-and-see-a-list flow.
  //
  // Caveat: gamepad focus/highlight behavior can only really be verified on
  // real Deck hardware with a controller. If it's still wrong, the next
  // thing to check is whether PanelSection itself is quietly reintroducing a
  // similar mount/unmount, since it also isn't a plain div.
  const view = selection ? "selection" : results.length > 0 ? "results" : "form";
  const formRef = useRef<HTMLDivElement>(null);
  const firstResultRef = useRef<HTMLDivElement>(null);
  const firstDownloadRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = { form: formRef, results: firstResultRef, selection: firstDownloadRef }[view].current;
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

  const runSearch = async () => {
    const trimmed = query.trim();
    if (trimmed.length === 0 || busy) return;
    setBusy(true);
    setStatusMessage(undefined);
    try {
      const found = await trainers.search(trimmed);
      setResults(found);
      if (found.length === 0) setStatusMessage(t("TRAINERS_NO_RESULTS"));
    } catch {
      setStatusMessage(t("TRAINERS_SEARCH_ERROR"));
    } finally {
      setBusy(false);
    }
  };

  const openGame = async (game: TrainerSearchResult) => {
    if (busy) return;
    setBusy(true);
    setStatusMessage(undefined);
    try {
      const downloads = await trainers.listDownloads(game.url);
      if (downloads.length === 0) {
        setStatusMessage(t("TRAINERS_NO_RESULTS"));
        return;
      }
      setSelection({ game, downloads });
    } catch {
      setStatusMessage(t("TRAINERS_SEARCH_ERROR"));
    } finally {
      setBusy(false);
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
    setBusy(true);
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
      setQuery("");
      reset();
      // Told as a persistent panel message rather than only the toast above
      // (which disappears after ~2s) - the user may want to go install STL,
      // so this stays up until their next search.
      if (!stlSet) {
        setStatusMessage(t("TRAINERS_STL_NOT_FOUND"));
      }
    } catch {
      setStatusMessage(t("TRAINERS_DOWNLOAD_ERROR"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Focusable style={{ display: "flex", flexDirection: "column" }}>
      <PanelSection title={t("TRAINERS_TITLE")}>
        <PanelSectionRow>
          <Field description={t("TRAINERS_SOURCE_DESC")} padding="standard" bottomSeparator="none" />
        </PanelSectionRow>

        {!selection && (
          <div ref={formRef} style={{ display: "flex", flexDirection: "column" }}>
            <PanelSectionRow>
              <TextField
                label={t("TRAINERS_SEARCH_LABEL")}
                description={t("TRAINERS_SEARCH_PLACEHOLDER")}
                value={query}
                disabled={busy}
                onChange={(event) => setQuery(event.target.value)}
              />
            </PanelSectionRow>
            <PanelSectionRow>
              <ButtonItem layout="below" disabled={busy || query.trim().length === 0} onClick={() => void runSearch()}>
                {busy ? <BusySpinner /> : t("TRAINERS_SEARCH_BUTTON")}
              </ButtonItem>
            </PanelSectionRow>
          </div>
        )}

        {!selection && results.length > 0 && (
          <>
            <PanelSectionRow>
              <ButtonItem layout="below" disabled={busy} onClick={reset}>
                <FaArrowLeft /> {t("TRAINERS_BACK")}
              </ButtonItem>
            </PanelSectionRow>
            {results.map((result, index) =>
              index === 0 ? (
                <PanelSectionRow key={result.url}>
                  <Focusable ref={firstResultRef}>
                    <ButtonItem layout="below" disabled={busy} onClick={() => void openGame(result)}>
                      {result.title}
                    </ButtonItem>
                  </Focusable>
                </PanelSectionRow>
              ) : (
                <PanelSectionRow key={result.url}>
                  <ButtonItem layout="below" disabled={busy} onClick={() => void openGame(result)}>
                    {result.title}
                  </ButtonItem>
                </PanelSectionRow>
              ),
            )}
          </>
        )}

        {selection && (
          <>
            <PanelSectionRow>
              <ButtonItem layout="below" disabled={busy} onClick={() => setSelection(undefined)}>
                <FaArrowLeft /> {t("TRAINERS_BACK")}
              </ButtonItem>
            </PanelSectionRow>
            <PanelSectionRow>
              <Field label={t("TRAINERS_SELECT_VERSION")} description={selection.game.title} padding="none" />
            </PanelSectionRow>
            {selection.downloads.map((download, index) =>
              index === 0 ? (
                <PanelSectionRow key={download.url}>
                  <Focusable ref={firstDownloadRef}>
                    <ButtonItem layout="below" disabled={busy} onClick={() => void downloadAndAttach(download)}>
                      {busy ? <BusySpinner /> : downloadLabel(download)}
                    </ButtonItem>
                  </Focusable>
                </PanelSectionRow>
              ) : (
                <PanelSectionRow key={download.url}>
                  <ButtonItem layout="below" disabled={busy} onClick={() => void downloadAndAttach(download)}>
                    {busy ? <BusySpinner /> : downloadLabel(download)}
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

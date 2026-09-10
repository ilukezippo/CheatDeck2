import { ButtonItem, Field, Focusable, PanelSection, PanelSectionRow, Spinner, TextField } from "@decky/ui";
import { type FC, useEffect, useRef, useState } from "react";
import { FaArrowLeft } from "react-icons/fa6";

import { sidecarProgram } from "../domain/features";
import { useOptions, useSidecarWrapperPath, useTrainersState } from "../hooks";
import { sendNotice, type TrainerDownloadOption, type TrainerSearchResult, trainers } from "../infra/decky";
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
const Trainers: FC = () => {
  const { options, appid, applyEdit } = useOptions();
  const wrapperPath = useSidecarWrapperPath();
  const { query, setQuery, results, setResults, selection, setSelection, statusMessage, setStatusMessage } =
    useTrainersState();
  const [busy, setBusy] = useState(false);

  // Each of the three panels below (search form / results list / downloads
  // list) replaces the previous one in the DOM rather than just updating it,
  // so the item that had gamepad focus (e.g. the "Search" button) is
  // unmounted out from under the focus system. SteamUI then has nothing to
  // fall back to and kicks the highlight all the way out to the Quick Access
  // Menu's own side navigation, forcing the user to press right just to get
  // back into the panel. Wrapping the first real entry of each new panel
  // (not the "Back" button above it) in its own Focusable, and focusing that
  // once it mounts, keeps the highlight where the user's attention already
  // is - `Focusable` is @decky/ui's actual typed, ref-forwarding container
  // (unlike ButtonItem, which doesn't forward refs), so it's the one thing
  // here that's safe to attach a ref to and call .focus() on directly.
  //
  // The hard part is timing: SteamUI runs its own "restore focus" pass after
  // a DOM change, asynchronously, so a call made in the same tick (or even
  // the next animation frame) loses the race and gets silently overwritten -
  // confirmed by SDH-CssLoader (a widely-used, shipped Decky plugin with
  // this exact list-refresh problem: see ThemeBrowserPage.tsx), whose fix is
  // a real setTimeout of ~100ms so it runs *after* SteamUI's own pass rather
  // than racing it. The retry loop below is a safety net in case that pass
  // is slower still, and stops as soon as focus actually lands (or after a
  // few tries).
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
      sendNotice(t("TRAINERS_DOWNLOAD_SUCCESS"));
      setQuery("");
      reset();
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

        {!selection && results.length === 0 && (
          <Focusable ref={formRef} style={{ display: "flex", flexDirection: "column" }}>
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
                {busy ? <Spinner /> : t("TRAINERS_SEARCH_BUTTON")}
              </ButtonItem>
            </PanelSectionRow>
          </Focusable>
        )}

        {!selection && results.length > 0 && (
          <Focusable style={{ display: "flex", flexDirection: "column" }}>
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
          </Focusable>
        )}

        {selection && (
          <Focusable style={{ display: "flex", flexDirection: "column" }}>
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
                      {busy ? <Spinner /> : download.label}
                    </ButtonItem>
                  </Focusable>
                </PanelSectionRow>
              ) : (
                <PanelSectionRow key={download.url}>
                  <ButtonItem layout="below" disabled={busy} onClick={() => void downloadAndAttach(download)}>
                    {busy ? <Spinner /> : download.label}
                  </ButtonItem>
                </PanelSectionRow>
              ),
            )}
          </Focusable>
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

import {
  createContext,
  type Dispatch,
  type FC,
  type ReactNode,
  type SetStateAction,
  useContext,
  useEffect,
  useState,
} from "react";

import { type TrainerDownloadOption, type TrainerSearchResult, trainers } from "../infra/decky";
import { trainerMemory } from "../infra/trainerMemory";
import { useOptions } from "./useOptions";

export interface TrainersSelection {
  game: TrainerSearchResult;
  downloads: TrainerDownloadOption[];
}

interface TrainersStateContextProps {
  query: string;
  setQuery: Dispatch<SetStateAction<string>>;
  results: TrainerSearchResult[];
  setResults: Dispatch<SetStateAction<TrainerSearchResult[]>>;
  selection: TrainersSelection | undefined;
  setSelection: Dispatch<SetStateAction<TrainersSelection | undefined>>;
  statusMessage: string | undefined;
  setStatusMessage: Dispatch<SetStateAction<string | undefined>>;
}

const TrainersStateContext = createContext<TrainersStateContextProps | undefined>(undefined);

// decky's SidebarNavigation (see PageRouter.tsx) only keeps the *active*
// tab's content mounted - switching from "Trainers" to "Advanced" and back
// unmounts and remounts the Trainers view, which would silently wipe any
// search results/selection kept in its own useState (user report: search,
// press down into the sidebar to reach "Advanced", come back to "Trainers"
// and the results are gone). Holding that state here instead, in a provider
// mounted once above SidebarNavigation (see PageRouter.tsx) rather than
// inside the tab itself, means it survives the tab's unmount/remount cycle -
// it only resets when OptionsProvider itself does, i.e. when CheatDeck is
// opened for a different game.
export const TrainersStateProvider: FC<{ children: ReactNode }> = ({ children }) => {
  const { appid, gameName } = useOptions();

  // Pre-fill the search box with the current game's title, same as before -
  // this only runs once, on first mount (i.e. the first time the user opens
  // the Trainers tab for this game), so a query the user already typed or
  // searched isn't clobbered by revisiting the tab.
  const [query, setQuery] = useState(gameName);
  const [results, setResults] = useState<TrainerSearchResult[]>([]);
  const [selection, setSelection] = useState<TrainersSelection | undefined>();
  const [statusMessage, setStatusMessage] = useState<string | undefined>();

  // Restore whatever game's downloads list this appid last had open (see
  // infra/trainerMemory.ts), so closing and reopening CheatDeck's overlay
  // for the same game lands back on the downloads list - checkmarks and
  // all - instead of the empty search form. Only runs once per mount (this
  // provider itself only remounts when OptionsProvider does, i.e. for a new
  // game - see the comment above), and only if nothing's already selected,
  // so it can't clobber a selection the user already made this session.
  // Re-fetches via listDownloads rather than trusting a cached list, since
  // that's also what keeps the "already downloaded" checkmarks accurate.
  // Best-effort: any failure here just leaves the user on the empty form,
  // same as if nothing had ever been remembered.
  useEffect(() => {
    let active = true;
    trainerMemory
      .getForApp(appid)
      .then(async (remembered) => {
        if (!active || !remembered) return;
        const downloads = await trainers.listDownloads(remembered.url);
        if (active && downloads.length > 0) {
          setSelection({ game: remembered, downloads });
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [appid]);

  // Keep the memory in sync whenever a selection is (or becomes) a
  // particular game - covers both opening a game fresh and the download
  // handler's own setSelection updater (which keeps the same game, so this
  // only actually re-persists when the game itself changes).
  useEffect(() => {
    if (!selection) return;
    void trainerMemory.setForApp(appid, selection.game);
  }, [appid, selection?.game.url, selection?.game.title]);

  return (
    <TrainersStateContext.Provider
      value={{ query, setQuery, results, setResults, selection, setSelection, statusMessage, setStatusMessage }}
    >
      {children}
    </TrainersStateContext.Provider>
  );
};

export const useTrainersState = (): TrainersStateContextProps => {
  const context = useContext(TrainersStateContext);
  if (!context) throw new Error("useTrainersState must be used within a TrainersStateProvider");
  return context;
};

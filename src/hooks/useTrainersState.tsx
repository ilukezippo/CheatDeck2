import {
  createContext,
  type Dispatch,
  type FC,
  type ReactNode,
  type SetStateAction,
  useContext,
  useState,
} from "react";

import type { TrainerDownloadOption, TrainerSearchResult } from "../infra/decky";
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
  const { gameName } = useOptions();

  // Pre-fill the search box with the current game's title, same as before -
  // this only runs once, on first mount (i.e. the first time the user opens
  // the Trainers tab for this game), so a query the user already typed or
  // searched isn't clobbered by revisiting the tab.
  const [query, setQuery] = useState(gameName);
  const [results, setResults] = useState<TrainerSearchResult[]>([]);
  const [selection, setSelection] = useState<TrainersSelection | undefined>();
  const [statusMessage, setStatusMessage] = useState<string | undefined>();

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

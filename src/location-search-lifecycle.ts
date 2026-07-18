export type LocationSearchState<Result> = {
  results: Result[];
  isLoadingSearch: boolean;
  searchError: string | undefined;
};

type SearchLifecycleDependencies<Result> = {
  search(query: string, signal: AbortSignal): Promise<Result[]>;
  update(state: LocationSearchState<Result>): void;
  reportError(query: string, message: string): void | Promise<void>;
  debounceMs?: number;
};

export function createLocationSearchLifecycle<Result>({
  search,
  update,
  reportError,
  debounceMs = 250,
}: SearchLifecycleDependencies<Result>) {
  let generation = 0;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;

  function cancelActive() {
    if (timer) clearTimeout(timer);
    timer = undefined;
    controller?.abort();
    controller = undefined;
  }

  function replace(rawQuery: string) {
    cancelActive();
    const currentGeneration = ++generation;
    const query = rawQuery.trim();
    if (disposed) return;
    if (query.length < 2) {
      update({
        results: [],
        isLoadingSearch: false,
        searchError: undefined,
      });
      return;
    }

    controller = new AbortController();
    const activeController = controller;
    timer = setTimeout(async () => {
      timer = undefined;
      if (!isCurrent(currentGeneration)) return;
      update({
        results: [],
        isLoadingSearch: true,
        searchError: undefined,
      });
      try {
        const results = await search(query, activeController.signal);
        if (!isCurrent(currentGeneration)) return;
        update({
          results,
          isLoadingSearch: false,
          searchError: undefined,
        });
      } catch (error) {
        if (!isCurrent(currentGeneration)) return;
        if (isAbortError(error)) {
          update({
            results: [],
            isLoadingSearch: false,
            searchError: undefined,
          });
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        update({ results: [], isLoadingSearch: false, searchError: message });
        await reportError(query, message);
      }
    }, debounceMs);
  }

  function isCurrent(candidate: number) {
    return !disposed && generation === candidate;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    generation += 1;
    cancelActive();
  }

  return { replace, dispose };
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

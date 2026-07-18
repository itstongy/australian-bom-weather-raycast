export type LatestRequestHandlers<T> = {
  onSuccess: (value: T) => void;
  onError: (error: unknown) => void;
};

export type LatestRequestLifecycle = {
  run<T>(
    request: (signal: AbortSignal) => Promise<T>,
    handlers: LatestRequestHandlers<T>,
  ): Promise<void>;
  dispose(): void;
};

/**
 * Owns one user-visible request at a time. Starting a newer request aborts the
 * previous one, and sequence checks prevent late completions from committing
 * state or showing a toast even when the underlying promise ignores abort.
 */
export function createLatestRequestLifecycle(): LatestRequestLifecycle {
  let active = true;
  let sequence = 0;
  let controller: AbortController | undefined;

  return {
    async run(request, handlers) {
      controller?.abort();
      const requestSequence = ++sequence;
      const requestController = new AbortController();
      controller = requestController;

      try {
        const value = await request(requestController.signal);
        if (
          active &&
          requestSequence === sequence &&
          !requestController.signal.aborted
        ) {
          handlers.onSuccess(value);
        }
      } catch (error) {
        if (
          active &&
          requestSequence === sequence &&
          !requestController.signal.aborted &&
          !isAbortError(error)
        ) {
          handlers.onError(error);
        }
      } finally {
        if (requestSequence === sequence) controller = undefined;
      }
    },
    dispose() {
      if (!active) return;
      active = false;
      sequence += 1;
      controller?.abort();
      controller = undefined;
    },
  };
}

export function isAbortError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "AbortError"
  );
}

import assert from "node:assert/strict";
import test from "node:test";
import {
  createLocationSearchLifecycle,
  LocationSearchState,
} from "../src/location-search-lifecycle";
import { createLatestRequestLifecycle } from "../src/latest-request-lifecycle";
import { startRadarCatalogLoadLifecycle } from "../src/radar-catalog-lifecycle";
import {
  LifecycleToast,
  LifecycleToastKind,
  startRadarRenderLifecycle,
} from "../src/radar-render-lifecycle";

test("latest request lifecycle aborts and suppresses an older out-of-order completion", async () => {
  const first = deferred<string>();
  const second = deferred<string>();
  const signals: AbortSignal[] = [];
  const committed: string[] = [];
  const reported: string[] = [];
  const lifecycle = createLatestRequestLifecycle();

  const firstRun = lifecycle.run(
    (signal) => {
      signals.push(signal);
      return first.promise;
    },
    {
      onSuccess: (value) => committed.push(value),
      onError: (error) => reported.push(String(error)),
    },
  );
  const secondRun = lifecycle.run(
    (signal) => {
      signals.push(signal);
      return second.promise;
    },
    {
      onSuccess: (value) => committed.push(value),
      onError: (error) => reported.push(String(error)),
    },
  );

  assert.equal(signals[0].aborted, true);
  first.resolve("old forecast and toast");
  second.resolve("new forecast and toast");
  await Promise.all([firstRun, secondRun]);

  assert.deepEqual(committed, ["new forecast and toast"]);
  assert.deepEqual(reported, []);
  lifecycle.dispose();
});

test("latest request lifecycle aborts on unmount and suppresses success, AbortError, and toasts", async () => {
  const pending = deferred<string>();
  const committed: string[] = [];
  const reported: unknown[] = [];
  let signal: AbortSignal | undefined;
  const lifecycle = createLatestRequestLifecycle();
  const run = lifecycle.run(
    (requestSignal) => {
      signal = requestSignal;
      return pending.promise;
    },
    {
      onSuccess: (value) => committed.push(value),
      onError: (error) => reported.push(error),
    },
  );

  lifecycle.dispose();
  assert.equal(signal?.aborted, true);
  pending.reject(Object.assign(new Error("unmounted"), { name: "AbortError" }));
  await run;
  assert.deepEqual(committed, []);
  assert.deepEqual(reported, []);
});

test("location search replacement aborts the old query and suppresses its late result", async () => {
  const searches = new Map<string, Deferred<string[]>>();
  const signals = new Map<string, AbortSignal>();
  const updates: LocationSearchState<string>[] = [];
  const reports: string[] = [];
  const lifecycle = createLocationSearchLifecycle({
    debounceMs: 0,
    search: (query, signal) => {
      signals.set(query, signal);
      const pending = deferred<string[]>();
      searches.set(query, pending);
      return pending.promise;
    },
    update: (state) => updates.push(state),
    reportError: (_query, message) => reports.push(message),
  });

  lifecycle.replace("Brisbane");
  await nextTurn();
  lifecycle.replace("Sydney");
  await nextTurn();
  assert.equal(signals.get("Brisbane")?.aborted, true);
  searches.get("Brisbane")?.resolve(["late Brisbane"]);
  searches.get("Sydney")?.resolve(["Sydney"]);
  await nextTurn();

  assert.deepEqual(updates.at(-1), {
    results: ["Sydney"],
    isLoadingSearch: false,
    searchError: undefined,
  });
  assert.equal(
    updates.some((state) => state.results.includes("late Brisbane")),
    false,
  );
  assert.deepEqual(reports, []);
  lifecycle.dispose();
});

test("location search unmount aborts work and suppresses late results", async () => {
  const pending = deferred<string[]>();
  const updates: LocationSearchState<string>[] = [];
  let signal: AbortSignal | undefined;
  const lifecycle = createLocationSearchLifecycle({
    debounceMs: 0,
    search: (_query, nextSignal) => {
      signal = nextSignal;
      return pending.promise;
    },
    update: (state) => updates.push(state),
    reportError: () => assert.fail("unmounted searches must not report errors"),
  });

  lifecycle.replace("Brisbane");
  await nextTurn();
  const updateCount = updates.length;
  lifecycle.dispose();
  assert.equal(signal?.aborted, true);
  pending.resolve(["late result"]);
  await nextTurn();
  assert.equal(updates.length, updateCount);
});

test("location search silences AbortError but exposes and reports real errors", async () => {
  const updates: LocationSearchState<string>[] = [];
  const reports: Array<[string, string]> = [];
  let failure: Error = Object.assign(new Error("cancelled"), {
    name: "AbortError",
  });
  const lifecycle = createLocationSearchLifecycle({
    debounceMs: 0,
    search: async () => {
      throw failure;
    },
    update: (state) => updates.push(state),
    reportError: (query, message) => reports.push([query, message]),
  });

  lifecycle.replace("Brisbane");
  await nextTurn();
  await nextTurn();
  assert.deepEqual(updates.at(-1), {
    results: [],
    isLoadingSearch: false,
    searchError: undefined,
  });
  assert.deepEqual(reports, []);

  failure = new Error("service unavailable");
  lifecycle.replace("Sydney");
  await nextTurn();
  await nextTurn();
  assert.deepEqual(updates.at(-1), {
    results: [],
    isLoadingSearch: false,
    searchError: "service unavailable",
  });
  assert.deepEqual(reports, [["Sydney", "service unavailable"]]);
  lifecycle.dispose();
});

test("location search clears a merged visible error on success and query clear", async () => {
  let state: LocationSearchState<string> = {
    results: [],
    isLoadingSearch: false,
    searchError: undefined,
  };
  const lifecycle = createLocationSearchLifecycle({
    debounceMs: 0,
    search: async (query) => {
      if (query.startsWith("fail")) throw new Error(`failed: ${query}`);
      return [query];
    },
    // This intentionally matches locations.tsx's partial-state merge.
    update: (searchState) => {
      state = { ...state, ...searchState };
    },
    reportError: () => undefined,
  });

  lifecycle.replace("fail once");
  await nextTurn();
  await nextTurn();
  assert.equal(state.searchError, "failed: fail once");

  lifecycle.replace("Brisbane");
  await nextTurn();
  await nextTurn();
  assert.deepEqual(state, {
    results: ["Brisbane"],
    isLoadingSearch: false,
    searchError: undefined,
  });

  lifecycle.replace("fail twice");
  await nextTurn();
  await nextTurn();
  assert.equal(state.searchError, "failed: fail twice");
  lifecycle.replace("");
  assert.deepEqual(state, {
    results: [],
    isLoadingSearch: false,
    searchError: undefined,
  });
  lifecycle.dispose();
});

test("radar catalogue load cancellation aborts work and suppresses late state", async () => {
  const pending = deferred<string>();
  const ready: string[] = [];
  const errors: unknown[] = [];
  let loadSignal: AbortSignal | undefined;
  const lifecycle = startRadarCatalogLoadLifecycle({
    load: (signal) => {
      loadSignal = signal;
      return pending.promise;
    },
    onReady: (catalog) => ready.push(catalog),
    onError: (error) => errors.push(error),
  });

  await nextTurn();
  lifecycle.cancel();
  assert.equal(loadSignal?.aborted, true);
  pending.resolve("late catalogue");
  assert.equal(await lifecycle.done, "cancelled");
  assert.deepEqual(ready, []);
  assert.deepEqual(errors, []);
});

test("radar catalogue load reports real failures but silences AbortError", async () => {
  for (const failure of [
    new Error("catalogue unavailable"),
    Object.assign(new Error("aborted"), { name: "AbortError" }),
  ]) {
    const errors: unknown[] = [];
    const lifecycle = startRadarCatalogLoadLifecycle({
      load: async () => {
        throw failure;
      },
      onReady: () => assert.fail("a failed load must not become ready"),
      onError: (error) => errors.push(error),
    });
    assert.equal(
      await lifecycle.done,
      failure.name === "AbortError" ? "cancelled" : "error",
    );
    assert.deepEqual(errors, failure.name === "AbortError" ? [] : [failure]);
  }
});

test("radar lifecycle shows one animated toast and settles success and failure", async () => {
  for (const scenario of ["success", "failure"] as const) {
    const shown: LifecycleToastKind[] = [];
    const hidden: LifecycleToastKind[] = [];
    const ready: string[] = [];
    const errors: string[] = [];
    const lifecycle = startRadarRenderLifecycle({
      productId: "IDR663",
      render: async () => {
        if (scenario === "failure") throw new Error("render failed");
        return "gif";
      },
      showToast: async ({ kind }) => {
        shown.push(kind);
        return { hide: () => hidden.push(kind) };
      },
      onReady: (result) => ready.push(result),
      onError: (error) =>
        errors.push(error instanceof Error ? error.message : String(error)),
    });

    assert.equal(
      await lifecycle.done,
      scenario === "success" ? "success" : "failure",
    );
    assert.equal(shown.filter((kind) => kind === "animated").length, 1);
    assert.equal(hidden.filter((kind) => kind === "animated").length, 1);
    assert.deepEqual(
      shown,
      scenario === "success"
        ? ["animated", "success"]
        : ["animated", "failure"],
    );
    assert.deepEqual(ready, scenario === "success" ? ["gif"] : []);
    assert.deepEqual(errors, scenario === "failure" ? ["render failed"] : []);
    lifecycle.cancel();
    await nextTurn();
    assert.equal(hidden.includes(scenario), true);
  }
});

test("radar unmount before the animated toast resolves hides it and skips rendering", async () => {
  const animated = deferred<LifecycleToast | undefined>();
  let hidden = 0;
  let renders = 0;
  const lifecycle = startRadarRenderLifecycle({
    productId: "IDR663",
    render: async () => {
      renders += 1;
      return "gif";
    },
    showToast: ({ kind }) =>
      kind === "animated"
        ? animated.promise
        : Promise.reject(new Error("outcome toast must be suppressed")),
    onReady: () => assert.fail("cancelled radar must not become ready"),
    onError: () => assert.fail("cancelled radar must not show an error"),
  });

  lifecycle.cancel();
  animated.resolve({ hide: () => void (hidden += 1) });
  assert.equal(await lifecycle.done, "cancelled");
  assert.equal(hidden, 1);
  assert.equal(renders, 0);
});

test("radar unmount aborts rendering without launching an outcome toast", async () => {
  const shown: LifecycleToastKind[] = [];
  let renderSignal: AbortSignal | undefined;
  const lifecycle = startRadarRenderLifecycle({
    productId: "IDR663",
    render: (signal) => {
      renderSignal = signal;
      return new Promise((_resolve, reject) =>
        signal.addEventListener(
          "abort",
          () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          { once: true },
        ),
      );
    },
    showToast: async ({ kind }) => {
      shown.push(kind);
      return { hide() {} };
    },
    onReady: () => assert.fail("aborted radar must not become ready"),
    onError: () => assert.fail("AbortError must be silent"),
  });

  await nextTurn();
  lifecycle.cancel();
  assert.equal(renderSignal?.aborted, true);
  assert.equal(await lifecycle.done, "cancelled");
  assert.deepEqual(shown, ["animated"]);
});

test("radar unmount hides a completion toast that is still being created", async () => {
  for (const scenario of ["success", "failure"] as const) {
    const outcome = deferred<LifecycleToast | undefined>();
    let outcomeStarted = false;
    let outcomeHidden = 0;
    const lifecycle = startRadarRenderLifecycle({
      productId: "IDR663",
      render: async () => {
        if (scenario === "failure") throw new Error("failed");
        return "gif";
      },
      showToast: async ({ kind }) => {
        if (kind === "animated") return { hide() {} };
        outcomeStarted = true;
        return outcome.promise;
      },
      onReady: () => undefined,
      onError: () => undefined,
    });

    while (!outcomeStarted) await nextTurn();
    lifecycle.cancel();
    outcome.resolve({ hide: () => void (outcomeHidden += 1) });
    assert.equal(await lifecycle.done, "cancelled");
    assert.equal(outcomeHidden, 1);
  }
});

type Deferred<Value> = {
  promise: Promise<Value>;
  resolve(value: Value): void;
  reject(error: unknown): void;
};

function deferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function nextTurn() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

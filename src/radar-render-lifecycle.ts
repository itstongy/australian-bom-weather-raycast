export type LifecycleToastKind = "animated" | "success" | "failure";

export type LifecycleToast = {
  hide(): void | Promise<void>;
};

type RadarRenderDependencies<Result> = {
  render(signal: AbortSignal): Promise<Result>;
  beforeRender?(): void | Promise<void>;
  showToast(input: {
    kind: LifecycleToastKind;
    title: string;
    message?: string;
  }): Promise<LifecycleToast | undefined>;
  onReady(result: Result): void;
  onError(error: unknown): void;
  productId: string;
};

export type RadarRenderOutcome = "success" | "failure" | "cancelled";

export function startRadarRenderLifecycle<Result>({
  render,
  beforeRender,
  showToast,
  onReady,
  onError,
  productId,
}: RadarRenderDependencies<Result>) {
  const controller = new AbortController();
  let cancelled = false;
  let animatedToast: LifecycleToast | undefined;
  let outcomeToast: LifecycleToast | undefined;

  async function hide(toast: LifecycleToast | undefined) {
    try {
      await toast?.hide();
    } catch {
      // Toast cleanup is best effort and must not change the render outcome.
    }
  }

  async function hideAnimatedToast() {
    const toast = animatedToast;
    animatedToast = undefined;
    await hide(toast);
  }

  async function showOutcome(
    kind: "success" | "failure",
    title: string,
    message: string,
  ) {
    if (cancelled) return;
    const toast = await showToast({ kind, title, message });
    if (cancelled) {
      await hide(toast);
      return;
    }
    outcomeToast = toast;
  }

  const done = (async (): Promise<RadarRenderOutcome> => {
    try {
      const toast = await showToast({
        kind: "animated",
        title: "Rendering radar loop",
        message: productId,
      });
      if (cancelled) {
        await hide(toast);
        return "cancelled";
      }
      animatedToast = toast;
      await beforeRender?.();
      if (cancelled) return "cancelled";
      const result = await render(controller.signal);
      if (cancelled) return "cancelled";
      onReady(result);
      await hideAnimatedToast();
      await showOutcome("success", "Radar loop ready", productId);
      return cancelled ? "cancelled" : "success";
    } catch (error) {
      await hideAnimatedToast();
      if (cancelled || isAbortError(error)) return "cancelled";
      onError(error);
      const message = error instanceof Error ? error.message : String(error);
      await showOutcome("failure", "Failed to render radar", message);
      return cancelled ? "cancelled" : "failure";
    } finally {
      await hideAnimatedToast();
    }
  })();

  function cancel() {
    if (cancelled) return;
    cancelled = true;
    controller.abort();
    void hideAnimatedToast();
    void hide(outcomeToast);
    outcomeToast = undefined;
  }

  return { cancel, done };
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

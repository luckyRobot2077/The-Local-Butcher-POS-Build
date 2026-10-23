"use client";

/**
 * Shown when a screen crashes. Completed sales are saved on the device as
 * they happen, so reloading is safe; the message says so, because a blank or
 * broken screen at the counter is easy to panic about.
 */
export function ErrorScreen({ error, retry }: { error: unknown; retry: () => void }) {
  const detail = error instanceof Error ? error.message : String(error);
  return (
    <div role="alert" data-testid="error-screen" className="mx-auto grid max-w-md gap-3 p-6 text-center">
      <h1 className="text-xl font-bold text-charcoal-900">Something went wrong on this screen</h1>
      <p className="text-charcoal-700">
        Completed sales are already saved on this device. Try again, or reload the app. If it keeps happening, take a
        photo of this screen.
      </p>
      <div className="flex justify-center gap-2">
        <button
          type="button"
          onClick={() => retry()}
          className="min-h-11 rounded-lg bg-burgundy-700 px-4 font-semibold text-cream-50"
        >
          Try again
        </button>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="min-h-11 rounded-lg border border-cream-300 bg-white px-4 font-semibold text-charcoal-700"
        >
          Reload the app
        </button>
      </div>
      <p className="break-words text-xs text-charcoal-500">{detail}</p>
    </div>
  );
}

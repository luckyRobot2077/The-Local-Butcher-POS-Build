"use client";

import { useEffect, useRef, useState } from "react";
import jsQR from "jsqr";

interface DetectedCode {
  rawValue: string;
}
interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<DetectedCode[]>;
}
declare global {
  interface Window {
    BarcodeDetector?: {
      new (opts: { formats: string[] }): BarcodeDetectorLike;
      getSupportedFormats?: () => Promise<string[]>;
    };
  }
}

async function nativeDetector(): Promise<BarcodeDetectorLike | null> {
  try {
    if (!window.BarcodeDetector) return null;
    const formats = (await window.BarcodeDetector.getSupportedFormats?.()) ?? ["qr_code"];
    return formats.includes("qr_code") ? new window.BarcodeDetector({ formats: ["qr_code"] }) : null;
  } catch {
    return null;
  }
}

/**
 * Reads QR codes with the device camera. Uses the browser's built-in
 * barcode reader where there is one (Chrome on Android) and the jsQR
 * library everywhere else, so no separate app is needed. The camera only
 * works on https (or localhost) and after the user allows it.
 */
export function QrScanner({ onResult }: { onResult: (text: string) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [status, setStatus] = useState<"starting" | "scanning" | "error">("starting");
  const [error, setError] = useState<string>();
  const done = useRef(false);
  const onResultRef = useRef(onResult);
  useEffect(() => {
    onResultRef.current = onResult;
  }, [onResult]);

  useEffect(() => {
    let stream: MediaStream | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });

    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setStatus("error");
        setError("This browser cannot open the camera here. Type the member number instead.");
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
      } catch (e) {
        setStatus("error");
        const name = e instanceof DOMException ? e.name : "";
        setError(
          name === "NotAllowedError"
            ? "Camera permission was refused. Allow the camera for this site in the browser settings, or type the member number."
            : name === "NotFoundError"
              ? "No camera found on this device. Type the member number instead."
              : "The camera could not be started. Type the member number instead.",
        );
        return;
      }
      if (stopped) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      const video = videoRef.current!;
      video.srcObject = stream;
      await video.play().catch(() => {});
      setStatus("scanning");
      const native = await nativeDetector();

      const tick = async () => {
        if (stopped || done.current) return;
        let text: string | undefined;
        if (video.readyState >= 2 && video.videoWidth > 0) {
          if (native) {
            text = (await native.detect(video).catch(() => []))[0]?.rawValue;
          } else if (ctx) {
            // Scan a centred square, scaled down, to keep slower phones responsive.
            const side = Math.min(video.videoWidth, video.videoHeight);
            const size = Math.min(side, 640);
            canvas.width = size;
            canvas.height = size;
            ctx.drawImage(
              video,
              (video.videoWidth - side) / 2,
              (video.videoHeight - side) / 2,
              side,
              side,
              0,
              0,
              size,
              size,
            );
            const img = ctx.getImageData(0, 0, size, size);
            text = jsQR(img.data, size, size, { inversionAttempts: "dontInvert" })?.data;
          }
        }
        if (text && !done.current) {
          done.current = true;
          navigator.vibrate?.(60);
          onResultRef.current(text);
          return;
        }
        timer = setTimeout(tick, 150);
      };
      void tick();
    })();

    return () => {
      stopped = true;
      clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  return (
    <div className="grid gap-2">
      <div className="relative mx-auto aspect-square w-full max-w-xs overflow-hidden rounded-xl bg-charcoal-900">
        <video ref={videoRef} className="size-full object-cover" muted playsInline aria-label="Camera view" />
        {status === "scanning" && (
          <div className="pointer-events-none absolute inset-[15%] rounded-lg border-4 border-cream-50/80" />
        )}
        {status === "starting" && (
          <p className="absolute inset-0 grid place-items-center text-sm text-cream-100">Starting camera…</p>
        )}
      </div>
      {status === "scanning" && (
        <p className="text-center text-sm text-charcoal-700" data-testid="scanner-ready">
          Hold the card&apos;s QR code inside the square.
        </p>
      )}
      {error && <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">{error}</p>}
    </div>
  );
}

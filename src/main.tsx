
  import { createRoot } from "react-dom/client";
  import { Analytics } from "@vercel/analytics/react";
  import App from "./app/App.tsx";
  import { ErrorBoundary } from "./shared/components/ErrorBoundary.tsx";
  import { initSentry } from "./shared/utils/sentry.ts";
  import "./styles/index.css";

  // R1-06: no-op si VITE_SENTRY_DSN no está configurada todavía.
  initSentry();

  createRoot(document.getElementById("root")!).render(
    <ErrorBoundary>
      <App />
      {/* Sprint 3: Vercel Analytics en vez de Google Analytics — sin cookies, sin
          datos personales, agregado y anónimo. Solo mide en el deploy real de
          Vercel (no hace nada en local/otros hosts). */}
      <Analytics />
    </ErrorBoundary>,
  );

  // PWA instalable (siempre online). Registra el SW mínimo de paso-a-red. Si FCM
  // está configurado, su propio SW puede tomar el control del scope '/' más tarde
  // (también trae fetch handler) — en ambos casos la app queda instalable.
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/app-sw.js").catch(() => undefined);
    });
  }

// R1-06: Error tracking en el cliente (Sentry).
// Variable de entorno requerida en .env.local / panel de Netlify:
//   VITE_SENTRY_DSN
// Si falta (cuenta institucional aún no creada — Sprint 4), initSentry() no hace
// nada: la app funciona igual, solo sin reporte a Sentry. Ver ErrorBoundary.tsx,
// que llama a Sentry.captureException además de su registro existente en audit_log.

import * as Sentry from '@sentry/react';
import { toast } from 'sonner';

const isSentryConfigured = () => Boolean(import.meta.env.VITE_SENTRY_DSN);

export function initSentry(): void {
  if (!isSentryConfigured()) return;

  Sentry.init({
    dsn: import.meta.env.VITE_SENTRY_DSN,
    environment: import.meta.env.MODE,
  });
}

// Auditoría de código limpio P0-3: 21 servicios hacían `if (error || !data) return []`,
// así que un rechazo de RLS, un token vencido o una caída de red se mostraban como
// "No hay registros". Ahora el error se reporta (Sentry si está configurado, consola
// en desarrollo) y el usuario ve un aviso, aunque la pantalla siga mostrando vacío.
const recentToasts = new Map<string, number>();

export function reportServiceError(context: string, error: unknown): void {
  if (isSentryConfigured()) {
    Sentry.captureException(error, { tags: { service: context } });
  }
  if (import.meta.env.DEV) {
    console.error(`[${context}]`, error);
  }
  // Un aviso por servicio cada 10 s: varias consultas fallando a la vez no inundan la pantalla.
  const now = Date.now();
  if ((recentToasts.get(context) ?? 0) > now - 10_000) return;
  recentToasts.set(context, now);
  toast.error('No se pudieron cargar algunos datos. Revisa tu conexión o vuelve a iniciar sesión.');
}

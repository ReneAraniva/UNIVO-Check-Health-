// C1-07: error tracking del lado del servidor (Edge Functions), contraparte de
// R1-06 (frontend). Mismo criterio: si falta SENTRY_DSN (cuenta todavía sin crear
// o secret sin setear), no hace nada — la función sigue funcionando igual, solo
// sin reporte a Sentry.
import * as Sentry from 'npm:@sentry/deno@8';
import { getCorsHeaders } from './cors.ts';

let initialized = false;

function initSentry(): void {
  if (initialized) return;
  const dsn = Deno.env.get('SENTRY_DSN');
  if (!dsn) return;
  Sentry.init({
    dsn,
    // Evita que el scope (tags, contexto) se contamine entre invocaciones que
    // reusan el mismo runtime de Deno — cada invocación es un request distinto.
    defaultIntegrations: false,
  });
  initialized = true;
}

// Envuelve el handler de una Edge Function: si algo escapa sin capturar por el
// propio código de la función, lo reporta a Sentry y responde 500 genérico (con
// los headers de CORS del proyecto) en vez de dejar que el runtime lo trague en
// silencio. No reemplaza el manejo de errores que ya tiene cada función — solo
// cubre lo que se les escape.
export function withSentry(
  functionName: string,
  handler: (req: Request) => Promise<Response>,
): (req: Request) => Promise<Response> {
  initSentry();
  return async (req: Request) => {
    try {
      return await handler(req);
    } catch (e) {
      Sentry.setTag('function', functionName);
      Sentry.captureException(e);
      await Sentry.flush(2000);
      console.error(`[${functionName}] Error no manejado:`, e);
      return new Response(JSON.stringify({ error: 'Error interno del servidor.' }), {
        status: 500,
        headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
      });
    }
  };
}

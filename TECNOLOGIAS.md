# Tecnologías y dependencias — UNIVO Check-Health / SIA-U

Referencia de todo lo que usa el proyecto y en qué versión, para que nadie instale algo
incompatible ni actualice a ciegas. Generado a partir de `package.json`,
`supabase/config.toml`, `supabase/migrations/`, `supabase/functions/` y
`.github/workflows/` el 2026-09-13 — actualizar esta tabla cada vez que se agregue o suba
de versión una dependencia real, no dejar que se desactualice.

**Regla de oro del proyecto:** siempre `pnpm`, nunca `npm` ni `yarn` (hay un
`pnpm-lock.yaml`, no lo dupliques con otro lockfile).

## 1. Runtime y gestor de paquetes

**Fijado el 2026-09-13 — una sola versión para todo el equipo, la LTS activa de Node al día
de hoy (la más estable disponible para el proyecto):**

| Herramienta | Versión fijada | Dónde queda fijada | Nota |
|---|---|---|---|
| Node.js | **24.x** (LTS) | `.nvmrc` + `"engines"` en `package.json` + `node-version` en `ci.yml` | Antes CI corría en Node 20 mientras el equipo ya usaba 24 en local — corregido, ahora coinciden. |
| pnpm | **10.33.0** exacta | `"packageManager"` en `package.json` (Corepack la respeta automáticamente) | No usar `npm`/`yarn` bajo ninguna circunstancia — hay un solo `pnpm-lock.yaml`. |
| Supabase CLI | 2.117.0 (vía `npx supabase`) | No fijada como dependencia — siempre `npx supabase`, nunca el binario `supabase` suelto (da error de permisos en zsh en esta máquina). | |

## 2. Frontend — `package.json`

### Framework y build

| Paquete | Versión | Notas |
|---|---|---|
| `react` / `react-dom` | 18.3.1 (peerDependency, opcional) | React 18, no 19. |
| `vite` | 6.3.5 | |
| `@vitejs/plugin-react` | 5.2.0 | Subió de 4→5 en algún punto — confirmar que sigue compatible antes de tocarlo de nuevo. |
| `typescript` | ^6.0.3 | |
| `react-router` | 7.18.3 | v7, con lazy-loading de rutas. |

### Estilos y UI

| Paquete | Versión | Notas |
|---|---|---|
| `tailwindcss` | 4.3.3 (dev) | Tailwind 4 — configuración vía CSS (`@theme`), no `tailwind.config.js`. |
| `@tailwindcss/vite` | 4.1.12 | |
| Radix UI (`@radix-ui/react-*`) | 1.1.x–2.1.x según paquete | Base de los componentes shadcn/ui en `src/shared/components/ui/`. |
| `@mui/material` + `@mui/icons-material` | 7.3.5 | **Redundante con Radix/shadcn** — dos sistemas de componentes conviviendo, señalado ya en auditorías previas para futura consolidación, no tocar sin planearlo. |
| `@emotion/react` / `@emotion/styled` | 11.14.x | Dependencia de MUI. |
| `lucide-react` | 0.487.0 | Iconos. |
| `class-variance-authority`, `clsx`, `tailwind-merge` | 0.7.1 / 2.1.1 / 3.2.0 | Utilidades de estilos tipo shadcn. |
| `next-themes` | 0.4.6 | Instalado, **sin usar actualmente** (el modo oscuro que lo consumía se descartó — ver memoria del proyecto). |
| `motion` | 12.23.24 | Animaciones (ex Framer Motion). |
| `tw-animate-css` | 1.4.0 | |

### Datos, formularios y estado

| Paquete | Versión | Notas |
|---|---|---|
| `@supabase/supabase-js` | ^2.105.4 | Cliente único en `src/shared/backend/supabaseClient.ts`. |
| `zustand` | ^5.0.13 | Estado global (`useDeanStore`). |
| `react-hook-form` | 7.55.0 | Todos los formularios. |
| `date-fns` | 3.6.0 | Con locale `es`. |
| `jose` | ^6.2.10 | JWT en frontend (verificación, no firma). |

### Mapas, QR, exportación

| Paquete | Versión | Notas |
|---|---|---|
| `leaflet` / `react-leaflet` | ^1.9.4 / ^5.0.0 | Mapa en vivo. |
| `html5-qrcode` | ^2.3.8 | Escaneo de QR desde el navegador. |
| `jspdf` / `jspdf-autotable` | ^4.2.1 / ^5.0.7 | Reportes y constancias en PDF. |
| `xlsx` | `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz` | **No viene de npm** — se instala desde el CDN oficial de SheetJS (su versión libre ya no se publica en el registro de npm). Si `pnpm install` falla acá, es señal de que ese CDN cambió de URL, no un bug del proyecto. |

### Notificaciones, analítica, misceláneos

| Paquete | Versión | Notas |
|---|---|---|
| `firebase` | ^12.14.0 | Solo FCM (push), no se usa Firebase Analytics. |
| `@sentry/react` | 10.72.0 | Solo Error Monitoring — sin Session Replay/Tracing/Logs, decisión de privacidad. |
| `@vercel/analytics` | ^2.0.1 | Solo mide en el deploy real de Vercel. |
| `sonner` | 2.0.3 | Toasts. |
| `canvas-confetti`, `react-slick`, `react-dnd`(+html5-backend), `react-responsive-masonry`, `react-popper`, `@popperjs/core`, `cmdk`, `input-otp` | varias | Utilidades puntuales de UI en módulos específicos. |

### Testing

| Paquete | Versión | Notas |
|---|---|---|
| `vitest` | ^4.1.7 | Unitarios + la suite de integración RLS (`rlsSecurity.test.ts`, gateada por `CI_RLS_INTEGRATION`). |
| `@vitest/coverage-v8` | ^4.1.7 | |
| `@testing-library/react` / `jest-dom` | ^16.3.2 / ^6.9.1 | |
| `jsdom` | ^29.1.1 | |
| `@playwright/test` | ^1.61.0 | E2E — requiere `npx playwright install` + libs del sistema (ver `LOCAL_DEV.md`, pendiente en Fedora). |
| `ws` + `@types/ws` | ^8.21.3 / ^8.18.1 | Necesario para que `rlsSecurity.test.ts` corra en CI (Node 20 no trae WebSocket nativo). |

## 3. Backend — Supabase

| Componente | Versión / config | Notas |
|---|---|---|
| PostgreSQL | **17** (cloud: 17.6.1 exacto; local: `major_version = 17` en `supabase/config.toml`) | Esquema `public` es el canónico; `app` es legado, solo para `supabase start` local (ver `docs/backend/schema-and-cron.md`). |
| Extensiones Postgres | `pgcrypto`, `pg_cron`, `pg_net` | Las tres con `CREATE EXTENSION IF NOT EXISTS ... WITH SCHEMA extensions`. **Si se self-hostea, confirmar que la imagen las trae en versión compatible** — es uno de los puntos críticos del plan de migración. |
| Auth | Supabase Auth (GoTrue) | Dominio `@univo.edu.sv` obligatorio para personal; alumnos con carné. |
| Realtime | Supabase Realtime | Mapa en vivo del dashboard. |
| Storage | Supabase Storage | Avatares, documentos de justificación. |
| Edge Functions | Deno (runtime de Supabase) | 7 funciones: `admin-users`, `generate-campus-qr`, `validate-qr-checkin`, `notify-dispatcher`, `recovery-otp`, `send-credentials`, `sign-report`. |

### Dependencias de las Edge Functions (Deno, imports por URL — no hay `deno.json`/`import_map.json`)

| Import | Versión pineada | Usado en |
|---|---|---|
| `https://esm.sh/@supabase/supabase-js@2` | `@2` (mayor, no exacta) | Todas las funciones |
| `https://esm.sh/jose@5` | `@5` (mayor, no exacta) | Verificación/firma JWT del QR |
| `https://deno.land/x/denomailer@1.6.0/mod.ts` | 1.6.0 exacta | `_shared/mailer.ts` (Gmail SMTP) |

**Nota de mantenimiento:** las Edge Functions no tienen lockfile de Deno — `@2` y `@5`
pueden traer una versión menor distinta cada vez que Deno resuelve el import. Si algo se
rompe sin que nadie haya tocado código, revisar acá primero.

## 4. Infraestructura y CI/CD

| Herramienta | Uso | Notas |
|---|---|---|
| Vercel | Hosting del frontend | Con Vercel Analytics integrado. |
| GitHub Actions | CI (`ci.yml`), backup diario (`db-backup.yml`) | Ver tabla de Actions abajo. |
| Podman (Fedora, esta máquina) | Reemplaza a Docker localmente | Requiere `DOCKER_HOST` apuntando al socket de podman — ver `LOCAL_DEV.md`. |

### Versiones de GitHub Actions usadas

| Action | `ci.yml` | `db-backup.yml` |
|---|---|---|
| `actions/checkout` | `@v7` | `@v4` ⚠️ |
| `pnpm/action-setup` | `@v6` | — |
| `actions/setup-node` | `@v7` | — |
| `supabase/setup-cli` | `@v3` | `@v1` ⚠️ |

⚠️ **Inconsistencia detectada:** `db-backup.yml` quedó en versiones más viejas que `ci.yml`.
No es urgente (el backup sigue funcionando), pero al tocar ese workflow de nuevo, alinear
versiones.

## 5. Cosas para tener en cuenta al integrar los módulos nuevos (académico, eventos)

- **No se necesita ninguna librería nueva para lo ya definido:** el motor de QR
  (`html5-qrcode`), PDF (`jspdf`), y el cliente de Supabase ya cubren lo que piden los
  requerimientos de ambos módulos nuevos (RF-E11 de eventos reutiliza explícitamente el
  motor de QR existente).
- Si el módulo de eventos necesita autocompletar de búsqueda con cientos de invitados
  (RNF-E02) con buen rendimiento, evaluar si alcanza con una búsqueda en cliente sobre los
  datos ya cargados, o si hace falta algo más (a decidir cuando se resuelvan los vacíos del
  módulo, que son responsabilidad de René).
- Si se migra la base a un contenedor self-hosted, revisar la sección 3 de este documento
  primero (extensiones y sus versiones) — es el punto de fricción más probable.

---

*Actualizar esta tabla cada vez que se agregue, quite o suba de versión una dependencia real
(`pnpm add`/`pnpm up`) — no es un documento de una sola vez.*

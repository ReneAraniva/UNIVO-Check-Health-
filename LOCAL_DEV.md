# Desarrollo local — UNIVO Check-Health

Guía y referencia de comandos para levantar el proyecto en local. Complementa `CLAUDE.md` (arquitectura) con el paso a paso de entorno.

> Este archivo se escribió originalmente en una máquina Fedora + podman. Las secciones marcadas **"(Fedora + podman)"** son específicas de ese entorno — si usás Docker Desktop (Mac/Windows/Ubuntu con Docker), no necesitás nada de `DOCKER_HOST`/podman: `supabase start` funciona directo con Docker corriendo.

## Requisitos

- Node.js + **pnpm** (nunca `npm`/`yarn` — ver `package.json`)
- Un motor de contenedores para el stack local de Supabase: Docker Desktop (lo más común), o **podman** si no tenés Docker (Fedora) — en ese caso, Supabase CLI necesita `DOCKER_HOST` apuntando al socket de podman (ver más abajo).

## Instalación (una vez, o tras cambios en dependencias)

```bash
pnpm install                        # dependencias JS/TS
npx playwright install              # navegadores para e2e (Chromium/Firefox/WebKit)
sudo npx playwright install-deps    # libs del sistema — PENDIENTE, requiere sudo (ver nota abajo)
systemctl --user enable --now podman.socket   # habilita el socket API de podman (persistente)
```

## Desarrollo diario (frontend, contra Supabase **cloud** vía `.env.local`)

```bash
pnpm dev             # servidor Vite en http://localhost:5173
pnpm build            # build de producción
pnpm test             # tests unitarios (Vitest)
pnpm test:watch
pnpm test:coverage
pnpm e2e              # Playwright
pnpm e2e:ui
```

`.env.local` ya apunta al proyecto cloud (`hhddnhofyilsdaltzpeh`), así que `pnpm dev` funciona sin tocar nada más.

## Backend local (opcional — stack Supabase completo)

```bash
# Solo si usás podman en vez de Docker (Fedora) — necesario en cada shell nueva:
export DOCKER_HOST="unix:///run/user/1000/podman/podman.sock"

npx supabase start       # levanta Postgres/Auth/Studio/Storage local (puertos 54321-54324)
npx supabase status      # URLs y keys del stack local
npx supabase db reset    # reaplica migraciones + seed.sql
npx supabase stop        # apaga el stack
```

Studio local: `http://127.0.0.1:54323`. Este stack solo lo usa el frontend si cambiás `.env.local` a las URLs/keys que imprime `supabase start` — mientras tanto es un backend aparte para probar migraciones/seed sin tocar el proyecto cloud.

**Gotcha (Fedora + podman):** la primera vez, `supabase start` puede fallar con:
```
LegacyContainerCreateError: statfs .../supabase/snippets: no such file or directory
```
porque Docker crea solo el directorio del bind-mount, pero podman no. Fix:
```bash
mkdir -p supabase/snippets
```
y reintentar `supabase start`. Con Docker Desktop esto no pasa.

**Nota:** en esta máquina, `supabase functions serve` (levantar Edge Functions en local) falla con `BOOT_ERROR: failed to determine entrypoint` incluso con una función recién creada sin código propio — es el mismo problema de montaje de volumen que el gotcha de arriba, no algo del código. Con Docker Desktop debería funcionar normal. Alternativa en esta máquina: verificar sintaxis con `tsc` desde fuera del proyecto y confiar en el deploy real (`--use-api`, ver abajo) + logs de Supabase.

## Edge Functions (deploy a cloud)

```bash
npx supabase functions deploy admin-users --use-api
npx supabase functions deploy generate-campus-qr --use-api
npx supabase functions deploy notify-dispatcher --use-api
npx supabase functions deploy recovery-otp --use-api
npx supabase functions deploy send-credentials --use-api
npx supabase functions deploy sign-report --use-api
npx supabase functions deploy validate-qr-checkin --use-api
```

`--use-api` es obligatorio en Fedora + podman (SELinux bloquea el bundling en contenedor) — con Docker Desktop probablemente no haga falta, pero no está de más dejarlo. Reautenticar si hace falta: `npx supabase login --token sbp_…`. Siempre usar `npx supabase`, nunca el binario `supabase` suelto (da "permiso denegado" en zsh en esta máquina).

## Git (dual remoto — repo propio + repo de Rene)

```
mio     → https://github.com/Carlos-Gnd/UNIVO-Check-Health.git   (fetch + push)
rene    → https://github.com/ReneAraniva/UNIVO-Check-Health-.git (fetch + push)
origin  → fetch: Carlos-Gnd  |  push: Carlos-Gnd + ReneAraniva (2 push-url)
```

```bash
git pull mio <rama>      # solo tu repo
git pull rene <rama>     # solo el de Rene
git push mio <rama>      # push solo a tu repo
git push rene <rama>     # push solo al de Rene
git push origin <rama>   # push a ambos a la vez
```

## Pendiente manual (requiere sudo, no ejecutado por Claude)

Playwright reportó que faltan libs del sistema para correr los navegadores (Fedora no está oficialmente soportado; el instalador sugiere paquetes de Ubuntu). Equivalente aproximado en Fedora:

```bash
sudo dnf install -y icu libjpeg-turbo woff2
```

o directamente `sudo npx playwright install-deps` y revisar qué falla puntualmente.

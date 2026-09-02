<div align="center">

# UNIVO Check-Health

**Sistema de control de asistencia para prácticas clínicas**  
Universidad de Oriente (UNIVO) — El Salvador

[![Live Demo](https://img.shields.io/badge/Live%20Demo-univocheckhealth.vercel.app-brightgreen?style=for-the-badge&logo=vercel)](https://univocheckhealth.vercel.app/)
[![CI](https://img.shields.io/github/actions/workflow/status/Carlos-Gnd/UNIVO-Check-Health/ci.yml?branch=main&style=for-the-badge&label=CI)](https://github.com/Carlos-Gnd/UNIVO-Check-Health/actions/workflows/ci.yml)
[![React](https://img.shields.io/badge/React-18-61DAFB?style=for-the-badge&logo=react)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?style=for-the-badge&logo=typescript)](https://www.typescriptlang.org/)
[![Supabase](https://img.shields.io/badge/Supabase-Backend-3ECF8E?style=for-the-badge&logo=supabase)](https://supabase.com/)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-4-38B2AC?style=for-the-badge&logo=tailwind-css)](https://tailwindcss.com/)

</div>

---

## Acerca del proyecto

UNIVO Check-Health digitaliza el ciclo completo del registro de asistencia en prácticas clínicas del área de salud. Reemplaza el control manual en papel con una solución web que valida la presencia física del estudiante mediante **geofencing GPS**, detecta falsificación de ubicación, y genera un **audit trail inmutable** de cada evento.

### Roles del sistema

| Rol          | Descripción                                                        |
| ------------ | ------------------------------------------------------------------ |
| `ESTUDIANTE` | Registra entrada/salida con validación GPS                         |
| `DOCENTE`    | Docente supervisor; revisa asistencia de sus estudiantes asignados |
| `ENCARGADO`  | Coordinador de sede; supervisa asistencia en tiempo real           |
| `ADMIN`      | Decano; acceso completo a KPIs, reportes y configuración           |
| `REPRESENTANTE_SEDE` | Representante del hospital; ve alumnos activos en su sede, confirma presencia por falla técnica y reporta incidencias |

---

## Página en vivo

> Accede a la aplicación desplegada en Vercel:

**[https://univocheckhealth.vercel.app/](https://univocheckhealth.vercel.app/)**

---

## Modelo de seguridad y detección de fraude

La presencia física se verifica mediante tres capas independientes:

| Mecanismo                    | Descripción                                                                                                                                     | Umbral                          |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| **Geofencing GPS**           | El servidor verifica que las coordenadas del dispositivo estén dentro del radio de la sede antes de registrar la asistencia                     | Radio configurable por sede     |
| **Análisis de sensores IMU** | Detecta GPS simulado midiendo la varianza del acelerómetro y giroscopio; un dispositivo estático con GPS falso carece de microvibración natural | Confianza < 80 % → alerta       |
| **Coherencia de ubicación**  | Verifica que las coordenadas de check-in y check-out no difieran más del umbral permitido dentro de la misma jornada                            | > 150 m → marca como sospechoso |

Todos los eventos —incluyendo los rechazos— quedan registrados en el **audit log inmutable**, protegido por un trigger de base de datos que impide modificaciones.

---

## Funcionalidades

- **Autenticación institucional** — Supabase Auth restringido a correos `@univo.edu.sv`
- **Control de acceso por rol (RBAC)** — Navegación y vistas diferenciadas por `ADMIN`, `ENCARGADO`, `DOCENTE`  y `ESTUDIANTE`
- **Check-in / Check-out GPS** — Validación de geofencing en tiempo real mediante RPC `validate_checkin_area`
- **Detección de GPS falso** — Análisis de varianza de acelerómetro/giroscopio, umbral de confianza del 80 %
- **Detección de velocidad imposible** — Alerta si el desplazamiento supera 140 km/h entre registros consecutivos
- **Dashboard ejecutivo** — KPIs globales, gráficas Recharts y mapa interactivo de sedes (Leaflet)
- **Panel del Decano** — Lista de estudiantes con cumplimiento, CRUD de sedes con geofence editable
- **Gestión de usuarios** — Crear cuentas desde la app sin interrumpir la sesión activa
- **Historial de asistencias** — Tabla paginada con filtros; exportación CSV, PDF y XLSX
- **Audit log inmutable** — Registro de todas las acciones críticas protegido por trigger en base de datos
- **Diseño responsive** — Compatible con móvil (360 px), tablet, escritorio y ultrawide (≥ 1536 px)

---

## Stack tecnológico

| Capa            | Tecnología                              |
| --------------- | --------------------------------------- |
| Frontend        | React 18 + TypeScript + Vite 6          |
| Estilos         | Tailwind CSS 4 + shadcn/ui (Radix UI)   |
| Estado          | Zustand + React Hook Form               |
| Gráficas        | Recharts                                |
| Mapas           | Leaflet + react-leaflet                 |
| Backend         | Supabase (PostgreSQL + Auth + Realtime) |
| Routing         | React Router 7                          |
| Exportación     | jsPDF + SheetJS (xlsx) + CSV            |
| Fechas          | date-fns                                |
| Notificaciones  | Sonner                                  |
| Email           | SMTP Gmail (Nodemailer)                 |
| Package manager | pnpm                                    |

---

## Configuración local

> El desarrollo diario corre contra **Supabase Cloud** — no hace falta Docker ni Supabase local para trabajar en el frontend. Si necesitás un backend local completo (probar migraciones, `db reset`, etc.), ver [`LOCAL_DEV.md`](./LOCAL_DEV.md).

### Requisitos previos

- **Node.js 18+** — verificar con `node -v`
- **pnpm** — el proyecto rechaza npm y yarn

```bash
npm install -g pnpm
```

### Solución de errores comunes

| Error                              | Causa                                         | Solución                                        |
| ---------------------------------- | --------------------------------------------- | ----------------------------------------------- |
| Página en blanco o error de módulo | Se usó `npm install` en lugar de `pnpm`       | Borrar `node_modules` y ejecutar `pnpm install` |
| `Invalid API key` en consola       | `.env.local` ausente o con claves incorrectas | Verificar el archivo y reiniciar con `pnpm dev` |
| Login rechazado con correo válido  | La cuenta no existe en Supabase Auth          | Crearla desde el panel **Gestión de Usuarios**  |
| `node -v` inferior a 18            | Vite 6 requiere Node 18+                      | Actualizar con `nvm install 18`                 |

---

## Estructura del proyecto

```
Check-Health/
├── src/
│   ├── app/              # React Router (rutas + guards por rol)
│   ├── modules/          # Módulos por dominio de negocio
│   │   ├── admin/        # Gestión de usuarios
│   │   ├── attendance/   # Check-in / check-out + detección de fraude
│   │   ├── auth/         # Login, recuperación, solicitud de acceso
│   │   ├── dashboard/    # Dashboard principal
│   │   ├── dean/         # Panel del Decano / Coordinador
│   │   ├── hospital/     # Portal del representante hospitalario
│   │   ├── legal/        # Privacidad, cookies, términos
│   │   ├── practices/    # Prácticas y sedes
│   │   ├── profile/      # Perfil de usuario
│   │   ├── reports/      # Exportación CSV, PDF, XLSX
│   │   ├── rotations/    # Calendarios de rotación
│   │   ├── students/     # Listado y progreso de estudiantes
│   │   └── teacher/      # Panel del docente supervisor
│   └── shared/
│       ├── backend/      # Supabase clients + lógica de negocio
│       └── components/   # Layout, RoleGuard, shadcn/ui primitives
├── supabase/
│   ├── functions/        # Edge Functions (Deno)
│   └── migrations/       # Scripts SQL aplicados en Supabase Cloud
└── .env.local            # Variables de entorno (gitignored)
```

---

## Flujo de trabajo Git

```bash
# Crear rama por historia de usuario
git checkout -b feature/HU-XX-descripcion

# Commit semántico
git commit -m "feat: descripción del cambio"

# Abrir Pull Request hacia main
# Se requiere revisión antes de fusionar
```

**Prefijos válidos:** `feat:` `fix:` `docs:` `refactor:` `test:` `chore:` `ci:` `perf:` `merge:`

`main` tiene protección de rama: no se puede pushear directo ni hacer force-push, y el PR necesita el CI en verde antes de mergear.

---

## Equipo

**Mantenedores actuales**

| Nombre                            | Carné     | GitHub                                         |
| --------------------------------- | --------- | ---------------------------------------------- |
| Carlos Alberto Granados Amaya     | U20240579 | [@Carlos-Gnd](https://github.com/Carlos-Gnd)   |
| René Francisco Pacheco Araniva    | U20240844 | [@ReneAraniva](https://github.com/ReneAraniva) |

**Equipo original (Ciclo I-2026)**

| Nombre                            | Carné     | GitHub                                         |
| --------------------------------- | --------- | ---------------------------------------------- |
| Nelson René Rodríguez Quintanilla | U20240270 | [@NelsonDev10](https://github.com/NelsonDev10) |
| Verónica Nataly Morales Jiménez   | U20220902 | [@natalyxh](https://github.com/natalyxh)       |
| David Alexander Urias Blanco      | U20240435 | [@Dalex1905](https://github.com/Dalex1905)     |

**Cátedra:** Diseño de Componentes Web — Ing. José Adolfo Herrera Funes — UNIVO Ciclo I-2026

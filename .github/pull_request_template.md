## Qué cambia y por qué

<!-- Resumen corto. Si cierra una tarea del sprint, referenciala (ej. C1-04, R1-02). -->

## Cómo se probó

<!-- Comandos corridos, o "CI" si alcanza con el pipeline. Para cambios de RLS/migraciones,
     indicar si se corrió supabase db reset en limpio. -->

## Checklist

- [ ] `pnpm build` / `tsc --noEmit` en verde localmente (o vía CI)
- [ ] Sin secretos en el diff
- [ ] Si toca `supabase/migrations/`: probado con `supabase db reset` en limpio
- [ ] Si toca RLS/políticas: agregado o actualizado un caso en `rlsSecurity.test.ts`

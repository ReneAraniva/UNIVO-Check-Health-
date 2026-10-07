-- Auditoría 2026-10-06 · A-1 — La migración A-07 (20260626000004) hacía
-- `REVOKE ... FROM public`, pero en Supabase cada función nueva recibe además un
-- GRANT EXPLÍCITO a anon y authenticated (default privileges del rol postgres).
-- Quitarlo de PUBLIC no toca esos grants: el volcado de producción del 2026-09-10
-- seguía mostrando `GRANT ALL ... TO "anon"` en 47 funciones. Explotable sin login:
--   · rate_limit_hit('checkin', <uuid>) en bucle → bloquea el check-in de un alumno.
--   · verify_security_answer → fuerza bruta de respuestas SIN rate limit.
--   · fn_retry_pending_outbox / close_due_cycles / fn_enqueue_checkout_reminders →
--     ejecutan escrituras SECURITY DEFINER fuera del cron.

DO $$
DECLARE
  r record;
BEGIN
  -- ── anon: nada salvo las 2 RPC previas al login ───────────────────────────────
  FOR r IN
    SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prokind = 'f'
      AND p.proname NOT IN ('get_security_question', 'email_for_login')
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%I(%s) FROM anon, public', r.proname, r.args);
  END LOOP;

  -- ── authenticated: fuera las funciones internas (cron, colas, utilitarios de
  -- servidor) y todos los handlers de trigger. Un trigger NO necesita que quien
  -- dispara el evento tenga EXECUTE sobre su función, así que esto no rompe nada.
  FOR r IN
    SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prokind = 'f'
      AND (
        p.prorettype = 'trigger'::regtype
        OR p.proname IN (
          'close_due_cycles',
          'fn_retry_pending_outbox',
          'fn_enqueue_checkout_reminders',
          'fn_log_omission_alert',
          'fn_detect_open_attendances',
          'fn_run_open_attendance_omission_job',
          'fn_generate_checkout_omission_alert',
          'fn_check_compliance_and_notify',
          'rate_limit_hit',
          'verify_security_answer',
          'detect_device_fingerprint_conflict'
        )
      )
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%I(%s) FROM authenticated', r.proname, r.args);
  END LOOP;

  -- Las Edge Functions las siguen usando con service_role.
  FOR r IN
    SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('rate_limit_hit', 'verify_security_answer', 'detect_device_fingerprint_conflict',
                        'validate_location_coherence', 'validate_checkin_area')
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%I(%s) TO service_role', r.proname, r.args);
  END LOOP;
END;
$$;

-- Funciones futuras: que anon no herede EXECUTE automáticamente. (authenticated
-- sigue heredándolo para no romper RPC nuevas; si se crea una función interna,
-- revocarla explícitamente — el arnés rlsSecurity.test.ts lo verifica.)
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM anon, public;

-- ── M-2 — audit_log: el cliente solo escribe eventos de UI, no de seguridad ────
-- Antes cualquier `authenticated` insertaba cualquier acción (CYCLE_CLOSED,
-- FAKE_GPS_DETECTED, DELEGATED_USER_DELETED…) con detalles arbitrarios: la
-- auditoría era falsificable. Los eventos de seguridad ya los escriben las Edge
-- Functions (service_role) y las RPC SECURITY DEFINER.
DROP POLICY IF EXISTS "audit_log_insert_authenticated" ON public.audit_log;
CREATE POLICY "audit_log_insert_authenticated" ON public.audit_log
  FOR INSERT TO authenticated
  WITH CHECK (
    actor_user_id = auth.uid()
    AND action IN ('UI_ERROR', 'SIGN_OUT')
    AND target_user_id IS NULL
  );

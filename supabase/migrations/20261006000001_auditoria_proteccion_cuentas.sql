-- Auditoría 2026-10-06 · C-1 — Un COORDINADOR podía apoderarse de la cuenta de un
-- ADMIN (o de cualquier usuario):
--   1. La política coordinators_update_users permite UPDATE sobre CUALQUIER fila.
--   2. fn_protect_users_columns no protegía security_answer_hash ni backup_email.
--   3. Con eso, el coordinador fija respaldo + respuesta de seguridad de la víctima,
--      pide recovery-otp y recibe la contraseña temporal en su correo.
-- Además coordinators_read_all_users exponía security_answer_hash (bcrypt) de todos,
-- crackeable offline por la poca entropía de las respuestas.

-- ── 1. Columnas de recuperación/sesión: solo el dueño (o el sistema) ───────────
-- Bug colateral encontrado en la misma auditoría: el trigger anterior solo dejaba
-- pasar a service_role, pero dentro de una RPC SECURITY DEFINER auth.role() sigue
-- siendo 'authenticated'. Resultado: complete_password_change (cambio de
-- contraseña obligatorio del primer ingreso) fallaba con "No autorizado" desde el
-- 2026-08-31.
--
-- Ahora la función es SECURITY INVOKER para que current_user refleje QUIÉN escribe:
--   · 'authenticated' / 'anon'  → Data API directa: se aplican todas las reglas.
--   · 'postgres' (u otro owner) → una RPC SECURITY DEFINER revisada
--     (complete_password_change, set_security_question, set_active_session…):
--     confiamos en su propia validación.
CREATE OR REPLACE FUNCTION public.fn_protect_users_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  IF auth.role() = 'service_role' OR current_user NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;

  IF NEW.role                   IS DISTINCT FROM OLD.role
     OR NEW.is_active            IS DISTINCT FROM OLD.is_active
     OR NEW.student_code         IS DISTINCT FROM OLD.student_code
     OR NEW.must_change_password IS DISTINCT FROM OLD.must_change_password
     OR NEW.academic_level       IS DISTINCT FROM OLD.academic_level
     OR NEW.career               IS DISTINCT FROM OLD.career
     OR NEW.email                IS DISTINCT FROM OLD.email
     OR NEW.campus_id            IS DISTINCT FROM OLD.campus_id
     OR NEW.created_at           IS DISTINCT FROM OLD.created_at
     OR NEW.id                   IS DISTINCT FROM OLD.id
  THEN
    RAISE EXCEPTION 'No autorizado: esta columna de users solo puede modificarla el sistema.'
      USING ERRCODE = '42501';
  END IF;

  -- Nadie más que el propio usuario toca sus datos de recuperación o su sesión.
  IF auth.uid() IS DISTINCT FROM OLD.id AND (
       NEW.security_answer_hash IS DISTINCT FROM OLD.security_answer_hash
    OR NEW.security_question    IS DISTINCT FROM OLD.security_question
    OR NEW.backup_email         IS DISTINCT FROM OLD.backup_email
    OR NEW.active_session_id    IS DISTINCT FROM OLD.active_session_id
    OR NEW.accepted_legal_at      IS DISTINCT FROM OLD.accepted_legal_at
    OR NEW.accepted_legal_version IS DISTINCT FROM OLD.accepted_legal_version
  ) THEN
    RAISE EXCEPTION 'No autorizado: solo el titular puede cambiar sus datos de recuperación.'
      USING ERRCODE = '42501';
  END IF;

  -- El hash de la respuesta solo se escribe vía set_security_question (que lo
  -- calcula con bcrypt); por la Data API alguien podría pegar un hash arbitrario.
  IF NEW.security_answer_hash IS DISTINCT FROM OLD.security_answer_hash THEN
    RAISE EXCEPTION 'Usa la opción "pregunta de seguridad" del perfil para cambiarla.'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

-- ── 2. Un coordinador no edita filas de ADMIN ───────────────────────────────────
DROP POLICY IF EXISTS "coordinators_update_users" ON public.users;
CREATE POLICY "coordinators_update_users" ON public.users
  FOR UPDATE TO authenticated
  USING (
    upper(public.get_current_user_role()) = 'ADMIN'
    OR (
      upper(public.get_current_user_role()) IN ('COORDINATOR', 'COORDINADOR')
      AND upper(role) NOT IN ('ADMIN', 'ADMINISTRADOR', 'DECANO')
    )
  )
  WITH CHECK (
    upper(public.get_current_user_role()) = 'ADMIN'
    OR (
      upper(public.get_current_user_role()) IN ('COORDINATOR', 'COORDINADOR')
      AND upper(role) NOT IN ('ADMIN', 'ADMINISTRADOR', 'DECANO')
    )
  );

-- ── 3. security_answer_hash fuera de la Data API ───────────────────────────────
-- Permiso de SELECT por columna: todas menos el hash. Solo lo leen las funciones
-- SECURITY DEFINER (verify_security_answer) y service_role.
-- OJO: una columna nueva en users NO queda legible por authenticated hasta
-- agregarla con GRANT SELECT (col) — es intencional (lista blanca).
DO $$
DECLARE
  v_cols text;
BEGIN
  SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position)
    INTO v_cols
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'users'
    AND column_name <> 'security_answer_hash';

  EXECUTE 'REVOKE SELECT ON public.users FROM anon, authenticated';
  EXECUTE format('GRANT SELECT (%s) ON public.users TO authenticated', v_cols);
END;
$$;

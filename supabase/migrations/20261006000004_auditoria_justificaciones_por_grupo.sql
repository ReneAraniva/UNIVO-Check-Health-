-- Auditoría 2026-10-06 · M-3 — Cualquier DOCENTE leía y modificaba TODAS las
-- justificaciones del sistema, no solo las de los alumnos de su grupo, y el WITH
-- CHECK no restringía columnas: un revisor podía reescribir el motivo, el
-- documento o reasignar la justificación a otro alumno.

DROP POLICY IF EXISTS "reviewers_select_justifications" ON public.justifications;
CREATE POLICY "reviewers_select_justifications" ON public.justifications
  FOR SELECT TO authenticated
  USING (
    upper(coalesce(public.get_current_user_role(), '')) IN ('ADMIN', 'COORDINATOR', 'COORDINADOR')
    OR (
      upper(coalesce(public.get_current_user_role(), '')) IN ('TEACHER', 'DOCENTE')
      AND EXISTS (
        SELECT 1 FROM public.teacher_groups tg
        WHERE tg.teacher_id = auth.uid()
          AND tg.student_id = justifications.student_id
      )
    )
  );

DROP POLICY IF EXISTS "reviewers_update_justifications" ON public.justifications;
CREATE POLICY "reviewers_update_justifications" ON public.justifications
  FOR UPDATE TO authenticated
  USING (
    upper(coalesce(public.get_current_user_role(), '')) IN ('ADMIN', 'COORDINATOR', 'COORDINADOR')
    OR (
      upper(coalesce(public.get_current_user_role(), '')) IN ('TEACHER', 'DOCENTE')
      AND EXISTS (
        SELECT 1 FROM public.teacher_groups tg
        WHERE tg.teacher_id = auth.uid()
          AND tg.student_id = justifications.student_id
      )
    )
  )
  WITH CHECK (
    status IN ('PENDIENTE', 'APROBADO', 'RECHAZADO')
    AND (
      upper(coalesce(public.get_current_user_role(), '')) IN ('ADMIN', 'COORDINATOR', 'COORDINADOR')
      OR (
        upper(coalesce(public.get_current_user_role(), '')) IN ('TEACHER', 'DOCENTE')
        AND EXISTS (
          SELECT 1 FROM public.teacher_groups tg
          WHERE tg.teacher_id = auth.uid()
            AND tg.student_id = justifications.student_id
        )
      )
    )
  );

-- El revisor decide (status, notas); lo que escribió el alumno no se toca.
CREATE OR REPLACE FUNCTION public.fn_protect_justification_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  IF auth.role() = 'service_role' OR current_user NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;

  IF NEW.student_id           IS DISTINCT FROM OLD.student_id
     OR NEW.attendance_id     IS DISTINCT FROM OLD.attendance_id
     OR NEW.motivo            IS DISTINCT FROM OLD.motivo
     OR NEW.documento_url     IS DISTINCT FROM OLD.documento_url
     OR NEW.creado_en         IS DISTINCT FROM OLD.creado_en
     OR NEW.absence_date      IS DISTINCT FROM OLD.absence_date
     OR NEW.absence_campus_id IS DISTINCT FROM OLD.absence_campus_id
  THEN
    RAISE EXCEPTION 'No autorizado: el contenido de la justificación solo lo define el alumno.'
      USING ERRCODE = '42501';
  END IF;

  -- La decisión queda firmada por quien la toma, no por quien diga el cliente.
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.revisado_por := auth.uid();
  END IF;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_protect_justification_columns() FROM anon, authenticated, public;

DROP TRIGGER IF EXISTS trg_aa_protect_justification_columns ON public.justifications;
CREATE TRIGGER trg_aa_protect_justification_columns
  BEFORE UPDATE ON public.justifications
  FOR EACH ROW EXECUTE FUNCTION public.fn_protect_justification_columns();

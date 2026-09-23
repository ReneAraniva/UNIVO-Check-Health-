-- Schema actual de la base de datos (esquema public).
-- Extraído del proyecto Supabase hhddnhofyilsdaltzpeh el 2026-09-10
-- vía: supabase db dump --linked --schema public
--
-- Incluye: 27 tablas, 2 vistas, funciones (RPCs), triggers, políticas RLS,
-- índices y grants. Es solo estructura (sin datos).
--
-- Para refrescarlo: cd Check-Health && npx supabase db dump --linked --schema public -f docs/backend/schema_actual_completo.sql


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE SCHEMA IF NOT EXISTS "public";


ALTER SCHEMA "public" OWNER TO "pg_database_owner";


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE OR REPLACE FUNCTION "public"."accept_legal_terms"("p_version" "text") RETURNS "void"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  UPDATE public.users
     SET accepted_legal_at = now(),
         accepted_legal_version = p_version
   WHERE id = auth.uid();
$$;


ALTER FUNCTION "public"."accept_legal_terms"("p_version" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."audit_delegated_client_change"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_actor_role text := upper(public.get_current_user_role());
  v_record_id text := CASE WHEN TG_OP = 'DELETE' THEN OLD.id::text ELSE NEW.id::text END;
  v_target uuid := NULL;
  v_action text;
BEGIN
  IF v_actor IS NULL THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  IF v_actor_role NOT IN ('ADMIN', 'COORDINATOR', 'COORDINADOR', 'TEACHER', 'DOCENTE') THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'users' THEN
    v_target := CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END;
    v_action := CASE TG_OP
      WHEN 'INSERT' THEN 'DELEGATED_USER_CREATED'
      WHEN 'UPDATE' THEN 'DELEGATED_USER_UPDATED'
      WHEN 'DELETE' THEN 'DELEGATED_USER_DELETED'
      ELSE 'DELEGATED_USER_CHANGED'
    END;
  ELSIF TG_TABLE_NAME = 'campuses' THEN
    v_action := CASE TG_OP
      WHEN 'INSERT' THEN 'DELEGATED_CAMPUS_CREATED'
      WHEN 'UPDATE' THEN 'DELEGATED_CAMPUS_UPDATED'
      WHEN 'DELETE' THEN 'DELEGATED_CAMPUS_DELETED'
      ELSE 'DELEGATED_CAMPUS_CHANGED'
    END;
  ELSE
    v_action := 'DELEGATED_' || upper(TG_TABLE_NAME) || '_' || TG_OP;
  END IF;

  INSERT INTO public.audit_log(action, actor_user_id, target_user_id, details)
  VALUES (
    v_action,
    v_actor,
    v_target,
    jsonb_build_object(
      'actor_role', v_actor_role,
      'table', TG_TABLE_NAME,
      'operation', TG_OP,
      'record_id', v_record_id,
      'new', CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) ELSE NULL END,
      'old', CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) ELSE NULL END
    )
  );

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."audit_delegated_client_change"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."block_audit_mutation"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  raise exception 'audit_log is append-only; updates/deletes are not allowed';
end;
$$;


ALTER FUNCTION "public"."block_audit_mutation"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."close_due_cycles"() RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_today    date := (now() AT TIME ZONE 'America/El_Salvador')::date;
  v_row      record;
  v_hours    numeric;
  v_required numeric;
  v_status   text;
  v_count    integer := 0;
BEGIN
  FOR v_row IN
    SELECT id, student_id, campus_id, subject_id, start_date, end_date, required_hours
    FROM public.teacher_groups
    WHERE end_date IS NOT NULL
      AND end_date < v_today
      AND closed_at IS NULL
  LOOP
    SELECT COALESCE(SUM(a.worked_hours), 0) INTO v_hours
    FROM public.attendances a
    WHERE a.student_id = v_row.student_id
      AND a.campus_id  = v_row.campus_id
      AND a.check_out IS NOT NULL
      AND upper(COALESCE(a.review_status, '')) <> 'OBSERVADO'
      AND (v_row.start_date IS NULL OR a.check_in::date >= v_row.start_date)
      AND a.check_in::date <= v_row.end_date;

    -- Precedencia: horas de la asignación → de la materia → 240.
    IF v_row.required_hours IS NOT NULL THEN
      v_required := v_row.required_hours;
    ELSE
      SELECT COALESCE(required_hours, 240) INTO v_required
      FROM public.subjects WHERE id = v_row.subject_id;
      v_required := COALESCE(v_required, 240);
    END IF;

    v_status := CASE WHEN v_hours >= v_required THEN 'COMPLETED' ELSE 'INCOMPLETE' END;

    UPDATE public.teacher_groups
       SET closed_at = now(), audited_hours = v_hours, closure_status = v_status
     WHERE id = v_row.id;

    INSERT INTO public.audit_log (action, actor_user_id, target_user_id, details)
    VALUES ('CYCLE_CLOSED', v_row.student_id, v_row.student_id,
            jsonb_build_object(
              'assignment_id',  v_row.id,
              'subject_id',     v_row.subject_id,
              'campus_id',      v_row.campus_id,
              'audited_hours',  v_hours,
              'required_hours', v_required,
              'status',         v_status,
              'period_end',     v_row.end_date));

    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$$;


ALTER FUNCTION "public"."close_due_cycles"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."complete_password_change"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;
  UPDATE public.users SET must_change_password = false WHERE id = auth.uid();
END;
$$;


ALTER FUNCTION "public"."complete_password_change"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."confirm_hospital_presence_tech_failure"("p_student_id" "uuid", "p_campus_id" "uuid", "p_representative_name" "text", "p_representative_role" "text" DEFAULT NULL::"text", "p_reason" "text" DEFAULT NULL::"text", "p_confirmed_at" timestamp with time zone DEFAULT "now"()) RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_actor_role text := upper(public.get_current_user_role());
  v_attendance_id uuid;
  v_student public.users;
  v_campus public.campuses;
  v_rep_name text := nullif(trim(p_representative_name), '');
  v_rep_role text := nullif(trim(coalesce(p_representative_role, '')), '');
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Sesion requerida.';
  END IF;

  IF v_actor_role NOT IN ('ADMIN', 'COORDINATOR', 'COORDINADOR', 'TEACHER', 'DOCENTE') THEN
    RAISE EXCEPTION 'No autorizado para confirmar presencia por falla tecnica.';
  END IF;

  IF v_rep_name IS NULL OR length(v_rep_name) < 3 THEN
    RAISE EXCEPTION 'Nombre del representante requerido.';
  END IF;

  SELECT * INTO v_student FROM public.users WHERE id = p_student_id AND upper(role) = 'STUDENT';
  IF v_student.id IS NULL THEN
    RAISE EXCEPTION 'Estudiante no encontrado.';
  END IF;

  SELECT * INTO v_campus FROM public.campuses WHERE id = p_campus_id;
  IF v_campus.id IS NULL THEN
    RAISE EXCEPTION 'Sede no encontrada.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.attendances
    WHERE student_id = p_student_id
      AND check_out IS NULL
  ) THEN
    RAISE EXCEPTION 'El estudiante ya tiene una asistencia activa.';
  END IF;

  INSERT INTO public.attendances (
    student_id,
    campus_id,
    check_in,
    date,
    status,
    notes,
    review_status,
    suspicious_reason
  )
  VALUES (
    p_student_id,
    p_campus_id,
    coalesce(p_confirmed_at, now()),
    coalesce(p_confirmed_at, now())::date,
    'present',
    concat_ws(
      ' ',
      'Confirmacion manual por falla tecnica.',
      'Representante:', v_rep_name || '.',
      CASE WHEN v_reason IS NOT NULL THEN 'Motivo: ' || v_reason ELSE NULL END
    ),
    'CONFIRMADO_REPRESENTANTE',
    'Presencia confirmada por representante de sede ante falla tecnica.'
  )
  RETURNING id INTO v_attendance_id;

  INSERT INTO public.audit_log(action, actor_user_id, target_user_id, details)
  VALUES (
    'HOSPITAL_TECH_FAILURE_PRESENCE_CONFIRMED',
    v_actor,
    p_student_id,
    jsonb_build_object(
      'attendance_id', v_attendance_id,
      'campus_id', p_campus_id,
      'campus_name', v_campus.name,
      'student_code', v_student.student_code,
      'student_name', v_student.full_name,
      'representative_name', v_rep_name,
      'representative_role', v_rep_role,
      'reason', v_reason,
      'confirmed_at', coalesce(p_confirmed_at, now()),
      'actor_role', v_actor_role,
      'source', 'confirm_hospital_presence_tech_failure'
    )
  );

  RETURN v_attendance_id;
END;
$$;


ALTER FUNCTION "public"."confirm_hospital_presence_tech_failure"("p_student_id" "uuid", "p_campus_id" "uuid", "p_representative_name" "text", "p_representative_role" "text", "p_reason" "text", "p_confirmed_at" timestamp with time zone) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."decide_assignment_goal"("p_assignment_id" "uuid", "p_decision" "text", "p_note" "text" DEFAULT NULL::"text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_actor    uuid := auth.uid();
  v_role     text := upper(coalesce(public.get_current_user_role(), ''));
  v_assign   record;
  v_decision text := upper(trim(coalesce(p_decision, '')));
BEGIN
  IF v_decision NOT IN ('APROBADO', 'REPROBADO') THEN
    RAISE EXCEPTION 'Decisión inválida (usa APROBADO o REPROBADO).';
  END IF;

  SELECT id, teacher_id, student_id INTO v_assign
  FROM public.teacher_groups WHERE id = p_assignment_id;
  IF v_assign.id IS NULL THEN
    RAISE EXCEPTION 'Asignación no encontrada.';
  END IF;

  -- Solo el docente de la asignación, un coordinador o el admin pueden decidir.
  IF NOT (v_assign.teacher_id = v_actor OR v_role IN ('ADMIN', 'COORDINATOR', 'COORDINADOR')) THEN
    RAISE EXCEPTION 'No autorizado para decidir la meta de esta asignación.';
  END IF;

  UPDATE public.teacher_groups
     SET goal_decision      = v_decision,
         goal_decided_by    = v_actor,
         goal_decided_at    = now(),
         goal_decision_note = nullif(trim(coalesce(p_note, '')), '')
   WHERE id = p_assignment_id;

  INSERT INTO public.audit_log (action, actor_user_id, target_user_id, details)
  VALUES ('GOAL_DECISION', v_actor, v_assign.student_id,
          jsonb_build_object(
            'assignment_id', p_assignment_id,
            'decision',      v_decision,
            'note',          nullif(trim(coalesce(p_note, '')), '')));
END;
$$;


ALTER FUNCTION "public"."decide_assignment_goal"("p_assignment_id" "uuid", "p_decision" "text", "p_note" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."detect_device_fingerprint_conflict"("p_device_fingerprint" "text", "p_campus_id" "uuid", "p_student_id" "uuid") RETURNS TABLE("attendance_id" "uuid", "student_id" "uuid", "campus_id" "uuid", "check_in" timestamp with time zone)
    LANGUAGE "sql" STABLE
    AS $$
  select a.id, a.student_id, a.campus_id, a.check_in
  from public.attendances a
  where a.device_fingerprint = p_device_fingerprint
    and a.check_out is null
    and a.campus_id <> p_campus_id
    and a.student_id <> p_student_id
  order by a.check_in desc
  limit 1
$$;


ALTER FUNCTION "public"."detect_device_fingerprint_conflict"("p_device_fingerprint" "text", "p_campus_id" "uuid", "p_student_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."email_for_login"("p_identifier" "text") RETURNS "text"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT email
  FROM public.users
  WHERE lower(email) = lower(trim(p_identifier))
     OR upper(student_code) = upper(trim(p_identifier))
  LIMIT 1;
$$;


ALTER FUNCTION "public"."email_for_login"("p_identifier" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."enforce_assignment_gate"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_gate record;
BEGIN
  -- Service role se usa para seeds/backfills y no representa una accion manual.
  IF auth.role() = 'service_role' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
     AND NEW.student_id IS NOT DISTINCT FROM OLD.student_id
     AND NEW.subject_id IS NOT DISTINCT FROM OLD.subject_id THEN
    RETURN NEW;
  END IF;

  -- Override del decano: si existe una concesion para (alumno, materia), se permite.
  IF NEW.subject_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.assignment_gate_overrides o
    WHERE o.student_id = NEW.student_id
      AND o.subject_id = NEW.subject_id
  ) THEN
    RETURN NEW;
  END IF;

  SELECT *
    INTO v_gate
  FROM public.validate_assignment_gate(NEW.student_id, NEW.subject_id)
  LIMIT 1;

  IF NOT COALESCE(v_gate.ok, false) THEN
    RAISE EXCEPTION '%', COALESCE(v_gate.message, 'El alumno no cumple los requisitos de la materia.');
  END IF;

  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."enforce_assignment_gate"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."enforce_campus_capacity"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_max     integer;
  v_current integer;
BEGIN
  IF auth.role() = 'service_role' THEN
    RETURN NEW;  -- seeds/backfills no cuentan como acción manual
  END IF;
  IF NEW.campus_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT max_students INTO v_max FROM public.campuses WHERE id = NEW.campus_id;
  IF v_max IS NULL THEN
    RETURN NEW;  -- sin cupo definido = sin límite
  END IF;

  -- Estudiantes distintos ya asignados a la sede en el mismo período (ciclo abierto).
  SELECT count(DISTINCT student_id) INTO v_current
  FROM public.teacher_groups
  WHERE campus_id = NEW.campus_id
    AND period = NEW.period
    AND closed_at IS NULL
    AND student_id <> NEW.student_id
    AND (TG_OP = 'INSERT' OR id <> NEW.id);

  IF v_current >= v_max THEN
    RAISE EXCEPTION 'La sede alcanzó su cupo máximo de % estudiantes para el período %.', v_max, NEW.period;
  END IF;

  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."enforce_campus_capacity"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."escalate_justification"("p_id" "uuid", "p_nota" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_role text;
  v_status text;
BEGIN
  v_role := upper(public.get_current_user_role());
  IF v_role NOT IN ('ADMIN', 'COORDINATOR', 'COORDINADOR') THEN
    RAISE EXCEPTION 'Solo un coordinador puede escalar una justificación';
  END IF;

  SELECT status INTO v_status FROM public.justifications WHERE id = p_id;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'Justificación no encontrada';
  END IF;
  IF v_status <> 'RECHAZADO' THEN
    RAISE EXCEPTION 'Solo se pueden escalar justificaciones rechazadas';
  END IF;

  UPDATE public.justifications
  SET escalated     = true,
      escalated_at  = now(),
      escalated_by  = auth.uid(),
      status        = 'PENDIENTE',
      notas_revisor = COALESCE(p_nota, 'Escalada para segunda revisión.')
  WHERE id = p_id;
END;
$$;


ALTER FUNCTION "public"."escalate_justification"("p_id" "uuid", "p_nota" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."fn_check_location_mismatch"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  v_lat_in   numeric;
  v_lng_in   numeric;
  v_lat_out  numeric;
  v_lng_out  numeric;
  v_dist     numeric;
  v_threshold numeric := 150;
BEGIN
  IF NEW.check_out_location IS NULL OR NEW.check_in_location IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(value::numeric, 150) INTO v_threshold
  FROM public.system_config WHERE key = 'location_mismatch_threshold_m';
  v_threshold := COALESCE(v_threshold, 150);

  v_lat_in  := (NEW.check_in_location->>'latitude')::numeric;
  v_lng_in  := (NEW.check_in_location->>'longitude')::numeric;
  v_lat_out := (NEW.check_out_location->>'latitude')::numeric;
  v_lng_out := (NEW.check_out_location->>'longitude')::numeric;

  v_dist := public.haversine_meters(v_lat_in, v_lng_in, v_lat_out, v_lng_out);

  IF v_dist > v_threshold THEN
    NEW.location_mismatch  := true;
    NEW.review_status      := 'OBSERVADO';
    NEW.suspicious_reason  := format(
      '%s Discrepancia de ubicación: %.0f m entre entrada y salida (umbral %.0f m).',
      COALESCE(NEW.suspicious_reason || ' ', ''), v_dist, v_threshold
    );
  END IF;

  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."fn_check_location_mismatch"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."fn_compliance_alert"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  v_threshold numeric;
  v_goal      numeric;
  v_total_h   numeric;
  v_pct       numeric;
BEGIN
  SELECT COALESCE(value::numeric, 60)  INTO v_threshold FROM public.system_config WHERE key = 'compliance_alert_threshold_pct';
  SELECT COALESCE(value::numeric, 240) INTO v_goal      FROM public.system_config WHERE key = 'required_practice_hours';
  v_threshold := COALESCE(v_threshold, 60);
  v_goal      := COALESCE(v_goal, 240);

  SELECT COALESCE(SUM(worked_hours), 0) INTO v_total_h
  FROM public.attendances WHERE student_id = NEW.student_id AND check_out IS NOT NULL;

  v_pct := ROUND((v_total_h / NULLIF(v_goal, 0)) * 100, 1);

  IF v_pct < v_threshold THEN
    INSERT INTO public.audit_log(action, actor_user_id, target_user_id, details)
    VALUES ('compliance_alert', NEW.student_id, NEW.student_id,
      jsonb_build_object(
        'compliance_pct', v_pct, 'threshold', v_threshold,
        'total_hours', v_total_h, 'goal_hours', v_goal,
        'attendance_id', NEW.id
      )
    );
    -- Notificar al propio alumno
    INSERT INTO public.notification_outbox (channel, type, target_user_id, attendance_id, payload)
    SELECT channels.channel, 'COMPLIANCE_ALERT', NEW.student_id, NEW.id,
           jsonb_build_object(
             'compliance_pct', v_pct, 'threshold', v_threshold,
             'recipient_email', u.email
           )
    FROM   public.users u
    CROSS JOIN (VALUES ('push'), ('email')) AS channels(channel)
    WHERE  u.id = NEW.student_id;
  END IF;

  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."fn_compliance_alert"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."fn_detect_open_attendances"("p_max_hours" numeric DEFAULT 12) RETURNS TABLE("student_id" "uuid", "attendance_id" "uuid", "hours_open" numeric)
    LANGUAGE "sql"
    AS $$
  SELECT
    a.student_id,
    a.id,
    ROUND(EXTRACT(EPOCH FROM (now() - a.check_in)) / 3600.0, 1)
  FROM public.attendances a
  WHERE a.check_out IS NULL
    AND EXTRACT(EPOCH FROM (now() - a.check_in)) / 3600.0 > p_max_hours;
$$;


ALTER FUNCTION "public"."fn_detect_open_attendances"("p_max_hours" numeric) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."fn_dispatch_outbox_item"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'net'
    AS $$
DECLARE
  v_project_url text;
  v_secret      text;
  v_anon        text;
BEGIN
  SELECT value INTO v_project_url FROM public.system_config WHERE key = 'supabase_project_url';
  SELECT value INTO v_secret      FROM public.system_config WHERE key = 'dispatch_webhook_secret';
  SELECT value INTO v_anon        FROM public.system_config WHERE key = 'supabase_anon_key';

  IF v_project_url IS NULL OR v_secret IS NULL OR v_anon IS NULL THEN
    RETURN NEW;
  END IF;

  PERFORM net.http_post(
    url     := v_project_url || '/functions/v1/notify-dispatcher',
    body    := jsonb_build_object('outbox_id', NEW.id),
    headers := jsonb_build_object(
      'Authorization',     'Bearer ' || v_anon,
      'x-dispatch-secret', v_secret,
      'Content-Type',      'application/json'
    )
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- No bloquear la transacción si la llamada falla; el item queda en 'pending' para reintento.
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."fn_dispatch_outbox_item"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."fn_enqueue_checkout_reminders"() RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_after_hours numeric;
  v_row record;
  v_count integer := 0;
BEGIN
  SELECT COALESCE(value::numeric, 6) INTO v_after_hours
  FROM public.system_config WHERE key = 'checkout_reminder_after_hours';
  v_after_hours := COALESCE(v_after_hours, 6);

  FOR v_row IN
    SELECT a.id AS attendance_id, a.student_id, u.email,
           ROUND(EXTRACT(EPOCH FROM (now() - a.check_in)) / 3600.0, 1) AS hours_open
    FROM public.attendances a
    JOIN public.users u ON u.id = a.student_id
    WHERE a.check_out IS NULL
      AND EXTRACT(EPOCH FROM (now() - a.check_in)) / 3600.0 >= v_after_hours
      -- evitar duplicados: que no se haya encolado ya un recordatorio para esta asistencia
      AND NOT EXISTS (
        SELECT 1 FROM public.notification_outbox n
        WHERE n.type = 'CHECKOUT_REMINDER' AND n.attendance_id = a.id
      )
  LOOP
    INSERT INTO public.notification_outbox (channel, type, target_user_id, attendance_id, payload)
    SELECT channels.channel, 'CHECKOUT_REMINDER', v_row.student_id, v_row.attendance_id,
           jsonb_build_object('hours_open', v_row.hours_open, 'recipient_email', v_row.email)
    FROM (VALUES ('push'), ('email')) AS channels(channel);
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;


ALTER FUNCTION "public"."fn_enqueue_checkout_reminders"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."fn_log_justification_decision"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  -- Solo cuando el estado cambia (aprobado/rechazado) o se escala
  IF NEW.status IS DISTINCT FROM OLD.status OR NEW.escalated IS DISTINCT FROM OLD.escalated THEN
    INSERT INTO public.audit_log (action, actor_user_id, target_user_id, details)
    VALUES (
      CASE WHEN NEW.escalated AND NOT OLD.escalated THEN 'JUSTIFICATION_ESCALATED'
           ELSE 'JUSTIFICATION_REVIEWED' END,
      COALESCE(NEW.revisado_por, NEW.escalated_by, NEW.student_id),
      NEW.student_id,
      jsonb_build_object(
        'justification_id', NEW.id,
        'attendance_id',    NEW.attendance_id,
        'status_anterior',  OLD.status,
        'status_nuevo',     NEW.status,
        'escalated',        NEW.escalated,
        'notas_revisor',    NEW.notas_revisor
      )
    );
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."fn_log_justification_decision"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."fn_log_omission_alert"("p_attendance_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql"
    AS $$
DECLARE v_att record;
BEGIN
  SELECT * INTO v_att FROM public.attendances WHERE id = p_attendance_id;
  IF v_att IS NULL THEN RETURN; END IF;

  IF EXISTS (
    SELECT 1 FROM public.audit_log
    WHERE  action = 'omission_alert'
    AND    details->>'attendance_id' = p_attendance_id::text
  ) THEN RETURN; END IF;

  INSERT INTO public.audit_log(action, actor_user_id, target_user_id, details)
  VALUES (
    'omission_alert', v_att.student_id, v_att.student_id,
    jsonb_build_object(
      'attendance_id', p_attendance_id,
      'campus_id',     v_att.campus_id,
      'check_in',      v_att.check_in,
      'hours_open',    ROUND(EXTRACT(EPOCH FROM (now() - v_att.check_in)) / 3600.0, 1)
    )
  );

  PERFORM public.fn_queue_coordinator_notification(
    'OMISSION_ALERT', p_attendance_id,
    jsonb_build_object(
      'attendance_id', p_attendance_id,
      'campus_id',     v_att.campus_id,
      'hours_open',    ROUND(EXTRACT(EPOCH FROM (now() - v_att.check_in)) / 3600.0, 1)
    )
  );
END;
$$;


ALTER FUNCTION "public"."fn_log_omission_alert"("p_attendance_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."fn_notify_justification_decision"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_student record;
  v_attendance record;
  v_payload jsonb;
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  IF NEW.status NOT IN ('APROBADO', 'RECHAZADO') THEN
    RETURN NEW;
  END IF;

  SELECT id, email, full_name, student_code
  INTO v_student
  FROM public.users
  WHERE id = NEW.student_id;

  IF v_student.id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT a.id, a.date, c.name AS campus_name
  INTO v_attendance
  FROM public.attendances a
  LEFT JOIN public.campuses c ON c.id = a.campus_id
  WHERE a.id = NEW.attendance_id;

  v_payload := jsonb_build_object(
    'justification_id', NEW.id,
    'attendance_id', NEW.attendance_id,
    'student_id', NEW.student_id,
    'student_name', COALESCE(v_student.full_name, 'Estudiante'),
    'student_code', COALESCE(v_student.student_code, ''),
    'status', NEW.status,
    'reviewer_notes', COALESCE(NEW.notas_revisor, ''),
    'attendance_date', COALESCE(v_attendance.date::text, ''),
    'campus_name', COALESCE(v_attendance.campus_name, 'Sede desconocida'),
    'recipient_email', v_student.email
  );

  INSERT INTO public.notification_outbox (channel, type, target_user_id, attendance_id, payload)
  SELECT channels.channel,
         'JUSTIFICATION_DECISION',
         NEW.student_id,
         NEW.attendance_id,
         v_payload
  FROM (VALUES ('push'), ('email')) AS channels(channel);

  INSERT INTO public.audit_log (action, actor_user_id, target_user_id, details)
  VALUES (
    'JUSTIFICATION_DECISION_NOTIFIED',
    COALESCE(NEW.revisado_por, NEW.student_id),
    NEW.student_id,
    v_payload || jsonb_build_object('channels', jsonb_build_array('push', 'email'))
  );

  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."fn_notify_justification_decision"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."fn_notify_justification_escalation"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_student record;
  v_attendance record;
  v_teacher_ids uuid[];
  v_payload jsonb;
BEGIN
  IF COALESCE(NEW.escalated, false) IS FALSE OR COALESCE(OLD.escalated, false) IS TRUE THEN
    RETURN NEW;
  END IF;

  SELECT id, email, full_name, student_code
  INTO v_student
  FROM public.users
  WHERE id = NEW.student_id;

  IF v_student.id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT a.id, a.date, a.campus_id, c.name AS campus_name
  INTO v_attendance
  FROM public.attendances a
  LEFT JOIN public.campuses c ON c.id = a.campus_id
  WHERE a.id = NEW.attendance_id;

  SELECT COALESCE(array_agg(tg.teacher_id), ARRAY[]::uuid[])
  INTO v_teacher_ids
  FROM (
    SELECT DISTINCT ON (tg.teacher_id)
      tg.teacher_id,
      tg.start_date,
      tg.end_date,
      tg.created_at
    FROM public.teacher_groups tg
    WHERE tg.student_id = NEW.student_id
      AND tg.teacher_id IS NOT NULL
      AND (tg.campus_id = v_attendance.campus_id OR tg.campus_id IS NULL)
      AND (tg.start_date IS NULL OR tg.start_date <= COALESCE(v_attendance.date, CURRENT_DATE))
      AND (tg.end_date IS NULL OR tg.end_date >= COALESCE(v_attendance.date, CURRENT_DATE))
    ORDER BY tg.teacher_id, tg.start_date DESC NULLS LAST, tg.created_at DESC
  ) tg;

  v_payload := jsonb_build_object(
    'justification_id', NEW.id,
    'attendance_id', NEW.attendance_id,
    'student_id', NEW.student_id,
    'student_name', COALESCE(v_student.full_name, 'Estudiante'),
    'student_code', COALESCE(v_student.student_code, ''),
    'attendance_date', COALESCE(v_attendance.date::text, ''),
    'campus_name', COALESCE(v_attendance.campus_name, 'Sede desconocida'),
    'escalation_note', COALESCE(NEW.notas_revisor, 'Escalada para segunda revision.'),
    'teacher_ids', v_teacher_ids
  );

  INSERT INTO public.notification_outbox (channel, type, target_user_id, attendance_id, payload)
  SELECT channels.channel,
         'JUSTIFICATION_ESCALATED',
         recipients.user_id,
         NEW.attendance_id,
         v_payload || jsonb_build_object(
           'recipient_email', recipients.email,
           'recipient_role', recipients.recipient_role
         )
  FROM (
    SELECT v_student.id AS user_id, v_student.email, 'student' AS recipient_role

    UNION

    SELECT u.id AS user_id, u.email, 'teacher' AS recipient_role
    FROM public.users u
    WHERE u.id = ANY(v_teacher_ids)
      AND u.id <> v_student.id
  ) recipients
  CROSS JOIN (VALUES ('push'), ('email')) AS channels(channel);

  INSERT INTO public.audit_log (action, actor_user_id, target_user_id, details)
  VALUES (
    'JUSTIFICATION_ESCALATION_NOTIFICATIONS_QUEUED',
    COALESCE(NEW.escalated_by, NEW.revisado_por, NEW.student_id),
    NEW.student_id,
    v_payload || jsonb_build_object(
      'channels', jsonb_build_array('push', 'email'),
      'notified_student', true,
      'notified_teacher', COALESCE(array_length(v_teacher_ids, 1), 0) > 0
    )
  );

  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."fn_notify_justification_escalation"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."fn_notify_justification_received"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_student_name text;
  v_student_code text;
  v_att_date     text;
  v_campus_name  text;
  v_campus_id    uuid;
  v_payload      jsonb;
  v_count        integer;
BEGIN
  SELECT full_name, student_code INTO v_student_name, v_student_code
  FROM public.users WHERE id = NEW.student_id;

  -- Fecha y sede: desde la asistencia si existe; si es ausencia, desde absence_*.
  IF NEW.attendance_id IS NOT NULL THEN
    SELECT a.date::text, c.name, a.campus_id
      INTO v_att_date, v_campus_name, v_campus_id
    FROM public.attendances a
    LEFT JOIN public.campuses c ON c.id = a.campus_id
    WHERE a.id = NEW.attendance_id;
  ELSE
    v_att_date  := NEW.absence_date::text;
    v_campus_id := NEW.absence_campus_id;
    SELECT name INTO v_campus_name FROM public.campuses WHERE id = NEW.absence_campus_id;
  END IF;

  v_payload := jsonb_build_object(
    'student_name',    COALESCE(v_student_name, 'Estudiante'),
    'student_code',    COALESCE(v_student_code, ''),
    'attendance_date', COALESCE(v_att_date, ''),
    'campus_name',     COALESCE(v_campus_name, 'Sede'),
    'reason',          NEW.motivo
  );

  -- Docente + coordinador asignados al alumno (en esa sede si se conoce).
  WITH recipients AS (
    SELECT DISTINCT uid FROM (
      SELECT tg.teacher_id      AS uid FROM public.teacher_groups tg
        WHERE tg.student_id = NEW.student_id
          AND (v_campus_id IS NULL OR tg.campus_id = v_campus_id)
      UNION
      SELECT tg.coordinator_id        FROM public.teacher_groups tg
        WHERE tg.student_id = NEW.student_id
          AND (v_campus_id IS NULL OR tg.campus_id = v_campus_id)
    ) ids
    WHERE uid IS NOT NULL
  )
  INSERT INTO public.notification_outbox (channel, type, target_user_id, attendance_id, payload)
  SELECT ch.channel, 'JUSTIFICATION_RECEIVED', r.uid, NEW.attendance_id,
         v_payload || jsonb_build_object('recipient_email', (SELECT email FROM public.users WHERE id = r.uid))
  FROM recipients r
  CROSS JOIN (VALUES ('push'), ('email')) AS ch(channel);

  GET DIAGNOSTICS v_count = ROW_COUNT;

  -- Fallback a ADMIN si el alumno no tenía docente/coordinador asignado (0 destinatarios).
  IF v_count = 0 THEN
    INSERT INTO public.notification_outbox (channel, type, target_user_id, attendance_id, payload)
    SELECT ch.channel, 'JUSTIFICATION_RECEIVED', u.id, NEW.attendance_id,
           v_payload || jsonb_build_object('recipient_email', u.email)
    FROM public.users u
    CROSS JOIN (VALUES ('push'), ('email')) AS ch(channel)
    WHERE upper(u.role) = 'ADMIN';
  END IF;

  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."fn_notify_justification_received"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."fn_protect_users_columns"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  IF auth.role() = 'service_role' THEN
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

  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."fn_protect_users_columns"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."fn_queue_coordinator_notification"("p_type" "text", "p_attendance_id" "uuid", "p_payload" "jsonb") RETURNS "void"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  INSERT INTO public.notification_outbox (channel, type, target_user_id, attendance_id, payload)
  SELECT channels.channel, p_type, u.id, p_attendance_id,
         p_payload || jsonb_build_object('recipient_email', u.email)
  FROM   public.users u
  CROSS JOIN (VALUES ('push'), ('email')) AS channels(channel)
  WHERE  upper(u.role) IN ('ADMIN', 'COORDINATOR', 'COORDINADOR');
END;
$$;


ALTER FUNCTION "public"."fn_queue_coordinator_notification"("p_type" "text", "p_attendance_id" "uuid", "p_payload" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."fn_queue_location_mismatch_notifications"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  v_payload jsonb;
  v_teacher_ids uuid[];
BEGIN
  IF COALESCE(NEW.location_mismatch, false) IS FALSE THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND COALESCE(OLD.location_mismatch, false) IS TRUE THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(array_agg(tg.teacher_id), ARRAY[]::uuid[])
  INTO v_teacher_ids
  FROM (
    SELECT DISTINCT ON (tg.teacher_id)
      tg.teacher_id,
      tg.start_date,
      tg.end_date,
      tg.created_at
    FROM public.teacher_groups tg
    WHERE tg.student_id = NEW.student_id
      AND tg.teacher_id IS NOT NULL
      AND (tg.campus_id = NEW.campus_id OR tg.campus_id IS NULL)
      AND (tg.start_date IS NULL OR tg.start_date <= COALESCE(NEW.date, CURRENT_DATE))
      AND (tg.end_date IS NULL OR tg.end_date >= COALESCE(NEW.date, CURRENT_DATE))
    ORDER BY tg.teacher_id, tg.start_date DESC NULLS LAST, tg.created_at DESC
  ) tg;

  v_payload := jsonb_build_object(
    'attendance_id', NEW.id,
    'student_id', NEW.student_id,
    'campus_id', NEW.campus_id,
    'check_in_location', NEW.check_in_location,
    'check_out_location', NEW.check_out_location,
    'teacher_ids', v_teacher_ids,
    'message', 'Check-out registrado desde una ubicacion distinta al check-in'
  );

  INSERT INTO public.notification_outbox (channel, type, target_user_id, attendance_id, payload)
  SELECT channels.channel,
         'LOCATION_MISMATCH',
         recipients.user_id,
         NEW.id,
         v_payload || jsonb_build_object(
           'recipient_email', recipients.email,
           'recipient_role', recipients.recipient_role
         )
  FROM (
    SELECT u.id AS user_id, u.email, 'teacher' AS recipient_role
    FROM public.users u
    WHERE u.id = ANY(v_teacher_ids)

    UNION

    SELECT u.id AS user_id, u.email, 'coordination' AS recipient_role
    FROM public.users u
    WHERE UPPER(u.role) IN ('COORDINADOR', 'COORDINATOR', 'ADMIN')
      AND NOT (u.id = ANY(v_teacher_ids))
  ) recipients
  CROSS JOIN (VALUES ('push'), ('email')) AS channels(channel);

  INSERT INTO public.audit_log (action, actor_user_id, target_user_id, details)
  VALUES (
    'LOCATION_MISMATCH_NOTIFICATIONS_QUEUED',
    NEW.student_id,
    NEW.student_id,
    v_payload || jsonb_build_object(
      'channels', jsonb_build_array('push', 'email'),
      'routed_to_teacher', COALESCE(array_length(v_teacher_ids, 1), 0) > 0
    )
  );

  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."fn_queue_location_mismatch_notifications"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."fn_queue_security_notification"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  v_attendance_id uuid;
BEGIN
  IF NEW.action NOT IN ('FAKE_GPS_DETECTED', 'SHARED_DEVICE_ACTIVE_CONFLICT') THEN
    RETURN NEW;
  END IF;

  v_attendance_id := COALESCE(
    (NEW.details->>'attendance_id')::uuid,
    (NEW.details->>'active_attendance_id')::uuid
  );

  IF v_attendance_id IS NULL THEN RETURN NEW; END IF;

  PERFORM public.fn_queue_coordinator_notification(
    NEW.action, v_attendance_id, NEW.details
  );

  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."fn_queue_security_notification"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."fn_retry_pending_outbox"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_url    text;
  v_secret text;
  v_anon   text;
  r        record;
BEGIN
  SELECT value INTO v_url    FROM public.system_config WHERE key = 'supabase_project_url';
  SELECT value INTO v_secret FROM public.system_config WHERE key = 'dispatch_webhook_secret';
  SELECT value INTO v_anon   FROM public.system_config WHERE key = 'supabase_anon_key';
  IF v_url IS NULL OR v_secret IS NULL OR v_anon IS NULL THEN
    RETURN;
  END IF;

  -- Reintentar tanto 'pending' (nunca procesados) como 'failed' (procesados pero con error).
  -- El dispatcher marca 'sent' atómicamente antes de enviar, así que reintentar
  -- 'pending'/'failed' es idempotente: si ya está 'sent' no se vuelve a procesar.
  FOR r IN
    SELECT id FROM public.notification_outbox
    WHERE status IN ('pending', 'failed')
      AND created_at < now() - interval '5 minutes'
    ORDER BY created_at
    LIMIT 100
  LOOP
    PERFORM net.http_post(
      url     := v_url || '/functions/v1/notify-dispatcher',
      body    := jsonb_build_object('outbox_id', r.id),
      headers := jsonb_build_object(
        'Authorization',     'Bearer ' || v_anon,
        'x-dispatch-secret', v_secret,
        'Content-Type',      'application/json'
      )
    );
  END LOOP;
END;
$$;


ALTER FUNCTION "public"."fn_retry_pending_outbox"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."fn_set_actualizado_en"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.actualizado_en := now();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."fn_set_actualizado_en"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_campus_active_students"() RETURNS TABLE("attendance_id" "uuid", "student_id" "uuid", "student_name" "text", "student_code" "text", "career" "text", "site_name" "text", "check_in" timestamp with time zone, "hours_today" numeric, "last_location" "jsonb")
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_role   text := upper(coalesce(public.get_current_user_role(), ''));
  v_campus uuid;
BEGIN
  IF v_role <> 'REPRESENTATIVE' THEN
    RAISE EXCEPTION 'Solo el representante hospitalario puede consultar esta vista.';
  END IF;

  SELECT u.campus_id INTO v_campus FROM public.users u WHERE u.id = auth.uid();
  IF v_campus IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    a.id,
    a.student_id,
    coalesce(s.full_name, 'Desconocido'),
    coalesce(s.student_code, ''),
    coalesce(s.career, 'Sin carrera'),
    coalesce(c.location_label, c.name, 'Sede no registrada'),
    a.check_in,
    round(extract(epoch FROM (now() - a.check_in)) / 3600.0, 2)::numeric,
    coalesce(a.check_out_location, a.check_in_location)
  FROM public.attendances a
  JOIN public.users s   ON s.id = a.student_id
  LEFT JOIN public.campuses c ON c.id = a.campus_id
  WHERE a.check_out IS NULL
    AND a.campus_id = v_campus
  ORDER BY a.check_in DESC;
END;
$$;


ALTER FUNCTION "public"."get_campus_active_students"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_campus_subjects"() RETURNS TABLE("subject_id" "uuid", "subject_code" "text", "subject_name" "text", "career" "text", "teacher_name" "text", "student_count" bigint, "schedule_days" "text")
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_role   text := upper(coalesce(public.get_current_user_role(), ''));
  v_campus uuid;
BEGIN
  IF v_role <> 'REPRESENTATIVE' THEN
    RAISE EXCEPTION 'Solo el representante hospitalario puede consultar esta vista.';
  END IF;

  SELECT u.campus_id INTO v_campus FROM public.users u WHERE u.id = auth.uid();
  IF v_campus IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    sub.id,
    coalesce(sub.code, ''),
    coalesce(sub.name, 'Práctica general'),
    sub.career,
    coalesce(t.full_name, 'Sin docente asignado'),
    count(DISTINCT tg.student_id),
    (
      SELECT string_agg(d.label, ', ' ORDER BY d.wd)
      FROM (
        SELECT DISTINCT ss.weekday AS wd,
          CASE ss.weekday
            WHEN 1 THEN 'Lun' WHEN 2 THEN 'Mar' WHEN 3 THEN 'Mié'
            WHEN 4 THEN 'Jue' WHEN 5 THEN 'Vie' WHEN 6 THEN 'Sáb'
            WHEN 7 THEN 'Dom'
          END AS label
        FROM public.student_schedules ss
        JOIN public.teacher_groups tg2 ON tg2.id = ss.assignment_id
        WHERE tg2.campus_id = v_campus
          AND tg2.subject_id IS NOT DISTINCT FROM sub.id
          AND tg2.teacher_id = tg.teacher_id
          AND ss.is_active
      ) d
    )
  FROM public.teacher_groups tg
  LEFT JOIN public.subjects sub ON sub.id = tg.subject_id
  LEFT JOIN public.users t      ON t.id = tg.teacher_id
  WHERE tg.campus_id = v_campus
  GROUP BY sub.id, sub.code, sub.name, sub.career, tg.teacher_id, t.full_name
  ORDER BY coalesce(sub.name, 'Práctica general');
END;
$$;


ALTER FUNCTION "public"."get_campus_subjects"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_current_user_role"() RETURNS "text"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT CASE upper(coalesce(role, ''))
    WHEN 'ADMINISTRADOR' THEN 'ADMIN'
    WHEN 'DECANO'        THEN 'ADMIN'
    ELSE upper(role)
  END
  FROM public.users WHERE id = auth.uid();
$$;


ALTER FUNCTION "public"."get_current_user_role"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_my_conduct_reports"() RETURNS TABLE("id" "uuid", "student_name" "text", "motivo" "text", "campus_name" "text", "created_at" timestamp with time zone)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_role text := upper(coalesce(public.get_current_user_role(), ''));
BEGIN
  IF v_role <> 'REPRESENTATIVE' THEN
    RAISE EXCEPTION 'Solo el representante hospitalario puede consultar sus reportes.';
  END IF;

  RETURN QUERY
  SELECT
    al.id,
    coalesce(s.full_name, 'Estudiante'),
    coalesce(al.details->>'motivo', ''),
    coalesce(al.details->>'campus_name', 'Sede'),
    al.created_at
  FROM public.audit_log al
  LEFT JOIN public.users s ON s.id = al.target_user_id
  WHERE al.action = 'CONDUCT_REPORT'
    AND al.actor_user_id = auth.uid()
  ORDER BY al.created_at DESC;
END;
$$;


ALTER FUNCTION "public"."get_my_conduct_reports"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_security_question"("p_email" "text") RETURNS "text"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT security_question
  FROM public.users
  WHERE lower(email) = lower(trim(p_email))
    AND security_question IS NOT NULL
    AND security_answer_hash IS NOT NULL;
$$;


ALTER FUNCTION "public"."get_security_question"("p_email" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."grant_assignment_override"("p_student_id" "uuid", "p_subject_id" "uuid", "p_reason" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_role  text := upper(coalesce(public.get_current_user_role(), ''));
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
BEGIN
  IF v_role <> 'ADMIN' THEN
    RAISE EXCEPTION 'Solo el decano puede forzar una asignacion.';
  END IF;
  IF p_student_id IS NULL OR p_subject_id IS NULL THEN
    RAISE EXCEPTION 'Alumno y materia son obligatorios.';
  END IF;
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'La justificacion del override es obligatoria.';
  END IF;

  INSERT INTO public.assignment_gate_overrides (student_id, subject_id, granted_by, reason)
  VALUES (p_student_id, p_subject_id, v_actor, v_reason)
  ON CONFLICT (student_id, subject_id)
  DO UPDATE SET granted_by = excluded.granted_by,
               reason      = excluded.reason,
               created_at  = now();

  INSERT INTO public.audit_log (action, actor_user_id, target_user_id, details)
  VALUES (
    'PREREQ_OVERRIDE',
    v_actor,
    p_student_id,
    jsonb_build_object(
      'subject_id', p_subject_id,
      'reason', v_reason,
      'source', 'grant_assignment_override'
    )
  );
END;
$$;


ALTER FUNCTION "public"."grant_assignment_override"("p_student_id" "uuid", "p_subject_id" "uuid", "p_reason" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."haversine_meters"("p_lat1" numeric, "p_lng1" numeric, "p_lat2" numeric, "p_lng2" numeric) RETURNS numeric
    LANGUAGE "sql" IMMUTABLE
    AS $$
  with c as (
    select radians((p_lat2 - p_lat1)::float8) as dlat,
           radians((p_lng2 - p_lng1)::float8) as dlng,
           radians(p_lat1::float8) as lat1,
           radians(p_lat2::float8) as lat2
  )
  select 2 * 6371000 * asin(
    sqrt(
      power(sin(dlat / 2), 2) +
      cos(lat1) * cos(lat2) * power(sin(dlng / 2), 2)
    )
  )
  from c
$$;


ALTER FUNCTION "public"."haversine_meters"("p_lat1" numeric, "p_lng1" numeric, "p_lat2" numeric, "p_lng2" numeric) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."list_my_active_sessions"() RETURNS TABLE("session_id" "text", "device_label" "text", "user_agent" "text", "created_at" timestamp with time zone, "last_seen_at" timestamp with time zone, "is_current" boolean)
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT
    s.session_id,
    s.device_label,
    s.user_agent,
    s.created_at,
    s.last_seen_at,
    s.session_id = u.active_session_id AS is_current
  FROM public.user_sessions s
  JOIN public.users u ON u.id = s.user_id
  WHERE s.user_id = auth.uid()
    AND s.revoked_at IS NULL
  ORDER BY s.last_seen_at DESC;
$$;


ALTER FUNCTION "public"."list_my_active_sessions"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."rate_limit_hit"("p_bucket" "text", "p_key" "text", "p_max" integer, "p_window_seconds" integer) RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_now   timestamptz := now();
  v_count integer;
BEGIN
  INSERT INTO public.rate_limits AS rl (bucket, key, window_start, count)
  VALUES (p_bucket, p_key, v_now, 1)
  ON CONFLICT (bucket, key) DO UPDATE SET
    count = CASE
      WHEN rl.window_start < v_now - make_interval(secs => p_window_seconds) THEN 1
      ELSE rl.count + 1
    END,
    window_start = CASE
      WHEN rl.window_start < v_now - make_interval(secs => p_window_seconds) THEN v_now
      ELSE rl.window_start
    END
  RETURNING count INTO v_count;

  RETURN v_count <= p_max;
END;
$$;


ALTER FUNCTION "public"."rate_limit_hit"("p_bucket" "text", "p_key" "text", "p_max" integer, "p_window_seconds" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."report_student_conduct"("p_attendance_id" "uuid", "p_motivo" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_role     text := upper(coalesce(public.get_current_user_role(), ''));
  v_actor    uuid := auth.uid();
  v_campus   uuid;
  v_motivo   text := nullif(trim(coalesce(p_motivo, '')), '');
  v_att      record;
  v_group    record;
  v_payload  jsonb;
  v_rep_name text;
BEGIN
  IF v_role <> 'REPRESENTATIVE' THEN
    RAISE EXCEPTION 'Solo el representante hospitalario puede reportar conducta.';
  END IF;
  IF v_motivo IS NULL THEN
    RAISE EXCEPTION 'El motivo del reporte es obligatorio.';
  END IF;

  SELECT u.campus_id, u.full_name INTO v_campus, v_rep_name
  FROM public.users u WHERE u.id = v_actor;

  SELECT a.id, a.student_id, a.campus_id, a.date, s.full_name AS student_name,
         s.student_code, c.name AS campus_name
  INTO v_att
  FROM public.attendances a
  JOIN public.users s ON s.id = a.student_id
  LEFT JOIN public.campuses c ON c.id = a.campus_id
  WHERE a.id = p_attendance_id;

  IF v_att.id IS NULL THEN
    RAISE EXCEPTION 'Asistencia no encontrada.';
  END IF;
  IF v_campus IS NULL OR v_att.campus_id <> v_campus THEN
    RAISE EXCEPTION 'Solo puedes reportar estudiantes de tu sede.';
  END IF;

  -- Docente y coordinador del alumno (asignación que coincide con la sede).
  SELECT tg.teacher_id, tg.coordinator_id
  INTO v_group
  FROM public.teacher_groups tg
  WHERE tg.student_id = v_att.student_id
    AND tg.campus_id = v_att.campus_id
  ORDER BY tg.period DESC
  LIMIT 1;

  INSERT INTO public.audit_log (action, actor_user_id, target_user_id, details)
  VALUES (
    'CONDUCT_REPORT',
    v_actor,
    v_att.student_id,
    jsonb_build_object(
      'attendance_id', p_attendance_id,
      'campus_id', v_att.campus_id,
      'campus_name', coalesce(v_att.campus_name, 'Sede'),
      'motivo', v_motivo,
      'representative_name', coalesce(v_rep_name, 'Representante'),
      'source', 'report_student_conduct'
    )
  );

  v_payload := jsonb_build_object(
    'student_id', v_att.student_id,
    'student_name', coalesce(v_att.student_name, 'Estudiante'),
    'student_code', coalesce(v_att.student_code, ''),
    'campus_name', coalesce(v_att.campus_name, 'Sede'),
    'representative_name', coalesce(v_rep_name, 'Representante'),
    'motivo', v_motivo,
    'attendance_date', coalesce(v_att.date::text, '')
  );

  -- Encola push + email para coordinador y docente (los que existan).
  INSERT INTO public.notification_outbox (channel, type, target_user_id, attendance_id, payload)
  SELECT channels.channel, 'CONDUCT_REPORT', recipients.uid, p_attendance_id,
         v_payload || jsonb_build_object('recipient_email', (SELECT email FROM public.users WHERE id = recipients.uid))
  FROM (VALUES ('push'), ('email')) AS channels(channel)
  CROSS JOIN (
    SELECT v_group.teacher_id AS uid WHERE v_group.teacher_id IS NOT NULL
    UNION
    SELECT v_group.coordinator_id WHERE v_group.coordinator_id IS NOT NULL
  ) AS recipients
  WHERE recipients.uid IS NOT NULL;
END;
$$;


ALTER FUNCTION "public"."report_student_conduct"("p_attendance_id" "uuid", "p_motivo" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."revoke_my_other_sessions"("p_current_session_id" "text") RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_count integer;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Sesion requerida.';
  END IF;

  UPDATE public.user_sessions
  SET revoked_at = now(),
      revoked_by = auth.uid()
  WHERE user_id = auth.uid()
    AND session_id <> p_current_session_id
    AND revoked_at IS NULL;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;


ALTER FUNCTION "public"."revoke_my_other_sessions"("p_current_session_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."revoke_my_session"("p_session_id" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Sesion requerida.';
  END IF;

  UPDATE public.user_sessions
  SET revoked_at = now(),
      revoked_by = auth.uid()
  WHERE user_id = auth.uid()
    AND session_id = p_session_id
    AND revoked_at IS NULL;
END;
$$;


ALTER FUNCTION "public"."revoke_my_session"("p_session_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_active_session"("p_session_id" "text") RETURNS "void"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  UPDATE public.users SET active_session_id = p_session_id WHERE id = auth.uid();
$$;


ALTER FUNCTION "public"."set_active_session"("p_session_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_active_session"("p_session_id" "text", "p_device_label" "text" DEFAULT NULL::"text", "p_user_agent" "text" DEFAULT NULL::"text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Sesion requerida.';
  END IF;

  INSERT INTO public.user_sessions(user_id, session_id, device_label, user_agent)
  VALUES (auth.uid(), p_session_id, nullif(trim(coalesce(p_device_label, '')), ''), nullif(trim(coalesce(p_user_agent, '')), ''))
  ON CONFLICT (session_id) DO UPDATE
  SET last_seen_at = now(),
      device_label = COALESCE(EXCLUDED.device_label, public.user_sessions.device_label),
      user_agent = COALESCE(EXCLUDED.user_agent, public.user_sessions.user_agent),
      revoked_at = NULL,
      revoked_by = NULL;

  -- Sesión única: cualquier otra sesión del mismo usuario queda revocada.
  UPDATE public.user_sessions
  SET revoked_at = now(),
      revoked_by = auth.uid()
  WHERE user_id = auth.uid()
    AND session_id <> p_session_id
    AND revoked_at IS NULL;

  UPDATE public.users
  SET active_session_id = p_session_id
  WHERE id = auth.uid();
END;
$$;


ALTER FUNCTION "public"."set_active_session"("p_session_id" "text", "p_device_label" "text", "p_user_agent" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_security_question"("p_question" "text", "p_answer" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'extensions'
    AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;
  IF length(trim(p_answer)) < 2 THEN
    RAISE EXCEPTION 'Respuesta demasiado corta';
  END IF;

  UPDATE public.users
  SET security_question    = p_question,
      security_answer_hash = extensions.crypt(lower(trim(p_answer)), extensions.gen_salt('bf'))
  WHERE id = auth.uid();
END;
$$;


ALTER FUNCTION "public"."set_security_question"("p_question" "text", "p_answer" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."touch_active_session"("p_session_id" "text") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_revoked timestamptz;
  v_active_session_id text;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN false;
  END IF;

  SELECT revoked_at INTO v_revoked
  FROM public.user_sessions
  WHERE user_id = auth.uid()
    AND session_id = p_session_id;

  IF v_revoked IS NOT NULL THEN
    RETURN false;
  END IF;

  -- Defensa en profundidad: además de revoked_at, confirma que esta sigue
  -- siendo la sesión activa según users.active_session_id.
  SELECT active_session_id INTO v_active_session_id
  FROM public.users
  WHERE id = auth.uid();

  IF v_active_session_id IS DISTINCT FROM p_session_id THEN
    RETURN false;
  END IF;

  UPDATE public.user_sessions
  SET last_seen_at = now()
  WHERE user_id = auth.uid()
    AND session_id = p_session_id
    AND revoked_at IS NULL;

  RETURN FOUND;
END;
$$;


ALTER FUNCTION "public"."touch_active_session"("p_session_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."validate_assignment_gate"("p_student_id" "uuid", "p_subject_id" "uuid") RETURNS TABLE("ok" boolean, "message" "text")
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_student_level smallint;
  v_subject public.subjects;
  v_missing text;
BEGIN
  IF p_student_id IS NULL THEN
    RETURN QUERY SELECT false, 'Selecciona un alumno.';
    RETURN;
  END IF;

  IF p_subject_id IS NULL THEN
    RETURN QUERY SELECT false, 'Selecciona una materia.';
    RETURN;
  END IF;

  SELECT COALESCE(academic_level, 0)
    INTO v_student_level
  FROM public.users
  WHERE id = p_student_id;

  IF v_student_level IS NULL THEN
    RETURN QUERY SELECT false, 'El alumno no existe.';
    RETURN;
  END IF;

  SELECT *
    INTO v_subject
  FROM public.subjects
  WHERE id = p_subject_id
    AND is_active = true;

  IF v_subject.id IS NULL THEN
    RETURN QUERY SELECT false, 'La materia seleccionada no existe o esta inactiva.';
    RETURN;
  END IF;

  IF v_subject.min_academic_level IS NOT NULL
     AND v_student_level < v_subject.min_academic_level THEN
    RETURN QUERY SELECT false, format(
      'Nivel academico insuficiente para %s. Requerido: %s; alumno: %s.',
      v_subject.name,
      v_subject.min_academic_level,
      v_student_level
    );
    RETURN;
  END IF;

  SELECT string_agg(req.name, ', ' ORDER BY req.name)
    INTO v_missing
  FROM public.subject_prerequisites sp
  JOIN public.subjects req ON req.id = sp.requires_subject_id
  WHERE sp.subject_id = p_subject_id
    AND NOT EXISTS (
      SELECT 1
      FROM public.teacher_groups tg
      WHERE tg.student_id = p_student_id
        AND tg.subject_id = sp.requires_subject_id
        AND upper(COALESCE(tg.closure_status, '')) = 'COMPLETED'
    );

  IF v_missing IS NOT NULL THEN
    RETURN QUERY SELECT false, 'Prerrequisitos pendientes: ' || v_missing || '.';
    RETURN;
  END IF;

  RETURN QUERY SELECT true, 'Asignacion permitida.';
END;
$$;


ALTER FUNCTION "public"."validate_assignment_gate"("p_student_id" "uuid", "p_subject_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."validate_checkin_area"("p_campus_id" "uuid", "p_current_lat" numeric, "p_current_lng" numeric) RETURNS TABLE("is_allowed" boolean, "message" "text", "distance_meters" numeric, "radius_meters" integer)
    LANGUAGE "plpgsql"
    AS $$
declare
  v_campus public.campuses;
  v_distance numeric;
  v_inside_radius boolean;
begin
  select * into v_campus from public.campuses where id = p_campus_id;
  if v_campus.id is null then
    raise exception 'Campus not found: %', p_campus_id;
  end if;

  v_distance := public.haversine_meters(p_current_lat, p_current_lng, v_campus.latitude, v_campus.longitude);
  v_inside_radius := v_distance <= v_campus.radius_meters;

  return query
  select
    v_inside_radius,
    case
      when v_inside_radius then 'Ubicacion validada.'
      else format('Fuera del area por %.0f metros.', (v_distance - v_campus.radius_meters)::numeric)
    end,
    round(v_distance, 2),
    v_campus.radius_meters;
end;
$$;


ALTER FUNCTION "public"."validate_checkin_area"("p_campus_id" "uuid", "p_current_lat" numeric, "p_current_lng" numeric) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."validate_checkout_parity"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_lat numeric;
  v_lng numeric;
  v_campus public.campuses;
  v_distance numeric;
  v_assignment public.teacher_groups;
  v_slot record;
  v_weekday integer;
  v_checkout_time time := (COALESCE(NEW.check_out, now()) AT TIME ZONE 'America/El_Salvador')::time;
BEGIN
  IF NEW.check_out IS NULL OR OLD.check_out IS NOT NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.campus_id IS DISTINCT FROM OLD.campus_id THEN
    RAISE EXCEPTION 'La sede del check-out no puede cambiar.';
  END IF;

  IF NEW.check_out_location IS NULL THEN
    RAISE EXCEPTION 'Se requiere ubicacion GPS para registrar la salida.';
  END IF;

  v_lat := nullif(NEW.check_out_location->>'latitude', '')::numeric;
  v_lng := nullif(NEW.check_out_location->>'longitude', '')::numeric;

  SELECT * INTO v_campus
  FROM public.campuses
  WHERE id = NEW.campus_id;

  IF v_campus.id IS NULL THEN
    RAISE EXCEPTION 'Sede no encontrada para registrar la salida.';
  END IF;

  v_distance := public.haversine_meters(v_lat, v_lng, v_campus.latitude, v_campus.longitude);
  IF v_distance > v_campus.radius_meters THEN
    RAISE EXCEPTION 'Fuera del area por % metros.', round(v_distance - v_campus.radius_meters);
  END IF;

  IF NEW.assignment_id IS NOT NULL THEN
    SELECT * INTO v_assignment
    FROM public.teacher_groups
    WHERE id = NEW.assignment_id
      AND student_id = NEW.student_id
      AND campus_id = NEW.campus_id;
  ELSE
    SELECT * INTO v_assignment
    FROM public.teacher_groups
    WHERE student_id = NEW.student_id
      AND campus_id = NEW.campus_id
      AND (start_date IS NULL OR NEW.date >= start_date)
      AND (end_date IS NULL OR NEW.date <= end_date)
    ORDER BY start_date DESC NULLS LAST
    LIMIT 1;
  END IF;

  IF v_assignment.id IS NULL THEN
    RAISE EXCEPTION 'No hay asignacion vigente para registrar la salida en esta sede.';
  END IF;

  v_weekday := EXTRACT(ISODOW FROM COALESCE(NEW.date, (NEW.check_out AT TIME ZONE 'America/El_Salvador')::date));
  SELECT * INTO v_slot
  FROM public.student_schedules
  WHERE assignment_id = v_assignment.id
    AND weekday = v_weekday
    AND is_active = true
  ORDER BY check_in_from NULLS LAST
  LIMIT 1;

  IF v_slot.assignment_id IS NULL THEN
    RAISE EXCEPTION 'No tienes practica programada hoy en esta sede.';
  END IF;

  IF v_slot.check_in_from IS NOT NULL AND v_slot.check_in_to IS NOT NULL THEN
    IF v_slot.check_in_from <= v_slot.check_in_to THEN
      IF v_checkout_time < v_slot.check_in_from OR v_checkout_time > v_slot.check_in_to THEN
        RAISE EXCEPTION 'Fuera de tu horario de salida (%-%).', v_slot.check_in_from, v_slot.check_in_to;
      END IF;
    ELSIF v_checkout_time < v_slot.check_in_from AND v_checkout_time > v_slot.check_in_to THEN
      RAISE EXCEPTION 'Fuera de tu horario de salida (%-%).', v_slot.check_in_from, v_slot.check_in_to;
    END IF;
  END IF;

  NEW.assignment_id := COALESCE(NEW.assignment_id, v_assignment.id);
  NEW.subject_id := COALESCE(NEW.subject_id, v_assignment.subject_id);

  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."validate_checkout_parity"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."validate_location_coherence"("p_student_id" "uuid", "p_current_lat" numeric, "p_current_lng" numeric, "p_timestamp" timestamp with time zone DEFAULT "now"()) RETURNS TABLE("is_suspicious" boolean, "confidence_score" numeric)
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  v_prev_lat  numeric;
  v_prev_lng  numeric;
  v_prev_ts   timestamptz;
  v_dist_m    numeric;
  v_elapsed_h numeric;
  v_speed_kmh numeric;
  v_conf      numeric := 0;
BEGIN
  SELECT
    (check_in_location->>'latitude')::numeric,
    (check_in_location->>'longitude')::numeric,
    COALESCE(check_out, check_in)
  INTO v_prev_lat, v_prev_lng, v_prev_ts
  FROM public.attendances
  WHERE student_id = p_student_id
    AND check_in_location IS NOT NULL
  ORDER BY COALESCE(check_out, check_in) DESC
  LIMIT 1;

  IF v_prev_lat IS NULL THEN
    RETURN QUERY SELECT false, 0.00::numeric;
    RETURN;
  END IF;

  v_dist_m    := public.haversine_meters(p_current_lat, p_current_lng, v_prev_lat, v_prev_lng);
  v_elapsed_h := GREATEST(EXTRACT(EPOCH FROM (p_timestamp - v_prev_ts)) / 3600.0, 0.001);
  v_speed_kmh := (v_dist_m / 1000.0) / v_elapsed_h;

  IF    v_speed_kmh > 140 THEN v_conf := 0.95;
  ELSIF v_speed_kmh >  80 THEN v_conf := 0.60;
  ELSIF v_speed_kmh >  40 THEN v_conf := 0.30;
  END IF;

  RETURN QUERY SELECT v_conf > 0.70, round(v_conf, 2);
END;
$$;


ALTER FUNCTION "public"."validate_location_coherence"("p_student_id" "uuid", "p_current_lat" numeric, "p_current_lng" numeric, "p_timestamp" timestamp with time zone) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."verify_security_answer"("p_email" "text", "p_answer" "text") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'extensions'
    AS $$
DECLARE
  v_hash text;
BEGIN
  SELECT security_answer_hash INTO v_hash
  FROM public.users
  WHERE lower(email) = lower(trim(p_email));

  IF v_hash IS NULL THEN
    RETURN false;
  END IF;

  RETURN v_hash = extensions.crypt(lower(trim(p_answer)), v_hash);
END;
$$;


ALTER FUNCTION "public"."verify_security_answer"("p_email" "text", "p_answer" "text") OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."access_requests" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "full_name" "text" NOT NULL,
    "student_code" "text" NOT NULL,
    "email" "text",
    "career" "text",
    "requested_role" "text" DEFAULT 'STUDENT'::"text" NOT NULL,
    "reason" "text",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "decided_by" "uuid",
    "decided_at" timestamp with time zone,
    "decision_note" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."access_requests" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."asignaciones_alumnos" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "alumno_id" "uuid" NOT NULL,
    "sede_id" "uuid" NOT NULL,
    "encargado_id" "uuid",
    "periodo_id" "uuid" NOT NULL,
    "carrera" "text",
    "horario" "text",
    "fecha_inicio" "date" NOT NULL,
    "fecha_fin" "date" NOT NULL,
    "estado" "text" DEFAULT 'activa'::"text" NOT NULL,
    "creado_en" timestamp with time zone DEFAULT "now"() NOT NULL,
    "actualizado_en" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "asignaciones_estado_ck" CHECK (("estado" = ANY (ARRAY['activa'::"text", 'finalizada'::"text", 'cancelada'::"text"]))),
    CONSTRAINT "asignaciones_fechas_ck" CHECK (("fecha_fin" >= "fecha_inicio"))
);


ALTER TABLE "public"."asignaciones_alumnos" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."assignment_gate_overrides" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "student_id" "uuid" NOT NULL,
    "subject_id" "uuid" NOT NULL,
    "granted_by" "uuid",
    "reason" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."assignment_gate_overrides" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."attendances" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "student_id" "uuid" NOT NULL,
    "campus_id" "uuid" NOT NULL,
    "check_in" timestamp with time zone DEFAULT "now"() NOT NULL,
    "check_out" timestamp with time zone,
    "date" "date" DEFAULT (("now"() AT TIME ZONE 'America/El_Salvador'::"text"))::"date" NOT NULL,
    "status" "text" DEFAULT 'present'::"text" NOT NULL,
    "notes" "text",
    "check_in_location" "jsonb",
    "check_out_location" "jsonb",
    "security_seal" "text",
    "check_out_security_seal" "text",
    "worked_hours" numeric(5,2),
    "review_status" "text" DEFAULT 'PENDIENTE'::"text" NOT NULL,
    "suspicious_reason" "text",
    "device_id" "text",
    "device_info" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "location_mismatch" boolean DEFAULT false NOT NULL,
    "check_in_ip" "text",
    "check_out_ip" "text",
    "check_in_ip_info" "jsonb",
    "check_out_ip_info" "jsonb",
    "assignment_id" "uuid",
    "subject_id" "uuid",
    "check_out_device_fingerprint" "text",
    "device_fingerprint" "text"
);


ALTER TABLE "public"."attendances" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."audit_log" (
    "id" bigint NOT NULL,
    "action" "text" NOT NULL,
    "actor_user_id" "uuid" NOT NULL,
    "target_user_id" "uuid",
    "event_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "details" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL
);


ALTER TABLE "public"."audit_log" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."audit_log_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."audit_log_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."audit_log_id_seq" OWNED BY "public"."audit_log"."id";



CREATE TABLE IF NOT EXISTS "public"."campus_daily_qr" (
    "campus_id" "uuid" NOT NULL,
    "qr_date" "date" NOT NULL,
    "token" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "short_code" character varying(8)
);


ALTER TABLE "public"."campus_daily_qr" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."campus_qr" (
    "campus_id" "uuid" NOT NULL,
    "token" "text" NOT NULL,
    "short_code" "text" NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."campus_qr" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."campuses" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "latitude" numeric(9,6) NOT NULL,
    "longitude" numeric(9,6) NOT NULL,
    "radius_meters" integer DEFAULT 100 NOT NULL,
    "location_label" "text",
    "supervisor_name" "text",
    "supervisor_phone" "text",
    "schedule" "text",
    "start_date" "date",
    "end_date" "date",
    "description" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "check_in_from" time without time zone,
    "check_in_to" time without time zone,
    "is_active" boolean DEFAULT true NOT NULL,
    "max_students" integer,
    CONSTRAINT "campuses_lat_check" CHECK ((("latitude" >= ('-90'::integer)::numeric) AND ("latitude" <= (90)::numeric))),
    CONSTRAINT "campuses_lng_check" CHECK ((("longitude" >= ('-180'::integer)::numeric) AND ("longitude" <= (180)::numeric))),
    CONSTRAINT "campuses_max_students_check" CHECK ((("max_students" IS NULL) OR ("max_students" > 0))),
    CONSTRAINT "campuses_radius_check" CHECK ((("radius_meters" >= 20) AND ("radius_meters" <= 1000)))
);


ALTER TABLE "public"."campuses" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."careers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "total_cycles" smallint DEFAULT 10 NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "careers_total_cycles_check" CHECK ((("total_cycles" >= 1) AND ("total_cycles" <= 20)))
);


ALTER TABLE "public"."careers" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."estado_sede_periodo" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "sede_id" "uuid" NOT NULL,
    "periodo_id" "uuid" NOT NULL,
    "activo" boolean DEFAULT true NOT NULL,
    "motivo" "text",
    "creado_en" timestamp with time zone DEFAULT "now"() NOT NULL,
    "actualizado_en" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."estado_sede_periodo" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."estado_usuario_periodo" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "usuario_id" "uuid" NOT NULL,
    "periodo_id" "uuid" NOT NULL,
    "activo" boolean DEFAULT true NOT NULL,
    "motivo" "text",
    "creado_en" timestamp with time zone DEFAULT "now"() NOT NULL,
    "actualizado_en" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."estado_usuario_periodo" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."holidays" (
    "holiday_date" "date" NOT NULL,
    "name" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "recurring" boolean DEFAULT false NOT NULL
);


ALTER TABLE "public"."holidays" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."justifications" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "attendance_id" "uuid",
    "student_id" "uuid" NOT NULL,
    "motivo" "text" NOT NULL,
    "documento_url" "text",
    "status" "text" DEFAULT 'PENDIENTE'::"text" NOT NULL,
    "revisado_por" "uuid",
    "notas_revisor" "text",
    "creado_en" timestamp with time zone DEFAULT "now"() NOT NULL,
    "actualizado_en" timestamp with time zone DEFAULT "now"() NOT NULL,
    "escalated" boolean DEFAULT false NOT NULL,
    "escalated_at" timestamp with time zone,
    "escalated_by" "uuid",
    "absence_date" "date",
    "absence_campus_id" "uuid",
    CONSTRAINT "justifications_status_ck" CHECK (("status" = ANY (ARRAY['PENDIENTE'::"text", 'APROBADO'::"text", 'RECHAZADO'::"text"]))),
    CONSTRAINT "justifications_target_ck" CHECK ((("attendance_id" IS NOT NULL) OR ("absence_date" IS NOT NULL)))
);


ALTER TABLE "public"."justifications" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."metas_horas_alumno" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "alumno_id" "uuid" NOT NULL,
    "periodo_id" "uuid" NOT NULL,
    "meta_horas" numeric(6,2) NOT NULL,
    "origen" "text" DEFAULT 'manual'::"text" NOT NULL,
    "notas" "text",
    "creado_en" timestamp with time zone DEFAULT "now"() NOT NULL,
    "actualizado_en" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "metas_horas_positiva_ck" CHECK (("meta_horas" > (0)::numeric)),
    CONSTRAINT "metas_origen_ck" CHECK (("origen" = ANY (ARRAY['manual'::"text", 'por_carrera'::"text"])))
);


ALTER TABLE "public"."metas_horas_alumno" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."notification_outbox" (
    "id" bigint NOT NULL,
    "channel" "text" NOT NULL,
    "type" "text" NOT NULL,
    "target_user_id" "uuid" NOT NULL,
    "attendance_id" "uuid",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "payload" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "sent_at" timestamp with time zone,
    CONSTRAINT "notification_outbox_channel_check" CHECK (("channel" = ANY (ARRAY['push'::"text", 'email'::"text"]))),
    CONSTRAINT "notification_outbox_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'sent'::"text", 'failed'::"text"])))
);


ALTER TABLE "public"."notification_outbox" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."notification_outbox_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."notification_outbox_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."notification_outbox_id_seq" OWNED BY "public"."notification_outbox"."id";



CREATE TABLE IF NOT EXISTS "public"."periodos_academicos" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "codigo" "text" NOT NULL,
    "nombre" "text" NOT NULL,
    "fecha_inicio" "date" NOT NULL,
    "fecha_fin" "date" NOT NULL,
    "activo" boolean DEFAULT false NOT NULL,
    "creado_en" timestamp with time zone DEFAULT "now"() NOT NULL,
    "actualizado_en" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "periodos_fechas_ck" CHECK (("fecha_fin" >= "fecha_inicio"))
);


ALTER TABLE "public"."periodos_academicos" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."push_tokens" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "token" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."push_tokens" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."rate_limits" (
    "bucket" "text" NOT NULL,
    "key" "text" NOT NULL,
    "window_start" timestamp with time zone DEFAULT "now"() NOT NULL,
    "count" integer DEFAULT 0 NOT NULL
);


ALTER TABLE "public"."rate_limits" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."recovery_otps" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "email" "text" NOT NULL,
    "backup_email" "text" NOT NULL,
    "otp_hash" "text" NOT NULL,
    "otp_salt" "text" NOT NULL,
    "attempts" smallint DEFAULT 0 NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    "consumed_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "recovery_otps_attempts_ck" CHECK ((("attempts" >= 0) AND ("attempts" <= 3)))
);


ALTER TABLE "public"."recovery_otps" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."student_schedules" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "assignment_id" "uuid" NOT NULL,
    "weekday" smallint NOT NULL,
    "check_in_from" time without time zone NOT NULL,
    "check_in_to" time without time zone NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "student_schedules_time_check" CHECK (("check_in_to" > "check_in_from")),
    CONSTRAINT "student_schedules_weekday_check" CHECK ((("weekday" >= 1) AND ("weekday" <= 7)))
);


ALTER TABLE "public"."student_schedules" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."subject_prerequisites" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "subject_id" "uuid" NOT NULL,
    "requires_subject_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "subject_prereq_no_self" CHECK (("subject_id" <> "requires_subject_id"))
);


ALTER TABLE "public"."subject_prerequisites" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."subjects" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "code" "text" NOT NULL,
    "name" "text" NOT NULL,
    "career" "text",
    "required_hours" integer DEFAULT 240 NOT NULL,
    "min_academic_level" smallint,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "subjects_min_level_check" CHECK ((("min_academic_level" IS NULL) OR ("min_academic_level" >= 0))),
    CONSTRAINT "subjects_required_hours_check" CHECK (("required_hours" > 0))
);


ALTER TABLE "public"."subjects" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."system_config" (
    "key" "text" NOT NULL,
    "value" "text" NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."system_config" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."teacher_groups" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "teacher_id" "uuid" NOT NULL,
    "student_id" "uuid" NOT NULL,
    "campus_id" "uuid",
    "period" "text" DEFAULT '2026-1'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "coordinator_id" "uuid",
    "start_date" "date",
    "end_date" "date",
    "subject_id" "uuid",
    "closed_at" timestamp with time zone,
    "audited_hours" numeric(6,2),
    "closure_status" "text",
    "required_hours" numeric(6,2),
    "goal_decision" "text",
    "goal_decided_by" "uuid",
    "goal_decided_at" timestamp with time zone,
    "goal_decision_note" "text",
    CONSTRAINT "teacher_groups_dates_check" CHECK ((("end_date" IS NULL) OR ("start_date" IS NULL) OR ("end_date" >= "start_date"))),
    CONSTRAINT "teacher_groups_required_hours_check" CHECK ((("required_hours" IS NULL) OR ("required_hours" > (0)::numeric)))
);


ALTER TABLE "public"."teacher_groups" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."user_sessions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "session_id" "text" NOT NULL,
    "device_label" "text",
    "user_agent" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_seen_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "revoked_at" timestamp with time zone,
    "revoked_by" "uuid"
);


ALTER TABLE "public"."user_sessions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."users" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "student_code" character varying(9) NOT NULL,
    "full_name" "text",
    "email" "text" NOT NULL,
    "role" "text" DEFAULT 'STUDENT'::"text" NOT NULL,
    "career" "text",
    "photo_url" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "backup_email" "text",
    "phone" "text",
    "security_question" "text",
    "security_answer_hash" "text",
    "notif_push" boolean DEFAULT true NOT NULL,
    "notif_email" boolean DEFAULT true NOT NULL,
    "active_session_id" "text",
    "must_change_password" boolean DEFAULT false NOT NULL,
    "accepted_legal_at" timestamp with time zone,
    "accepted_legal_version" "text",
    "academic_level" smallint,
    "campus_id" "uuid"
);


ALTER TABLE "public"."users" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_cumplimiento_carrera_sede" WITH ("security_invoker"='true') AS
 SELECT "u"."career" AS "carrera",
    "c"."id" AS "campus_id",
    "c"."name" AS "campus_nombre",
    "count"(DISTINCT "u"."id") AS "total_alumnos",
    "round"((((COALESCE("sum"("a"."worked_hours"), (0)::numeric) / (NULLIF("count"(DISTINCT "u"."id"), 0))::numeric) / 240.0) * (100)::numeric), 1) AS "cumplimiento_pct"
   FROM (("public"."users" "u"
     LEFT JOIN "public"."attendances" "a" ON ((("a"."student_id" = "u"."id") AND ("a"."check_out" IS NOT NULL))))
     LEFT JOIN "public"."campuses" "c" ON (("c"."id" = "a"."campus_id")))
  WHERE ("u"."role" = 'STUDENT'::"text")
  GROUP BY "u"."career", "c"."id", "c"."name";


ALTER VIEW "public"."v_cumplimiento_carrera_sede" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_student_assignment" WITH ("security_invoker"='true') AS
 SELECT "tg"."id" AS "assignment_id",
    "tg"."student_id",
    "tg"."teacher_id",
    "tg"."coordinator_id",
    "tg"."campus_id",
    "tg"."period",
    "tg"."start_date",
    "tg"."end_date",
    "c"."name" AS "campus_name",
    "c"."location_label",
    "c"."supervisor_name",
    "c"."supervisor_phone",
    "c"."check_in_from" AS "campus_check_in_from",
    "c"."check_in_to" AS "campus_check_in_to",
    "c"."latitude",
    "c"."longitude",
    "c"."is_active" AS "campus_is_active",
    "teacher"."full_name" AS "teacher_name",
    "coord"."full_name" AS "coordinator_name"
   FROM ((("public"."teacher_groups" "tg"
     LEFT JOIN "public"."campuses" "c" ON (("c"."id" = "tg"."campus_id")))
     LEFT JOIN "public"."users" "teacher" ON (("teacher"."id" = "tg"."teacher_id")))
     LEFT JOIN "public"."users" "coord" ON (("coord"."id" = "tg"."coordinator_id")));


ALTER VIEW "public"."v_student_assignment" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."weekly_evaluations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "teacher_id" "uuid" NOT NULL,
    "student_id" "uuid" NOT NULL,
    "week_start" "date" NOT NULL,
    "actitud" integer NOT NULL,
    "puntualidad" integer NOT NULL,
    "desempeno_tecnico" integer NOT NULL,
    "trabajo_equipo" integer NOT NULL,
    "comentario" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "actualizado_en" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "weekly_evaluations_actitud_check" CHECK ((("actitud" >= 1) AND ("actitud" <= 5))),
    CONSTRAINT "weekly_evaluations_desempeno_tecnico_check" CHECK ((("desempeno_tecnico" >= 1) AND ("desempeno_tecnico" <= 5))),
    CONSTRAINT "weekly_evaluations_puntualidad_check" CHECK ((("puntualidad" >= 1) AND ("puntualidad" <= 5))),
    CONSTRAINT "weekly_evaluations_trabajo_equipo_check" CHECK ((("trabajo_equipo" >= 1) AND ("trabajo_equipo" <= 5)))
);


ALTER TABLE "public"."weekly_evaluations" OWNER TO "postgres";


ALTER TABLE ONLY "public"."audit_log" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."audit_log_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."notification_outbox" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."notification_outbox_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."access_requests"
    ADD CONSTRAINT "access_requests_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."asignaciones_alumnos"
    ADD CONSTRAINT "asignaciones_alumnos_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."assignment_gate_overrides"
    ADD CONSTRAINT "assignment_gate_override_unique" UNIQUE ("student_id", "subject_id");



ALTER TABLE ONLY "public"."assignment_gate_overrides"
    ADD CONSTRAINT "assignment_gate_overrides_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."attendances"
    ADD CONSTRAINT "attendances_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."audit_log"
    ADD CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."campus_daily_qr"
    ADD CONSTRAINT "campus_daily_qr_pkey" PRIMARY KEY ("campus_id", "qr_date");



ALTER TABLE ONLY "public"."campus_qr"
    ADD CONSTRAINT "campus_qr_pkey" PRIMARY KEY ("campus_id");



ALTER TABLE ONLY "public"."campuses"
    ADD CONSTRAINT "campuses_name_key" UNIQUE ("name");



ALTER TABLE ONLY "public"."campuses"
    ADD CONSTRAINT "campuses_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."careers"
    ADD CONSTRAINT "careers_name_key" UNIQUE ("name");



ALTER TABLE ONLY "public"."careers"
    ADD CONSTRAINT "careers_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."estado_sede_periodo"
    ADD CONSTRAINT "estado_sede_periodo_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."estado_sede_periodo"
    ADD CONSTRAINT "estado_sede_periodo_sede_id_periodo_id_key" UNIQUE ("sede_id", "periodo_id");



ALTER TABLE ONLY "public"."estado_usuario_periodo"
    ADD CONSTRAINT "estado_usuario_periodo_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."estado_usuario_periodo"
    ADD CONSTRAINT "estado_usuario_periodo_usuario_id_periodo_id_key" UNIQUE ("usuario_id", "periodo_id");



ALTER TABLE ONLY "public"."holidays"
    ADD CONSTRAINT "holidays_pkey" PRIMARY KEY ("holiday_date");



ALTER TABLE ONLY "public"."justifications"
    ADD CONSTRAINT "justifications_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."metas_horas_alumno"
    ADD CONSTRAINT "metas_horas_alumno_alumno_id_periodo_id_key" UNIQUE ("alumno_id", "periodo_id");



ALTER TABLE ONLY "public"."metas_horas_alumno"
    ADD CONSTRAINT "metas_horas_alumno_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."notification_outbox"
    ADD CONSTRAINT "notification_outbox_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."periodos_academicos"
    ADD CONSTRAINT "periodos_academicos_codigo_key" UNIQUE ("codigo");



ALTER TABLE ONLY "public"."periodos_academicos"
    ADD CONSTRAINT "periodos_academicos_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."push_tokens"
    ADD CONSTRAINT "push_tokens_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."push_tokens"
    ADD CONSTRAINT "push_tokens_user_unique" UNIQUE ("user_id");



ALTER TABLE ONLY "public"."rate_limits"
    ADD CONSTRAINT "rate_limits_pkey" PRIMARY KEY ("bucket", "key");



ALTER TABLE ONLY "public"."recovery_otps"
    ADD CONSTRAINT "recovery_otps_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."student_schedules"
    ADD CONSTRAINT "student_schedules_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."student_schedules"
    ADD CONSTRAINT "student_schedules_unique" UNIQUE ("assignment_id", "weekday");



ALTER TABLE ONLY "public"."subject_prerequisites"
    ADD CONSTRAINT "subject_prereq_unique" UNIQUE ("subject_id", "requires_subject_id");



ALTER TABLE ONLY "public"."subject_prerequisites"
    ADD CONSTRAINT "subject_prerequisites_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."subjects"
    ADD CONSTRAINT "subjects_code_key" UNIQUE ("code");



ALTER TABLE ONLY "public"."subjects"
    ADD CONSTRAINT "subjects_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."system_config"
    ADD CONSTRAINT "system_config_pkey" PRIMARY KEY ("key");



ALTER TABLE ONLY "public"."teacher_groups"
    ADD CONSTRAINT "teacher_groups_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."teacher_groups"
    ADD CONSTRAINT "teacher_groups_unique" UNIQUE ("student_id", "subject_id", "campus_id", "period");



ALTER TABLE ONLY "public"."user_sessions"
    ADD CONSTRAINT "user_sessions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."user_sessions"
    ADD CONSTRAINT "user_sessions_session_id_key" UNIQUE ("session_id");



ALTER TABLE ONLY "public"."users"
    ADD CONSTRAINT "users_email_key" UNIQUE ("email");



ALTER TABLE ONLY "public"."users"
    ADD CONSTRAINT "users_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."users"
    ADD CONSTRAINT "users_student_code_key" UNIQUE ("student_code");



ALTER TABLE ONLY "public"."weekly_evaluations"
    ADD CONSTRAINT "weekly_eval_unique" UNIQUE ("teacher_id", "student_id", "week_start");



ALTER TABLE ONLY "public"."weekly_evaluations"
    ADD CONSTRAINT "weekly_evaluations_pkey" PRIMARY KEY ("id");



CREATE INDEX "asig_alumno_idx" ON "public"."asignaciones_alumnos" USING "btree" ("alumno_id");



CREATE INDEX "asig_encargado_idx" ON "public"."asignaciones_alumnos" USING "btree" ("encargado_id");



CREATE INDEX "asig_periodo_idx" ON "public"."asignaciones_alumnos" USING "btree" ("periodo_id");



CREATE INDEX "asig_sede_idx" ON "public"."asignaciones_alumnos" USING "btree" ("sede_id");



CREATE UNIQUE INDEX "asig_slot_unico_idx" ON "public"."asignaciones_alumnos" USING "btree" ("alumno_id", "periodo_id", "sede_id", "fecha_inicio", "fecha_fin");



CREATE INDEX "estado_sede_periodo_idx" ON "public"."estado_sede_periodo" USING "btree" ("periodo_id");



CREATE INDEX "estado_usuario_periodo_idx" ON "public"."estado_usuario_periodo" USING "btree" ("periodo_id");



CREATE INDEX "idx_access_requests_status" ON "public"."access_requests" USING "btree" ("status", "created_at");



CREATE INDEX "idx_attendances_assignment" ON "public"."attendances" USING "btree" ("assignment_id");



CREATE INDEX "idx_attendances_campus_id" ON "public"."attendances" USING "btree" ("campus_id");



CREATE INDEX "idx_attendances_date" ON "public"."attendances" USING "btree" ("date");



CREATE INDEX "idx_attendances_status" ON "public"."attendances" USING "btree" ("status");



CREATE INDEX "idx_attendances_student_date" ON "public"."attendances" USING "btree" ("student_id", "date" DESC);



CREATE INDEX "idx_attendances_student_id" ON "public"."attendances" USING "btree" ("student_id");



CREATE INDEX "idx_attendances_subject" ON "public"."attendances" USING "btree" ("subject_id");



CREATE INDEX "idx_campus_daily_qr_short" ON "public"."campus_daily_qr" USING "btree" ("campus_id", "qr_date", "short_code");



CREATE INDEX "idx_gate_override_student_subject" ON "public"."assignment_gate_overrides" USING "btree" ("student_id", "subject_id");



CREATE INDEX "idx_justifications_status" ON "public"."justifications" USING "btree" ("status");



CREATE INDEX "idx_justifications_student_id" ON "public"."justifications" USING "btree" ("student_id");



CREATE INDEX "idx_notification_outbox_pending" ON "public"."notification_outbox" USING "btree" ("channel", "status", "created_at") WHERE ("status" = 'pending'::"text");



CREATE INDEX "idx_notification_outbox_status" ON "public"."notification_outbox" USING "btree" ("status", "created_at");



CREATE INDEX "idx_public_attendances_device_fingerprint" ON "public"."attendances" USING "btree" ("device_fingerprint") WHERE ("device_fingerprint" IS NOT NULL);



CREATE INDEX "idx_push_tokens_user" ON "public"."push_tokens" USING "btree" ("user_id");



CREATE INDEX "idx_recovery_otps_email_created" ON "public"."recovery_otps" USING "btree" ("lower"("email"), "created_at" DESC);



CREATE INDEX "idx_recovery_otps_pending" ON "public"."recovery_otps" USING "btree" ("lower"("email"), "expires_at" DESC) WHERE ("consumed_at" IS NULL);



CREATE INDEX "idx_student_schedules_assignment" ON "public"."student_schedules" USING "btree" ("assignment_id");



CREATE INDEX "idx_subject_prereq_subject" ON "public"."subject_prerequisites" USING "btree" ("subject_id");



CREATE INDEX "idx_subjects_career" ON "public"."subjects" USING "btree" ("career");



CREATE INDEX "idx_teacher_groups_campus" ON "public"."teacher_groups" USING "btree" ("campus_id", "period");



CREATE INDEX "idx_teacher_groups_coordinator" ON "public"."teacher_groups" USING "btree" ("coordinator_id", "period");



CREATE INDEX "idx_teacher_groups_student" ON "public"."teacher_groups" USING "btree" ("student_id");



CREATE INDEX "idx_teacher_groups_student_campus" ON "public"."teacher_groups" USING "btree" ("student_id", "campus_id", "period");



CREATE INDEX "idx_teacher_groups_student_campus_subject" ON "public"."teacher_groups" USING "btree" ("student_id", "campus_id", "subject_id", "period");



CREATE INDEX "idx_teacher_groups_student_id" ON "public"."teacher_groups" USING "btree" ("student_id");



CREATE INDEX "idx_teacher_groups_subject" ON "public"."teacher_groups" USING "btree" ("subject_id", "period");



CREATE INDEX "idx_teacher_groups_teacher" ON "public"."teacher_groups" USING "btree" ("teacher_id", "period");



CREATE INDEX "idx_teacher_groups_teacher_id" ON "public"."teacher_groups" USING "btree" ("teacher_id");



CREATE INDEX "idx_user_sessions_user_active" ON "public"."user_sessions" USING "btree" ("user_id", "revoked_at", "last_seen_at" DESC);



CREATE INDEX "idx_users_role" ON "public"."users" USING "btree" ("role");



CREATE INDEX "idx_weekly_eval_student" ON "public"."weekly_evaluations" USING "btree" ("student_id", "week_start");



CREATE INDEX "idx_weekly_eval_teacher" ON "public"."weekly_evaluations" USING "btree" ("teacher_id", "week_start");



CREATE INDEX "justif_attendance_idx" ON "public"."justifications" USING "btree" ("attendance_id");



CREATE INDEX "justif_student_idx" ON "public"."justifications" USING "btree" ("student_id");



CREATE INDEX "metas_periodo_idx" ON "public"."metas_horas_alumno" USING "btree" ("periodo_id");



CREATE UNIQUE INDEX "periodos_activo_unico_idx" ON "public"."periodos_academicos" USING "btree" ("activo") WHERE ("activo" = true);



CREATE OR REPLACE TRIGGER "trg_asignaciones_alumnos_actualizado_en" BEFORE UPDATE ON "public"."asignaciones_alumnos" FOR EACH ROW EXECUTE FUNCTION "public"."fn_set_actualizado_en"();



CREATE OR REPLACE TRIGGER "trg_audit_campuses_delegation" AFTER INSERT OR DELETE OR UPDATE ON "public"."campuses" FOR EACH ROW EXECUTE FUNCTION "public"."audit_delegated_client_change"();



CREATE OR REPLACE TRIGGER "trg_audit_users_delegation" AFTER INSERT OR DELETE OR UPDATE ON "public"."users" FOR EACH ROW EXECUTE FUNCTION "public"."audit_delegated_client_change"();



CREATE OR REPLACE TRIGGER "trg_block_audit_delete" BEFORE DELETE ON "public"."audit_log" FOR EACH ROW EXECUTE FUNCTION "public"."block_audit_mutation"();



CREATE OR REPLACE TRIGGER "trg_block_audit_update" BEFORE UPDATE ON "public"."audit_log" FOR EACH ROW EXECUTE FUNCTION "public"."block_audit_mutation"();



CREATE OR REPLACE TRIGGER "trg_compliance_alert" AFTER INSERT OR UPDATE OF "worked_hours" ON "public"."attendances" FOR EACH ROW WHEN (("new"."check_out" IS NOT NULL)) EXECUTE FUNCTION "public"."fn_compliance_alert"();



CREATE OR REPLACE TRIGGER "trg_dispatch_outbox_item" AFTER INSERT ON "public"."notification_outbox" FOR EACH ROW WHEN (("new"."status" = 'pending'::"text")) EXECUTE FUNCTION "public"."fn_dispatch_outbox_item"();



CREATE OR REPLACE TRIGGER "trg_enforce_assignment_gate" BEFORE INSERT OR UPDATE OF "student_id", "subject_id" ON "public"."teacher_groups" FOR EACH ROW EXECUTE FUNCTION "public"."enforce_assignment_gate"();



CREATE OR REPLACE TRIGGER "trg_enforce_campus_capacity" BEFORE INSERT OR UPDATE OF "campus_id", "student_id", "period" ON "public"."teacher_groups" FOR EACH ROW EXECUTE FUNCTION "public"."enforce_campus_capacity"();



CREATE OR REPLACE TRIGGER "trg_estado_sede_periodo_actualizado_en" BEFORE UPDATE ON "public"."estado_sede_periodo" FOR EACH ROW EXECUTE FUNCTION "public"."fn_set_actualizado_en"();



CREATE OR REPLACE TRIGGER "trg_estado_usuario_periodo_actualizado_en" BEFORE UPDATE ON "public"."estado_usuario_periodo" FOR EACH ROW EXECUTE FUNCTION "public"."fn_set_actualizado_en"();



CREATE OR REPLACE TRIGGER "trg_justifications_actualizado_en" BEFORE UPDATE ON "public"."justifications" FOR EACH ROW EXECUTE FUNCTION "public"."fn_set_actualizado_en"();



CREATE OR REPLACE TRIGGER "trg_location_mismatch" BEFORE INSERT OR UPDATE ON "public"."attendances" FOR EACH ROW EXECUTE FUNCTION "public"."fn_check_location_mismatch"();



CREATE OR REPLACE TRIGGER "trg_log_justification_decision" AFTER UPDATE ON "public"."justifications" FOR EACH ROW EXECUTE FUNCTION "public"."fn_log_justification_decision"();



CREATE OR REPLACE TRIGGER "trg_metas_horas_alumno_actualizado_en" BEFORE UPDATE ON "public"."metas_horas_alumno" FOR EACH ROW EXECUTE FUNCTION "public"."fn_set_actualizado_en"();



CREATE OR REPLACE TRIGGER "trg_notify_justification_decision" AFTER UPDATE ON "public"."justifications" FOR EACH ROW EXECUTE FUNCTION "public"."fn_notify_justification_decision"();



CREATE OR REPLACE TRIGGER "trg_notify_justification_escalation" AFTER UPDATE ON "public"."justifications" FOR EACH ROW EXECUTE FUNCTION "public"."fn_notify_justification_escalation"();



CREATE OR REPLACE TRIGGER "trg_notify_justification_received" AFTER INSERT ON "public"."justifications" FOR EACH ROW EXECUTE FUNCTION "public"."fn_notify_justification_received"();



CREATE OR REPLACE TRIGGER "trg_periodos_academicos_actualizado_en" BEFORE UPDATE ON "public"."periodos_academicos" FOR EACH ROW EXECUTE FUNCTION "public"."fn_set_actualizado_en"();



CREATE OR REPLACE TRIGGER "trg_protect_users_columns" BEFORE UPDATE ON "public"."users" FOR EACH ROW EXECUTE FUNCTION "public"."fn_protect_users_columns"();



CREATE OR REPLACE TRIGGER "trg_security_notification" AFTER INSERT ON "public"."audit_log" FOR EACH ROW EXECUTE FUNCTION "public"."fn_queue_security_notification"();



CREATE OR REPLACE TRIGGER "trg_validate_checkout_parity" BEFORE UPDATE OF "check_out" ON "public"."attendances" FOR EACH ROW EXECUTE FUNCTION "public"."validate_checkout_parity"();



CREATE OR REPLACE TRIGGER "trg_weekly_eval_actualizado" BEFORE UPDATE ON "public"."weekly_evaluations" FOR EACH ROW EXECUTE FUNCTION "public"."fn_set_actualizado_en"();



ALTER TABLE ONLY "public"."access_requests"
    ADD CONSTRAINT "access_requests_decided_by_fkey" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id");



ALTER TABLE ONLY "public"."asignaciones_alumnos"
    ADD CONSTRAINT "asignaciones_alumnos_alumno_id_fkey" FOREIGN KEY ("alumno_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."asignaciones_alumnos"
    ADD CONSTRAINT "asignaciones_alumnos_encargado_id_fkey" FOREIGN KEY ("encargado_id") REFERENCES "public"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."asignaciones_alumnos"
    ADD CONSTRAINT "asignaciones_alumnos_periodo_id_fkey" FOREIGN KEY ("periodo_id") REFERENCES "public"."periodos_academicos"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."asignaciones_alumnos"
    ADD CONSTRAINT "asignaciones_alumnos_sede_id_fkey" FOREIGN KEY ("sede_id") REFERENCES "public"."campuses"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."assignment_gate_overrides"
    ADD CONSTRAINT "assignment_gate_overrides_granted_by_fkey" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id");



ALTER TABLE ONLY "public"."assignment_gate_overrides"
    ADD CONSTRAINT "assignment_gate_overrides_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."assignment_gate_overrides"
    ADD CONSTRAINT "assignment_gate_overrides_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."attendances"
    ADD CONSTRAINT "attendances_assignment_id_fkey" FOREIGN KEY ("assignment_id") REFERENCES "public"."teacher_groups"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."attendances"
    ADD CONSTRAINT "attendances_campus_id_fkey" FOREIGN KEY ("campus_id") REFERENCES "public"."campuses"("id");



ALTER TABLE ONLY "public"."attendances"
    ADD CONSTRAINT "attendances_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "public"."users"("id");



ALTER TABLE ONLY "public"."attendances"
    ADD CONSTRAINT "attendances_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."campus_daily_qr"
    ADD CONSTRAINT "campus_daily_qr_campus_id_fkey" FOREIGN KEY ("campus_id") REFERENCES "public"."campuses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."campus_qr"
    ADD CONSTRAINT "campus_qr_campus_id_fkey" FOREIGN KEY ("campus_id") REFERENCES "public"."campuses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."estado_sede_periodo"
    ADD CONSTRAINT "estado_sede_periodo_periodo_id_fkey" FOREIGN KEY ("periodo_id") REFERENCES "public"."periodos_academicos"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."estado_sede_periodo"
    ADD CONSTRAINT "estado_sede_periodo_sede_id_fkey" FOREIGN KEY ("sede_id") REFERENCES "public"."campuses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."estado_usuario_periodo"
    ADD CONSTRAINT "estado_usuario_periodo_periodo_id_fkey" FOREIGN KEY ("periodo_id") REFERENCES "public"."periodos_academicos"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."estado_usuario_periodo"
    ADD CONSTRAINT "estado_usuario_periodo_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."justifications"
    ADD CONSTRAINT "justifications_absence_campus_id_fkey" FOREIGN KEY ("absence_campus_id") REFERENCES "public"."campuses"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."justifications"
    ADD CONSTRAINT "justifications_attendance_id_fkey" FOREIGN KEY ("attendance_id") REFERENCES "public"."attendances"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."justifications"
    ADD CONSTRAINT "justifications_escalated_by_fkey" FOREIGN KEY ("escalated_by") REFERENCES "public"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."justifications"
    ADD CONSTRAINT "justifications_revisado_por_fkey" FOREIGN KEY ("revisado_por") REFERENCES "public"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."justifications"
    ADD CONSTRAINT "justifications_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."metas_horas_alumno"
    ADD CONSTRAINT "metas_horas_alumno_alumno_id_fkey" FOREIGN KEY ("alumno_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."metas_horas_alumno"
    ADD CONSTRAINT "metas_horas_alumno_periodo_id_fkey" FOREIGN KEY ("periodo_id") REFERENCES "public"."periodos_academicos"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."notification_outbox"
    ADD CONSTRAINT "notification_outbox_attendance_id_fkey" FOREIGN KEY ("attendance_id") REFERENCES "public"."attendances"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."push_tokens"
    ADD CONSTRAINT "push_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."recovery_otps"
    ADD CONSTRAINT "recovery_otps_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."student_schedules"
    ADD CONSTRAINT "student_schedules_assignment_id_fkey" FOREIGN KEY ("assignment_id") REFERENCES "public"."teacher_groups"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."subject_prerequisites"
    ADD CONSTRAINT "subject_prerequisites_requires_subject_id_fkey" FOREIGN KEY ("requires_subject_id") REFERENCES "public"."subjects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."subject_prerequisites"
    ADD CONSTRAINT "subject_prerequisites_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."teacher_groups"
    ADD CONSTRAINT "teacher_groups_campus_id_fkey" FOREIGN KEY ("campus_id") REFERENCES "public"."campuses"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."teacher_groups"
    ADD CONSTRAINT "teacher_groups_coordinator_id_fkey" FOREIGN KEY ("coordinator_id") REFERENCES "public"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."teacher_groups"
    ADD CONSTRAINT "teacher_groups_goal_decided_by_fkey" FOREIGN KEY ("goal_decided_by") REFERENCES "public"."users"("id");



ALTER TABLE ONLY "public"."teacher_groups"
    ADD CONSTRAINT "teacher_groups_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."teacher_groups"
    ADD CONSTRAINT "teacher_groups_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."teacher_groups"
    ADD CONSTRAINT "teacher_groups_teacher_id_fkey" FOREIGN KEY ("teacher_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_sessions"
    ADD CONSTRAINT "user_sessions_revoked_by_fkey" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."user_sessions"
    ADD CONSTRAINT "user_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."users"
    ADD CONSTRAINT "users_campus_id_fkey" FOREIGN KEY ("campus_id") REFERENCES "public"."campuses"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."weekly_evaluations"
    ADD CONSTRAINT "weekly_evaluations_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."weekly_evaluations"
    ADD CONSTRAINT "weekly_evaluations_teacher_id_fkey" FOREIGN KEY ("teacher_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE "public"."access_requests" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "admin_reads_overrides" ON "public"."assignment_gate_overrides" FOR SELECT TO "authenticated" USING (("upper"("public"."get_current_user_role"()) = ANY (ARRAY['ADMIN'::"text", 'COORDINATOR'::"text", 'COORDINADOR'::"text"])));



CREATE POLICY "anyone_insert_access_request" ON "public"."access_requests" FOR INSERT TO "authenticated", "anon" WITH CHECK (("status" = 'pending'::"text"));



ALTER TABLE "public"."asignaciones_alumnos" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."assignment_gate_overrides" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."attendances" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "attendances_coordinator_read" ON "public"."attendances" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."users" "u"
  WHERE (("u"."id" = "auth"."uid"()) AND ("upper"("u"."role") = ANY (ARRAY['ADMIN'::"text", 'COORDINATOR'::"text", 'COORDINADOR'::"text", 'TEACHER'::"text", 'DOCENTE'::"text"]))))));



CREATE POLICY "attendances_coordinator_update" ON "public"."attendances" FOR UPDATE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."users" "u"
  WHERE (("u"."id" = "auth"."uid"()) AND ("upper"("u"."role") = ANY (ARRAY['ADMIN'::"text", 'COORDINATOR'::"text", 'COORDINADOR'::"text"]))))));



CREATE POLICY "attendances_student_read_own" ON "public"."attendances" FOR SELECT TO "authenticated" USING (("student_id" = "auth"."uid"()));



ALTER TABLE "public"."audit_log" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "audit_log_insert_authenticated" ON "public"."audit_log" FOR INSERT TO "authenticated" WITH CHECK (("actor_user_id" = "auth"."uid"()));



CREATE POLICY "audit_log_read_admins" ON "public"."audit_log" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."users" "u"
  WHERE (("u"."id" = "auth"."uid"()) AND ("upper"("u"."role") = ANY (ARRAY['ADMIN'::"text", 'COORDINATOR'::"text", 'COORDINADOR'::"text"]))))));



CREATE POLICY "authenticated_reads_careers" ON "public"."careers" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "authenticated_reads_holidays" ON "public"."holidays" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "authenticated_reads_prereqs" ON "public"."subject_prerequisites" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "authenticated_reads_subjects" ON "public"."subjects" FOR SELECT TO "authenticated" USING (true);



ALTER TABLE "public"."campus_daily_qr" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."campus_qr" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "campus_qr_read_coordinators" ON "public"."campus_daily_qr" FOR SELECT TO "authenticated" USING (("upper"("public"."get_current_user_role"()) = ANY (ARRAY['ADMIN'::"text", 'COORDINATOR'::"text", 'COORDINADOR'::"text"])));



CREATE POLICY "campus_qr_read_coordinators" ON "public"."campus_qr" FOR SELECT TO "authenticated" USING (("upper"("public"."get_current_user_role"()) = ANY (ARRAY['ADMIN'::"text", 'COORDINATOR'::"text", 'COORDINADOR'::"text"])));



ALTER TABLE "public"."campuses" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "campuses_read_authenticated" ON "public"."campuses" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "campuses_write_admins" ON "public"."campuses" TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."users" "u"
  WHERE (("u"."id" = "auth"."uid"()) AND ("upper"("u"."role") = ANY (ARRAY['ADMIN'::"text", 'COORDINATOR'::"text", 'COORDINADOR'::"text", 'TEACHER'::"text", 'DOCENTE'::"text"])))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."users" "u"
  WHERE (("u"."id" = "auth"."uid"()) AND ("upper"("u"."role") = ANY (ARRAY['ADMIN'::"text", 'COORDINATOR'::"text", 'COORDINADOR'::"text", 'TEACHER'::"text", 'DOCENTE'::"text"]))))));



ALTER TABLE "public"."careers" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "coordinator_reads_own_assignments" ON "public"."teacher_groups" FOR SELECT TO "authenticated" USING (("coordinator_id" = "auth"."uid"()));



CREATE POLICY "coordinators_manage_careers" ON "public"."careers" TO "authenticated" USING (("upper"("public"."get_current_user_role"()) = ANY (ARRAY['ADMIN'::"text", 'COORDINATOR'::"text", 'COORDINADOR'::"text"]))) WITH CHECK (("upper"("public"."get_current_user_role"()) = ANY (ARRAY['ADMIN'::"text", 'COORDINATOR'::"text", 'COORDINADOR'::"text"])));



CREATE POLICY "coordinators_manage_groups" ON "public"."teacher_groups" TO "authenticated" USING (("upper"("public"."get_current_user_role"()) = ANY (ARRAY['ADMIN'::"text", 'COORDINATOR'::"text", 'COORDINADOR'::"text"]))) WITH CHECK (("upper"("public"."get_current_user_role"()) = ANY (ARRAY['ADMIN'::"text", 'COORDINATOR'::"text", 'COORDINADOR'::"text"])));



CREATE POLICY "coordinators_manage_holidays" ON "public"."holidays" TO "authenticated" USING (("upper"("public"."get_current_user_role"()) = ANY (ARRAY['ADMIN'::"text", 'COORDINATOR'::"text", 'COORDINADOR'::"text", 'TEACHER'::"text", 'DOCENTE'::"text"]))) WITH CHECK (("upper"("public"."get_current_user_role"()) = ANY (ARRAY['ADMIN'::"text", 'COORDINATOR'::"text", 'COORDINADOR'::"text", 'TEACHER'::"text", 'DOCENTE'::"text"])));



CREATE POLICY "coordinators_manage_prereqs" ON "public"."subject_prerequisites" TO "authenticated" USING (("upper"("public"."get_current_user_role"()) = ANY (ARRAY['ADMIN'::"text", 'COORDINATOR'::"text", 'COORDINADOR'::"text"]))) WITH CHECK (("upper"("public"."get_current_user_role"()) = ANY (ARRAY['ADMIN'::"text", 'COORDINATOR'::"text", 'COORDINADOR'::"text"])));



CREATE POLICY "coordinators_manage_schedules" ON "public"."student_schedules" TO "authenticated" USING (("upper"("public"."get_current_user_role"()) = ANY (ARRAY['ADMIN'::"text", 'COORDINATOR'::"text", 'COORDINADOR'::"text"]))) WITH CHECK (("upper"("public"."get_current_user_role"()) = ANY (ARRAY['ADMIN'::"text", 'COORDINATOR'::"text", 'COORDINADOR'::"text"])));



CREATE POLICY "coordinators_manage_subjects" ON "public"."subjects" TO "authenticated" USING (("upper"("public"."get_current_user_role"()) = ANY (ARRAY['ADMIN'::"text", 'COORDINATOR'::"text", 'COORDINADOR'::"text"]))) WITH CHECK (("upper"("public"."get_current_user_role"()) = ANY (ARRAY['ADMIN'::"text", 'COORDINATOR'::"text", 'COORDINADOR'::"text"])));



CREATE POLICY "coordinators_read_all_users" ON "public"."users" FOR SELECT TO "authenticated" USING (("upper"("public"."get_current_user_role"()) = ANY (ARRAY['ADMIN'::"text", 'COORDINATOR'::"text", 'COORDINADOR'::"text"])));



CREATE POLICY "coordinators_read_evals" ON "public"."weekly_evaluations" FOR SELECT TO "authenticated" USING (("upper"("public"."get_current_user_role"()) = ANY (ARRAY['ADMIN'::"text", 'COORDINATOR'::"text", 'COORDINADOR'::"text"])));



CREATE POLICY "coordinators_update_users" ON "public"."users" FOR UPDATE TO "authenticated" USING (("upper"("public"."get_current_user_role"()) = ANY (ARRAY['ADMIN'::"text", 'COORDINATOR'::"text", 'COORDINADOR'::"text"]))) WITH CHECK (("upper"("public"."get_current_user_role"()) = ANY (ARRAY['ADMIN'::"text", 'COORDINATOR'::"text", 'COORDINADOR'::"text"])));



ALTER TABLE "public"."estado_sede_periodo" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."estado_usuario_periodo" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."holidays" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."justifications" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."metas_horas_alumno" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."notification_outbox" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."periodos_academicos" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."push_tokens" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."rate_limits" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."recovery_otps" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "reviewers_select_justifications" ON "public"."justifications" FOR SELECT USING (("public"."get_current_user_role"() = ANY (ARRAY['ADMIN'::"text", 'COORDINATOR'::"text", 'COORDINADOR'::"text", 'TEACHER'::"text", 'DOCENTE'::"text"])));



CREATE POLICY "reviewers_update_justifications" ON "public"."justifications" FOR UPDATE USING (("public"."get_current_user_role"() = ANY (ARRAY['ADMIN'::"text", 'COORDINATOR'::"text", 'COORDINADOR'::"text", 'TEACHER'::"text", 'DOCENTE'::"text"]))) WITH CHECK ((("status" = ANY (ARRAY['PENDIENTE'::"text", 'APROBADO'::"text", 'RECHAZADO'::"text"])) AND ("public"."get_current_user_role"() = ANY (ARRAY['ADMIN'::"text", 'COORDINATOR'::"text", 'COORDINADOR'::"text", 'TEACHER'::"text", 'DOCENTE'::"text"]))));



CREATE POLICY "service_role_all" ON "public"."asignaciones_alumnos" USING (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "service_role_all" ON "public"."estado_sede_periodo" USING (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "service_role_all" ON "public"."estado_usuario_periodo" USING (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "service_role_all" ON "public"."justifications" TO "service_role" USING (true);



CREATE POLICY "service_role_all" ON "public"."metas_horas_alumno" USING (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "service_role_all" ON "public"."periodos_academicos" USING (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "service_role_attendances" ON "public"."attendances" TO "service_role" USING (true);



CREATE POLICY "service_role_audit_log" ON "public"."audit_log" TO "service_role" USING (true);



CREATE POLICY "service_role_campus_qr" ON "public"."campus_daily_qr" TO "service_role" USING (true);



CREATE POLICY "service_role_campus_qr_static" ON "public"."campus_qr" TO "service_role" USING (true);



CREATE POLICY "service_role_campuses" ON "public"."campuses" TO "service_role" USING (true);



CREATE POLICY "service_role_careers" ON "public"."careers" TO "service_role" USING (true);



CREATE POLICY "service_role_evals" ON "public"."weekly_evaluations" TO "service_role" USING (true);



CREATE POLICY "service_role_holidays" ON "public"."holidays" TO "service_role" USING (true);



CREATE POLICY "service_role_outbox" ON "public"."notification_outbox" TO "service_role" USING (true);



CREATE POLICY "service_role_overrides" ON "public"."assignment_gate_overrides" TO "service_role" USING (true);



CREATE POLICY "service_role_prereqs" ON "public"."subject_prerequisites" TO "service_role" USING (true);



CREATE POLICY "service_role_rate_limits" ON "public"."rate_limits" TO "service_role" USING (true);



CREATE POLICY "service_role_read_tokens" ON "public"."push_tokens" TO "service_role" USING (true);



CREATE POLICY "service_role_recovery_otps" ON "public"."recovery_otps" TO "service_role" USING (true);



CREATE POLICY "service_role_student_schedules" ON "public"."student_schedules" TO "service_role" USING (true);



CREATE POLICY "service_role_subjects" ON "public"."subjects" TO "service_role" USING (true);



CREATE POLICY "service_role_system_config" ON "public"."system_config" TO "service_role" USING (true);



CREATE POLICY "service_role_teacher_groups" ON "public"."teacher_groups" TO "service_role" USING (true);



CREATE POLICY "service_role_users" ON "public"."users" TO "service_role" USING (true);



CREATE POLICY "staff_read_access_requests" ON "public"."access_requests" FOR SELECT TO "authenticated" USING (("upper"("public"."get_current_user_role"()) = ANY (ARRAY['ADMIN'::"text", 'COORDINATOR'::"text", 'COORDINADOR'::"text", 'TEACHER'::"text", 'DOCENTE'::"text"])));



CREATE POLICY "staff_update_access_requests" ON "public"."access_requests" FOR UPDATE TO "authenticated" USING (("upper"("public"."get_current_user_role"()) = ANY (ARRAY['ADMIN'::"text", 'COORDINATOR'::"text", 'COORDINADOR'::"text", 'TEACHER'::"text", 'DOCENTE'::"text"]))) WITH CHECK (("upper"("public"."get_current_user_role"()) = ANY (ARRAY['ADMIN'::"text", 'COORDINATOR'::"text", 'COORDINADOR'::"text", 'TEACHER'::"text", 'DOCENTE'::"text"])));



CREATE POLICY "student_insert_own" ON "public"."justifications" FOR INSERT WITH CHECK (("student_id" = "auth"."uid"()));



CREATE POLICY "student_reads_own_assignment" ON "public"."teacher_groups" FOR SELECT TO "authenticated" USING (("student_id" = "auth"."uid"()));



CREATE POLICY "student_reads_own_evals" ON "public"."weekly_evaluations" FOR SELECT TO "authenticated" USING (("student_id" = "auth"."uid"()));



CREATE POLICY "student_reads_own_schedule" ON "public"."student_schedules" FOR SELECT TO "authenticated" USING (("assignment_id" IN ( SELECT "teacher_groups"."id"
   FROM "public"."teacher_groups"
  WHERE ("teacher_groups"."student_id" = "auth"."uid"()))));



ALTER TABLE "public"."student_schedules" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "student_select_own" ON "public"."justifications" FOR SELECT USING (("student_id" = "auth"."uid"()));



ALTER TABLE "public"."subject_prerequisites" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."subjects" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "subjects_read_authenticated" ON "public"."subjects" FOR SELECT TO "authenticated" USING (true);



ALTER TABLE "public"."system_config" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "system_config_read_authenticated" ON "public"."system_config" FOR SELECT TO "authenticated" USING (("key" = ANY (ARRAY['risk_threshold_pct'::"text", 'compliance_alert_threshold_pct'::"text", 'required_practice_hours'::"text"])));



ALTER TABLE "public"."teacher_groups" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "teacher_manages_own_evals" ON "public"."weekly_evaluations" TO "authenticated" USING (("teacher_id" = "auth"."uid"())) WITH CHECK (("teacher_id" = "auth"."uid"()));



CREATE POLICY "teacher_reads_group_members" ON "public"."users" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."teacher_groups" "tg"
  WHERE (("tg"."teacher_id" = "auth"."uid"()) AND ("tg"."student_id" = "users"."id")))));



CREATE POLICY "teacher_reads_group_schedule" ON "public"."student_schedules" FOR SELECT TO "authenticated" USING (("assignment_id" IN ( SELECT "teacher_groups"."id"
   FROM "public"."teacher_groups"
  WHERE ("teacher_groups"."teacher_id" = "auth"."uid"()))));



CREATE POLICY "teacher_reads_own_decision_history" ON "public"."audit_log" FOR SELECT TO "authenticated" USING ((("actor_user_id" = "auth"."uid"()) AND ("action" = ANY (ARRAY['JUSTIFICATION_REVIEWED'::"text", 'JUSTIFICATION_ESCALATED'::"text"])) AND (EXISTS ( SELECT 1
   FROM "public"."users" "u"
  WHERE (("u"."id" = "auth"."uid"()) AND ("upper"("u"."role") = ANY (ARRAY['DOCENTE'::"text", 'TEACHER'::"text"])))))));



CREATE POLICY "teacher_reads_own_group" ON "public"."teacher_groups" FOR SELECT TO "authenticated" USING (("teacher_id" = "auth"."uid"()));



ALTER TABLE "public"."user_sessions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "user_sessions_read_own" ON "public"."user_sessions" FOR SELECT TO "authenticated" USING (("user_id" = "auth"."uid"()));



CREATE POLICY "user_sessions_service_role_all" ON "public"."user_sessions" TO "service_role" USING (true);



CREATE POLICY "user_upsert_own_token" ON "public"."push_tokens" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."users" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "users_read_own" ON "public"."users" FOR SELECT TO "authenticated" USING (("id" = "auth"."uid"()));



CREATE POLICY "users_update_own" ON "public"."users" FOR UPDATE TO "authenticated" USING (("id" = "auth"."uid"())) WITH CHECK (("id" = "auth"."uid"()));



ALTER TABLE "public"."weekly_evaluations" ENABLE ROW LEVEL SECURITY;


GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";



REVOKE ALL ON FUNCTION "public"."accept_legal_terms"("p_version" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."accept_legal_terms"("p_version" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."accept_legal_terms"("p_version" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."accept_legal_terms"("p_version" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."audit_delegated_client_change"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."audit_delegated_client_change"() TO "anon";
GRANT ALL ON FUNCTION "public"."audit_delegated_client_change"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."audit_delegated_client_change"() TO "service_role";



GRANT ALL ON FUNCTION "public"."block_audit_mutation"() TO "anon";
GRANT ALL ON FUNCTION "public"."block_audit_mutation"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."block_audit_mutation"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."close_due_cycles"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."close_due_cycles"() TO "anon";
GRANT ALL ON FUNCTION "public"."close_due_cycles"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."close_due_cycles"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."complete_password_change"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."complete_password_change"() TO "anon";
GRANT ALL ON FUNCTION "public"."complete_password_change"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."complete_password_change"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."confirm_hospital_presence_tech_failure"("p_student_id" "uuid", "p_campus_id" "uuid", "p_representative_name" "text", "p_representative_role" "text", "p_reason" "text", "p_confirmed_at" timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."confirm_hospital_presence_tech_failure"("p_student_id" "uuid", "p_campus_id" "uuid", "p_representative_name" "text", "p_representative_role" "text", "p_reason" "text", "p_confirmed_at" timestamp with time zone) TO "anon";
GRANT ALL ON FUNCTION "public"."confirm_hospital_presence_tech_failure"("p_student_id" "uuid", "p_campus_id" "uuid", "p_representative_name" "text", "p_representative_role" "text", "p_reason" "text", "p_confirmed_at" timestamp with time zone) TO "authenticated";
GRANT ALL ON FUNCTION "public"."confirm_hospital_presence_tech_failure"("p_student_id" "uuid", "p_campus_id" "uuid", "p_representative_name" "text", "p_representative_role" "text", "p_reason" "text", "p_confirmed_at" timestamp with time zone) TO "service_role";



REVOKE ALL ON FUNCTION "public"."decide_assignment_goal"("p_assignment_id" "uuid", "p_decision" "text", "p_note" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."decide_assignment_goal"("p_assignment_id" "uuid", "p_decision" "text", "p_note" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."decide_assignment_goal"("p_assignment_id" "uuid", "p_decision" "text", "p_note" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."decide_assignment_goal"("p_assignment_id" "uuid", "p_decision" "text", "p_note" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."detect_device_fingerprint_conflict"("p_device_fingerprint" "text", "p_campus_id" "uuid", "p_student_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."detect_device_fingerprint_conflict"("p_device_fingerprint" "text", "p_campus_id" "uuid", "p_student_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."detect_device_fingerprint_conflict"("p_device_fingerprint" "text", "p_campus_id" "uuid", "p_student_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."detect_device_fingerprint_conflict"("p_device_fingerprint" "text", "p_campus_id" "uuid", "p_student_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."email_for_login"("p_identifier" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."email_for_login"("p_identifier" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."email_for_login"("p_identifier" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."email_for_login"("p_identifier" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."enforce_assignment_gate"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."enforce_assignment_gate"() TO "anon";
GRANT ALL ON FUNCTION "public"."enforce_assignment_gate"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."enforce_assignment_gate"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."enforce_campus_capacity"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."enforce_campus_capacity"() TO "anon";
GRANT ALL ON FUNCTION "public"."enforce_campus_capacity"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."enforce_campus_capacity"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."escalate_justification"("p_id" "uuid", "p_nota" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."escalate_justification"("p_id" "uuid", "p_nota" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."escalate_justification"("p_id" "uuid", "p_nota" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."escalate_justification"("p_id" "uuid", "p_nota" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."fn_check_location_mismatch"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."fn_check_location_mismatch"() TO "anon";
GRANT ALL ON FUNCTION "public"."fn_check_location_mismatch"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."fn_check_location_mismatch"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."fn_compliance_alert"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."fn_compliance_alert"() TO "anon";
GRANT ALL ON FUNCTION "public"."fn_compliance_alert"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."fn_compliance_alert"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."fn_detect_open_attendances"("p_max_hours" numeric) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."fn_detect_open_attendances"("p_max_hours" numeric) TO "anon";
GRANT ALL ON FUNCTION "public"."fn_detect_open_attendances"("p_max_hours" numeric) TO "authenticated";
GRANT ALL ON FUNCTION "public"."fn_detect_open_attendances"("p_max_hours" numeric) TO "service_role";



REVOKE ALL ON FUNCTION "public"."fn_dispatch_outbox_item"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."fn_dispatch_outbox_item"() TO "anon";
GRANT ALL ON FUNCTION "public"."fn_dispatch_outbox_item"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."fn_dispatch_outbox_item"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."fn_enqueue_checkout_reminders"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."fn_enqueue_checkout_reminders"() TO "anon";
GRANT ALL ON FUNCTION "public"."fn_enqueue_checkout_reminders"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."fn_enqueue_checkout_reminders"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."fn_log_justification_decision"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."fn_log_justification_decision"() TO "anon";
GRANT ALL ON FUNCTION "public"."fn_log_justification_decision"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."fn_log_justification_decision"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."fn_log_omission_alert"("p_attendance_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."fn_log_omission_alert"("p_attendance_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."fn_log_omission_alert"("p_attendance_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."fn_log_omission_alert"("p_attendance_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."fn_notify_justification_decision"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."fn_notify_justification_decision"() TO "anon";
GRANT ALL ON FUNCTION "public"."fn_notify_justification_decision"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."fn_notify_justification_decision"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."fn_notify_justification_escalation"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."fn_notify_justification_escalation"() TO "anon";
GRANT ALL ON FUNCTION "public"."fn_notify_justification_escalation"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."fn_notify_justification_escalation"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."fn_notify_justification_received"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."fn_notify_justification_received"() TO "anon";
GRANT ALL ON FUNCTION "public"."fn_notify_justification_received"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."fn_notify_justification_received"() TO "service_role";



GRANT ALL ON FUNCTION "public"."fn_protect_users_columns"() TO "anon";
GRANT ALL ON FUNCTION "public"."fn_protect_users_columns"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."fn_protect_users_columns"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."fn_queue_coordinator_notification"("p_type" "text", "p_attendance_id" "uuid", "p_payload" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."fn_queue_coordinator_notification"("p_type" "text", "p_attendance_id" "uuid", "p_payload" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."fn_queue_coordinator_notification"("p_type" "text", "p_attendance_id" "uuid", "p_payload" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."fn_queue_coordinator_notification"("p_type" "text", "p_attendance_id" "uuid", "p_payload" "jsonb") TO "service_role";



REVOKE ALL ON FUNCTION "public"."fn_queue_location_mismatch_notifications"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."fn_queue_location_mismatch_notifications"() TO "anon";
GRANT ALL ON FUNCTION "public"."fn_queue_location_mismatch_notifications"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."fn_queue_location_mismatch_notifications"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."fn_queue_security_notification"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."fn_queue_security_notification"() TO "anon";
GRANT ALL ON FUNCTION "public"."fn_queue_security_notification"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."fn_queue_security_notification"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."fn_retry_pending_outbox"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."fn_retry_pending_outbox"() TO "anon";
GRANT ALL ON FUNCTION "public"."fn_retry_pending_outbox"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."fn_retry_pending_outbox"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."fn_set_actualizado_en"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."fn_set_actualizado_en"() TO "anon";
GRANT ALL ON FUNCTION "public"."fn_set_actualizado_en"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."fn_set_actualizado_en"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_campus_active_students"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_campus_active_students"() TO "anon";
GRANT ALL ON FUNCTION "public"."get_campus_active_students"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_campus_active_students"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_campus_subjects"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_campus_subjects"() TO "anon";
GRANT ALL ON FUNCTION "public"."get_campus_subjects"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_campus_subjects"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_current_user_role"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_current_user_role"() TO "anon";
GRANT ALL ON FUNCTION "public"."get_current_user_role"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_current_user_role"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_my_conduct_reports"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_my_conduct_reports"() TO "anon";
GRANT ALL ON FUNCTION "public"."get_my_conduct_reports"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_my_conduct_reports"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_security_question"("p_email" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_security_question"("p_email" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."get_security_question"("p_email" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_security_question"("p_email" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."grant_assignment_override"("p_student_id" "uuid", "p_subject_id" "uuid", "p_reason" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."grant_assignment_override"("p_student_id" "uuid", "p_subject_id" "uuid", "p_reason" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."grant_assignment_override"("p_student_id" "uuid", "p_subject_id" "uuid", "p_reason" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."grant_assignment_override"("p_student_id" "uuid", "p_subject_id" "uuid", "p_reason" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."haversine_meters"("p_lat1" numeric, "p_lng1" numeric, "p_lat2" numeric, "p_lng2" numeric) TO "anon";
GRANT ALL ON FUNCTION "public"."haversine_meters"("p_lat1" numeric, "p_lng1" numeric, "p_lat2" numeric, "p_lng2" numeric) TO "authenticated";
GRANT ALL ON FUNCTION "public"."haversine_meters"("p_lat1" numeric, "p_lng1" numeric, "p_lat2" numeric, "p_lng2" numeric) TO "service_role";



REVOKE ALL ON FUNCTION "public"."list_my_active_sessions"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."list_my_active_sessions"() TO "anon";
GRANT ALL ON FUNCTION "public"."list_my_active_sessions"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."list_my_active_sessions"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."rate_limit_hit"("p_bucket" "text", "p_key" "text", "p_max" integer, "p_window_seconds" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."rate_limit_hit"("p_bucket" "text", "p_key" "text", "p_max" integer, "p_window_seconds" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."rate_limit_hit"("p_bucket" "text", "p_key" "text", "p_max" integer, "p_window_seconds" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."rate_limit_hit"("p_bucket" "text", "p_key" "text", "p_max" integer, "p_window_seconds" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."report_student_conduct"("p_attendance_id" "uuid", "p_motivo" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."report_student_conduct"("p_attendance_id" "uuid", "p_motivo" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."report_student_conduct"("p_attendance_id" "uuid", "p_motivo" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."report_student_conduct"("p_attendance_id" "uuid", "p_motivo" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."revoke_my_other_sessions"("p_current_session_id" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."revoke_my_other_sessions"("p_current_session_id" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."revoke_my_other_sessions"("p_current_session_id" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."revoke_my_other_sessions"("p_current_session_id" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."revoke_my_session"("p_session_id" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."revoke_my_session"("p_session_id" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."revoke_my_session"("p_session_id" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."revoke_my_session"("p_session_id" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."set_active_session"("p_session_id" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."set_active_session"("p_session_id" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."set_active_session"("p_session_id" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_active_session"("p_session_id" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."set_active_session"("p_session_id" "text", "p_device_label" "text", "p_user_agent" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."set_active_session"("p_session_id" "text", "p_device_label" "text", "p_user_agent" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."set_active_session"("p_session_id" "text", "p_device_label" "text", "p_user_agent" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_active_session"("p_session_id" "text", "p_device_label" "text", "p_user_agent" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."set_security_question"("p_question" "text", "p_answer" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."set_security_question"("p_question" "text", "p_answer" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."set_security_question"("p_question" "text", "p_answer" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_security_question"("p_question" "text", "p_answer" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."touch_active_session"("p_session_id" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."touch_active_session"("p_session_id" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."touch_active_session"("p_session_id" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."touch_active_session"("p_session_id" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."validate_assignment_gate"("p_student_id" "uuid", "p_subject_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."validate_assignment_gate"("p_student_id" "uuid", "p_subject_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."validate_assignment_gate"("p_student_id" "uuid", "p_subject_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."validate_assignment_gate"("p_student_id" "uuid", "p_subject_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."validate_checkin_area"("p_campus_id" "uuid", "p_current_lat" numeric, "p_current_lng" numeric) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."validate_checkin_area"("p_campus_id" "uuid", "p_current_lat" numeric, "p_current_lng" numeric) TO "anon";
GRANT ALL ON FUNCTION "public"."validate_checkin_area"("p_campus_id" "uuid", "p_current_lat" numeric, "p_current_lng" numeric) TO "authenticated";
GRANT ALL ON FUNCTION "public"."validate_checkin_area"("p_campus_id" "uuid", "p_current_lat" numeric, "p_current_lng" numeric) TO "service_role";



REVOKE ALL ON FUNCTION "public"."validate_checkout_parity"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."validate_checkout_parity"() TO "anon";
GRANT ALL ON FUNCTION "public"."validate_checkout_parity"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."validate_checkout_parity"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."validate_location_coherence"("p_student_id" "uuid", "p_current_lat" numeric, "p_current_lng" numeric, "p_timestamp" timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."validate_location_coherence"("p_student_id" "uuid", "p_current_lat" numeric, "p_current_lng" numeric, "p_timestamp" timestamp with time zone) TO "anon";
GRANT ALL ON FUNCTION "public"."validate_location_coherence"("p_student_id" "uuid", "p_current_lat" numeric, "p_current_lng" numeric, "p_timestamp" timestamp with time zone) TO "authenticated";
GRANT ALL ON FUNCTION "public"."validate_location_coherence"("p_student_id" "uuid", "p_current_lat" numeric, "p_current_lng" numeric, "p_timestamp" timestamp with time zone) TO "service_role";



REVOKE ALL ON FUNCTION "public"."verify_security_answer"("p_email" "text", "p_answer" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."verify_security_answer"("p_email" "text", "p_answer" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."verify_security_answer"("p_email" "text", "p_answer" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."verify_security_answer"("p_email" "text", "p_answer" "text") TO "service_role";


GRANT ALL ON TABLE "public"."access_requests" TO "anon";
GRANT ALL ON TABLE "public"."access_requests" TO "authenticated";
GRANT ALL ON TABLE "public"."access_requests" TO "service_role";


GRANT ALL ON TABLE "public"."asignaciones_alumnos" TO "anon";
GRANT ALL ON TABLE "public"."asignaciones_alumnos" TO "authenticated";
GRANT ALL ON TABLE "public"."asignaciones_alumnos" TO "service_role";


GRANT ALL ON TABLE "public"."assignment_gate_overrides" TO "anon";
GRANT ALL ON TABLE "public"."assignment_gate_overrides" TO "authenticated";
GRANT ALL ON TABLE "public"."assignment_gate_overrides" TO "service_role";


GRANT ALL ON TABLE "public"."attendances" TO "anon";
GRANT ALL ON TABLE "public"."attendances" TO "authenticated";
GRANT ALL ON TABLE "public"."attendances" TO "service_role";


GRANT ALL ON TABLE "public"."audit_log" TO "anon";
GRANT ALL ON TABLE "public"."audit_log" TO "authenticated";
GRANT ALL ON TABLE "public"."audit_log" TO "service_role";


GRANT ALL ON SEQUENCE "public"."audit_log_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."audit_log_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."audit_log_id_seq" TO "service_role";


GRANT ALL ON TABLE "public"."campus_daily_qr" TO "anon";
GRANT ALL ON TABLE "public"."campus_daily_qr" TO "authenticated";
GRANT ALL ON TABLE "public"."campus_daily_qr" TO "service_role";


GRANT ALL ON TABLE "public"."campus_qr" TO "anon";
GRANT ALL ON TABLE "public"."campus_qr" TO "authenticated";
GRANT ALL ON TABLE "public"."campus_qr" TO "service_role";


GRANT ALL ON TABLE "public"."campuses" TO "anon";
GRANT ALL ON TABLE "public"."campuses" TO "authenticated";
GRANT ALL ON TABLE "public"."campuses" TO "service_role";


GRANT ALL ON TABLE "public"."careers" TO "anon";
GRANT ALL ON TABLE "public"."careers" TO "authenticated";
GRANT ALL ON TABLE "public"."careers" TO "service_role";


GRANT ALL ON TABLE "public"."estado_sede_periodo" TO "anon";
GRANT ALL ON TABLE "public"."estado_sede_periodo" TO "authenticated";
GRANT ALL ON TABLE "public"."estado_sede_periodo" TO "service_role";


GRANT ALL ON TABLE "public"."estado_usuario_periodo" TO "anon";
GRANT ALL ON TABLE "public"."estado_usuario_periodo" TO "authenticated";
GRANT ALL ON TABLE "public"."estado_usuario_periodo" TO "service_role";


GRANT ALL ON TABLE "public"."holidays" TO "anon";
GRANT ALL ON TABLE "public"."holidays" TO "authenticated";
GRANT ALL ON TABLE "public"."holidays" TO "service_role";


GRANT ALL ON TABLE "public"."justifications" TO "anon";
GRANT ALL ON TABLE "public"."justifications" TO "authenticated";
GRANT ALL ON TABLE "public"."justifications" TO "service_role";


GRANT ALL ON TABLE "public"."metas_horas_alumno" TO "anon";
GRANT ALL ON TABLE "public"."metas_horas_alumno" TO "authenticated";
GRANT ALL ON TABLE "public"."metas_horas_alumno" TO "service_role";


GRANT ALL ON TABLE "public"."notification_outbox" TO "anon";
GRANT ALL ON TABLE "public"."notification_outbox" TO "authenticated";
GRANT ALL ON TABLE "public"."notification_outbox" TO "service_role";


GRANT ALL ON SEQUENCE "public"."notification_outbox_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."notification_outbox_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."notification_outbox_id_seq" TO "service_role";


GRANT ALL ON TABLE "public"."periodos_academicos" TO "anon";
GRANT ALL ON TABLE "public"."periodos_academicos" TO "authenticated";
GRANT ALL ON TABLE "public"."periodos_academicos" TO "service_role";


GRANT ALL ON TABLE "public"."push_tokens" TO "anon";
GRANT ALL ON TABLE "public"."push_tokens" TO "authenticated";
GRANT ALL ON TABLE "public"."push_tokens" TO "service_role";


GRANT ALL ON TABLE "public"."rate_limits" TO "anon";
GRANT ALL ON TABLE "public"."rate_limits" TO "authenticated";
GRANT ALL ON TABLE "public"."rate_limits" TO "service_role";


GRANT ALL ON TABLE "public"."recovery_otps" TO "anon";
GRANT ALL ON TABLE "public"."recovery_otps" TO "authenticated";
GRANT ALL ON TABLE "public"."recovery_otps" TO "service_role";


GRANT ALL ON TABLE "public"."student_schedules" TO "anon";
GRANT ALL ON TABLE "public"."student_schedules" TO "authenticated";
GRANT ALL ON TABLE "public"."student_schedules" TO "service_role";


GRANT ALL ON TABLE "public"."subject_prerequisites" TO "anon";
GRANT ALL ON TABLE "public"."subject_prerequisites" TO "authenticated";
GRANT ALL ON TABLE "public"."subject_prerequisites" TO "service_role";


GRANT ALL ON TABLE "public"."subjects" TO "anon";
GRANT ALL ON TABLE "public"."subjects" TO "authenticated";
GRANT ALL ON TABLE "public"."subjects" TO "service_role";


GRANT ALL ON TABLE "public"."system_config" TO "anon";
GRANT ALL ON TABLE "public"."system_config" TO "authenticated";
GRANT ALL ON TABLE "public"."system_config" TO "service_role";


GRANT ALL ON TABLE "public"."teacher_groups" TO "anon";
GRANT ALL ON TABLE "public"."teacher_groups" TO "authenticated";
GRANT ALL ON TABLE "public"."teacher_groups" TO "service_role";


GRANT ALL ON TABLE "public"."user_sessions" TO "anon";
GRANT ALL ON TABLE "public"."user_sessions" TO "authenticated";
GRANT ALL ON TABLE "public"."user_sessions" TO "service_role";


GRANT ALL ON TABLE "public"."users" TO "anon";
GRANT ALL ON TABLE "public"."users" TO "authenticated";
GRANT ALL ON TABLE "public"."users" TO "service_role";


GRANT ALL ON TABLE "public"."v_cumplimiento_carrera_sede" TO "service_role";


GRANT ALL ON TABLE "public"."v_student_assignment" TO "anon";
GRANT ALL ON TABLE "public"."v_student_assignment" TO "authenticated";
GRANT ALL ON TABLE "public"."v_student_assignment" TO "service_role";


GRANT ALL ON TABLE "public"."weekly_evaluations" TO "anon";
GRANT ALL ON TABLE "public"."weekly_evaluations" TO "authenticated";
GRANT ALL ON TABLE "public"."weekly_evaluations" TO "service_role";



ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";


ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";


ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";

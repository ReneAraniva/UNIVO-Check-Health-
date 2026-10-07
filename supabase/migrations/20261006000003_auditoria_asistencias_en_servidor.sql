-- Auditoría 2026-10-06 · Asistencias: entrada y salida decididas por el servidor.
--
-- C-2 · El check-out del alumno hacía UPDATE directo sobre attendances con su JWT,
--       pero no existe (ni debe existir) política UPDATE para STUDENT: afectaba 0
--       filas, la entrada quedaba abierta y el siguiente check-in respondía "Ya
--       tienes una entrada activa". Además check_out y worked_hours salían del reloj
--       del navegador.
-- M-4 · El registro manual del encargado (/checkin) hacía INSERT directo sin
--       política INSERT para staff → roto. Pasa a una RPC con las mismas
--       validaciones que validate-qr-checkin.
-- A-4 · No había unicidad de "una entrada abierta por alumno": dos toques
--       simultáneos creaban dos asistencias abiertas.

-- ── A-4 · Una sola entrada abierta por alumno ──────────────────────────────────
-- Si ya hay duplicados, se conserva la entrada abierta más reciente y las demás
-- se cierran en su propio check_in (0 h) marcadas como OBSERVADO para revisión
-- humana. Se desactiva solo el trigger de paridad de salida (exige GPS) durante
-- esta limpieza puntual.
ALTER TABLE public.attendances DISABLE TRIGGER trg_validate_checkout_parity;

WITH ranked AS (
  SELECT id,
         row_number() OVER (PARTITION BY student_id ORDER BY check_in DESC) AS rn
  FROM public.attendances
  WHERE check_out IS NULL
)
UPDATE public.attendances a
   SET check_out = a.check_in,
       review_status = 'OBSERVADO',
       suspicious_reason = concat_ws(' ', a.suspicious_reason,
         'Cerrada automáticamente (auditoría 2026-10-06): había más de una entrada abierta del mismo alumno.')
  FROM ranked r
 WHERE r.id = a.id
   AND r.rn > 1;

ALTER TABLE public.attendances ENABLE TRIGGER trg_validate_checkout_parity;

CREATE UNIQUE INDEX IF NOT EXISTS uq_attendances_one_open_per_student
  ON public.attendances (student_id)
  WHERE check_out IS NULL;

-- ── Protección de columnas para la Data API ───────────────────────────────────
-- El coordinador conserva su UPDATE (revisión: review_status, notas…), pero ya no
-- puede reescribir los hechos del registro. Las RPC SECURITY DEFINER (current_user
-- = owner) y service_role quedan fuera de esta regla.
-- El nombre empieza con "trg_aa_" para correr ANTES que trg_validate_checkout_parity
-- (los BEFORE triggers se ejecutan en orden alfabético).
CREATE OR REPLACE FUNCTION public.fn_protect_attendance_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  IF auth.role() = 'service_role' OR current_user NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;

  IF NEW.student_id        IS DISTINCT FROM OLD.student_id
     OR NEW.campus_id      IS DISTINCT FROM OLD.campus_id
     OR NEW.check_in       IS DISTINCT FROM OLD.check_in
     OR NEW.date           IS DISTINCT FROM OLD.date
     OR NEW.check_in_location IS DISTINCT FROM OLD.check_in_location
     OR NEW.check_in_ip    IS DISTINCT FROM OLD.check_in_ip
     OR NEW.device_fingerprint IS DISTINCT FROM OLD.device_fingerprint
     OR NEW.created_at     IS DISTINCT FROM OLD.created_at
     OR (OLD.check_out IS NOT NULL AND NEW.check_out IS DISTINCT FROM OLD.check_out)
  THEN
    RAISE EXCEPTION 'No autorizado: los datos de la marca solo los registra el sistema.'
      USING ERRCODE = '42501';
  END IF;

  IF OLD.check_out IS NULL AND NEW.check_out IS NOT NULL THEN
    -- La salida siempre con la hora del servidor, y las horas calculadas aquí.
    NEW.check_out := now();
    NEW.worked_hours := round((extract(epoch FROM (NEW.check_out - NEW.check_in)) / 3600.0)::numeric, 2);
  ELSIF NEW.worked_hours IS DISTINCT FROM OLD.worked_hours THEN
    RAISE EXCEPTION 'No autorizado: las horas trabajadas las calcula el sistema.'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_protect_attendance_columns() FROM anon, authenticated, public;

DROP TRIGGER IF EXISTS trg_aa_protect_attendance_columns ON public.attendances;
CREATE TRIGGER trg_aa_protect_attendance_columns
  BEFORE UPDATE ON public.attendances
  FOR EACH ROW EXECUTE FUNCTION public.fn_protect_attendance_columns();

-- ── C-2 · Salida (alumno o staff) ─────────────────────────────────────────────
-- Devuelve jsonb {ok, message, attendance?} en vez de lanzar excepción, para que
-- el registro de auditoría de un intento rechazado no se pierda con el rollback.
-- La geocerca y la ventana horaria las sigue aplicando trg_validate_checkout_parity.
CREATE OR REPLACE FUNCTION public.register_check_out(
  p_attendance_id      uuid,
  p_lat                numeric,
  p_lng                numeric,
  p_accuracy           numeric DEFAULT NULL,
  p_device_id          text    DEFAULT NULL,
  p_device_fingerprint text    DEFAULT NULL,
  p_device_info        jsonb   DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid      uuid := auth.uid();
  v_role     text := upper(coalesce(public.get_current_user_role(), ''));
  v_is_staff boolean;
  v_att      public.attendances;
  v_fake     boolean := coalesce((p_device_info->>'isFakeGps')::boolean, false);
  v_reason   text;
  v_row      public.attendances;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'message', 'Sesion no encontrada. Vuelve a iniciar sesion.');
  END IF;
  v_is_staff := v_role IN ('ADMIN', 'COORDINATOR', 'COORDINADOR');

  IF p_lat IS NULL OR p_lng IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'message', 'Se requiere ubicacion GPS para registrar la salida.');
  END IF;

  SELECT * INTO v_att FROM public.attendances WHERE id = p_attendance_id FOR UPDATE;
  IF v_att.id IS NULL OR (v_att.student_id <> v_uid AND NOT v_is_staff) THEN
    RETURN jsonb_build_object('ok', false, 'message', 'No se encontró el registro activo.');
  END IF;
  IF v_att.check_out IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'message', 'La salida ya fue registrada para esta jornada.');
  END IF;

  IF v_att.student_id = v_uid THEN
    IF p_accuracy IS NULL OR p_accuracy > 100 THEN
      RETURN jsonb_build_object('ok', false, 'message', format(
        'Senal GPS imprecisa (+/-%s m). Sal al exterior o activa ubicacion de alta precision e intentalo de nuevo.',
        coalesce(round(p_accuracy)::text, '?')));
    END IF;

    IF v_att.device_fingerprint IS NOT NULL AND p_device_fingerprint IS NOT NULL
       AND v_att.device_fingerprint <> p_device_fingerprint THEN
      INSERT INTO public.audit_log (action, actor_user_id, target_user_id, details)
      VALUES ('CHECKOUT_DEVICE_FINGERPRINT_MISMATCH', v_uid, v_att.student_id, jsonb_build_object(
        'attendance_id', v_att.id,
        'campus_id', v_att.campus_id,
        'check_in_device_fingerprint', v_att.device_fingerprint,
        'check_out_device_fingerprint', p_device_fingerprint));
      RETURN jsonb_build_object('ok', false, 'message',
        'La salida debe registrarse desde el mismo dispositivo usado para la entrada.');
    END IF;
  END IF;

  IF v_fake THEN
    v_reason := format('Posible GPS falso detectado en la salida (%s%%).',
      round(coalesce((p_device_info->>'fakeGpsConfidence')::numeric, 0) * 100));
  END IF;

  BEGIN
    UPDATE public.attendances
       SET check_out = now(),
           check_out_location = jsonb_build_object('latitude', p_lat, 'longitude', p_lng, 'accuracyMeters', p_accuracy),
           worked_hours = round((extract(epoch FROM (now() - check_in)) / 3600.0)::numeric, 2),
           device_id = coalesce(p_device_id, device_id),
           check_out_device_fingerprint = coalesce(p_device_fingerprint, device_fingerprint),
           device_info = coalesce(p_device_info, device_info),
           review_status = CASE WHEN v_fake THEN 'OBSERVADO' ELSE review_status END,
           suspicious_reason = CASE WHEN v_fake THEN concat_ws(' ', suspicious_reason, v_reason) ELSE suspicious_reason END
     WHERE id = v_att.id
     RETURNING * INTO v_row;
  EXCEPTION WHEN raise_exception OR check_violation THEN
    -- Mensajes de trg_validate_checkout_parity (geocerca / horario / asignación).
    RETURN jsonb_build_object('ok', false, 'message', SQLERRM);
  END;

  IF v_att.student_id <> v_uid THEN
    INSERT INTO public.audit_log (action, actor_user_id, target_user_id, details)
    VALUES ('STAFF_CHECK_OUT', v_uid, v_att.student_id,
            jsonb_build_object('attendance_id', v_att.id, 'campus_id', v_att.campus_id, 'actor_role', v_role));
  END IF;

  RETURN jsonb_build_object('ok', true, 'message', 'Salida registrada con hora oficial del servidor.',
                            'attendance', to_jsonb(v_row));
END;
$$;

REVOKE EXECUTE ON FUNCTION public.register_check_out(uuid, numeric, numeric, numeric, text, text, jsonb) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.register_check_out(uuid, numeric, numeric, numeric, text, text, jsonb) TO authenticated;

-- ── M-4 · Entrada registrada por el encargado / decano ────────────────────────
-- Paridad con validate-qr-checkin: geocerca, asignación vigente del alumno en esa
-- sede, una sola entrada abierta, conflicto de dispositivo y señal de GPS falso.
-- Un COORDINATOR solo registra en asignaciones donde figura como coordinador.
CREATE OR REPLACE FUNCTION public.staff_register_check_in(
  p_student_id         uuid,
  p_campus_id          uuid,
  p_lat                numeric,
  p_lng                numeric,
  p_notes              text  DEFAULT NULL,
  p_device_id          text  DEFAULT NULL,
  p_device_fingerprint text  DEFAULT NULL,
  p_device_info        jsonb DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid        uuid := auth.uid();
  v_role       text := upper(coalesce(public.get_current_user_role(), ''));
  v_today      date := (now() AT TIME ZONE 'America/El_Salvador')::date;
  v_student    public.users;
  v_area       record;
  v_assignment public.teacher_groups;
  v_conflict   record;
  v_coherence  record;
  v_fake       boolean := coalesce((p_device_info->>'isFakeGps')::boolean, false);
  v_reason     text;
  v_row        public.attendances;
BEGIN
  IF v_role NOT IN ('ADMIN', 'COORDINATOR', 'COORDINADOR') THEN
    RETURN jsonb_build_object('ok', false, 'message', 'No tienes permiso para registrar asistencias.');
  END IF;
  IF p_lat IS NULL OR p_lng IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'message', 'Se requiere ubicacion GPS.');
  END IF;

  SELECT * INTO v_student FROM public.users WHERE id = p_student_id;
  IF v_student.id IS NULL OR upper(v_student.role) <> 'STUDENT' OR NOT v_student.is_active THEN
    RETURN jsonb_build_object('ok', false, 'message', 'Estudiante no encontrado o inactivo.');
  END IF;

  SELECT * INTO v_area FROM public.validate_checkin_area(p_campus_id, p_lat, p_lng) LIMIT 1;
  IF coalesce(v_area.is_allowed, false) IS NOT TRUE THEN
    RETURN jsonb_build_object('ok', false, 'message', coalesce(v_area.message, 'Ubicación fuera del área permitida.'));
  END IF;

  SELECT * INTO v_assignment
  FROM public.teacher_groups
  WHERE student_id = p_student_id
    AND campus_id = p_campus_id
    AND (start_date IS NULL OR start_date <= v_today)
    AND (end_date IS NULL OR end_date >= v_today)
    AND (v_role = 'ADMIN' OR coordinator_id = v_uid)
  ORDER BY start_date DESC NULLS LAST
  LIMIT 1;
  IF v_assignment.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'message',
      'El estudiante no tiene una asignación vigente en esta sede a tu cargo.');
  END IF;

  IF EXISTS (SELECT 1 FROM public.attendances WHERE student_id = p_student_id AND check_out IS NULL) THEN
    RETURN jsonb_build_object('ok', false, 'message', 'Este estudiante ya tiene una entrada activa.');
  END IF;

  IF p_device_fingerprint IS NOT NULL THEN
    SELECT * INTO v_conflict
    FROM public.detect_device_fingerprint_conflict(p_device_fingerprint, p_campus_id, p_student_id)
    LIMIT 1;
    IF v_conflict.attendance_id IS NOT NULL THEN
      INSERT INTO public.audit_log (action, actor_user_id, target_user_id, details)
      VALUES ('SHARED_DEVICE_ACTIVE_CONFLICT', v_uid, v_conflict.student_id, jsonb_build_object(
        'attempted_campus_id', p_campus_id,
        'active_campus_id', v_conflict.campus_id,
        'active_attendance_id', v_conflict.attendance_id,
        'device_fingerprint', p_device_fingerprint));
      RETURN jsonb_build_object('ok', false, 'message',
        'Dispositivo ya activo en otra sede. El intento fue enviado a auditoria.');
    END IF;
  END IF;

  IF v_fake THEN
    v_reason := format('Posible GPS falso detectado (%s%%).',
      round(coalesce((p_device_info->>'fakeGpsConfidence')::numeric, 0) * 100));
  ELSE
    SELECT * INTO v_coherence FROM public.validate_location_coherence(p_student_id, p_lat, p_lng) LIMIT 1;
    IF coalesce(v_coherence.is_suspicious, false) THEN
      v_reason := 'Desplazamiento inusual detectado entre registros consecutivos.';
    END IF;
  END IF;

  BEGIN
    INSERT INTO public.attendances (
      student_id, campus_id, assignment_id, subject_id, notes,
      check_in_location, device_id, device_fingerprint, device_info,
      review_status, suspicious_reason, status
    ) VALUES (
      p_student_id, p_campus_id, v_assignment.id, v_assignment.subject_id, p_notes,
      jsonb_build_object('latitude', p_lat, 'longitude', p_lng),
      p_device_id, p_device_fingerprint, p_device_info,
      CASE WHEN v_reason IS NULL THEN 'PENDIENTE' ELSE 'OBSERVADO' END, v_reason, 'present'
    )
    RETURNING * INTO v_row;
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('ok', false, 'message', 'Este estudiante ya tiene una entrada activa.');
  END;

  INSERT INTO public.audit_log (action, actor_user_id, target_user_id, details)
  VALUES ('STAFF_CHECK_IN', v_uid, p_student_id,
          jsonb_build_object('attendance_id', v_row.id, 'campus_id', p_campus_id, 'actor_role', v_role));

  IF v_fake THEN
    INSERT INTO public.audit_log (action, actor_user_id, target_user_id, details)
    VALUES ('FAKE_GPS_DETECTED', v_uid, p_student_id, jsonb_build_object(
      'attendance_id', v_row.id, 'campus_id', p_campus_id,
      'confidence', p_device_info->'fakeGpsConfidence'));
  END IF;

  RETURN jsonb_build_object('ok', true, 'message', 'Entrada registrada con hora oficial del servidor.',
                            'attendance', to_jsonb(v_row));
END;
$$;

REVOKE EXECUTE ON FUNCTION public.staff_register_check_in(uuid, uuid, numeric, numeric, text, text, text, jsonb) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.staff_register_check_in(uuid, uuid, numeric, numeric, text, text, text, jsonb) TO authenticated;

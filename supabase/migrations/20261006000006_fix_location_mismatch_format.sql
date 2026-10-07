-- Auditoría 2026-10-06 — bug encontrado al probar el check-out en servidor.
-- fn_check_location_mismatch (20260521000002) usaba format('%.0f'), que Postgres NO
-- soporta (format() solo conoce %s, %I y %L). Cada salida a más de 150 m del
-- punto de entrada —justo el caso que debía quedar marcado como discrepancia—
-- abortaba el UPDATE con "unrecognized format() type specifier" en vez de
-- registrarse como OBSERVADO.
CREATE OR REPLACE FUNCTION public.fn_check_location_mismatch()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_lat_in   numeric; v_lng_in  numeric;
  v_lat_out  numeric; v_lng_out numeric;
  v_dist     numeric; v_threshold numeric := 150;
BEGIN
  IF NEW.check_out_location IS NULL OR NEW.check_in_location IS NULL THEN RETURN NEW; END IF;
  SELECT COALESCE(value::numeric, 150) INTO v_threshold FROM public.system_config WHERE key = 'location_mismatch_threshold_m';
  v_threshold := COALESCE(v_threshold, 150);
  v_lat_in  := (NEW.check_in_location->>'latitude')::numeric;
  v_lng_in  := (NEW.check_in_location->>'longitude')::numeric;
  v_lat_out := (NEW.check_out_location->>'latitude')::numeric;
  v_lng_out := (NEW.check_out_location->>'longitude')::numeric;
  v_dist := public.haversine_meters(v_lat_in, v_lng_in, v_lat_out, v_lng_out);
  IF v_dist > v_threshold THEN
    NEW.location_mismatch := true;
    NEW.review_status := 'OBSERVADO';
    NEW.suspicious_reason := format('%sDiscrepancia %s m (umbral %s m).',
      COALESCE(NEW.suspicious_reason || ' ', ''), round(v_dist), round(v_threshold));
  END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_check_location_mismatch() FROM anon, authenticated, public;

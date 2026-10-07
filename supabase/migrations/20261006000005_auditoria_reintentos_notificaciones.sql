-- Auditoría 2026-10-06 · A-2 — Los reintentos de notificaciones nunca reintentaban:
--   · El cron reenviaba ítems 'pending' y 'failed', pero notify-dispatcher solo
--     reclamaba status = 'pending' → los 'failed' respondían "skipped" para siempre
--     (20260626000005_retry_cron_handles_failed nunca funcionó).
--   · Un usuario sin token push dejaba su ítem en 'failed' → reintento infinito.
--   · ORDER BY created_at LIMIT 100: con ≥100 'failed' viejos, los 'pending'
--     nuevos ya no se reintentaban, y se gastaban hasta 400 invocaciones/hora.
--
-- Ahora: contador de intentos con tope, estado terminal 'skipped' para lo que no
-- tiene sentido reintentar, y reclamo atómico vía claim_outbox_item().

ALTER TABLE public.notification_outbox
  ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_attempt_at timestamptz;

ALTER TABLE public.notification_outbox DROP CONSTRAINT IF EXISTS notification_outbox_status_check;
ALTER TABLE public.notification_outbox ADD CONSTRAINT notification_outbox_status_check
  CHECK (status IN ('pending', 'sent', 'failed', 'skipped'));

-- Los push 'failed' por falta de token nunca iban a salir: se cierran.
UPDATE public.notification_outbox o
   SET status = 'skipped'
 WHERE o.status = 'failed'
   AND o.channel = 'push'
   AND NOT EXISTS (SELECT 1 FROM public.push_tokens t WHERE t.user_id = o.target_user_id);

CREATE INDEX IF NOT EXISTS idx_notification_outbox_retry
  ON public.notification_outbox (status, created_at)
  WHERE status IN ('pending', 'failed');

-- Reclamo atómico: marca 'sent' e incrementa el intento en un solo UPDATE, así dos
-- invocaciones concurrentes del dispatcher no envían el mismo ítem dos veces.
CREATE OR REPLACE FUNCTION public.claim_outbox_item(p_id bigint, p_max_attempts integer DEFAULT 5)
RETURNS SETOF public.notification_outbox
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.notification_outbox
     SET status = 'sent',
         sent_at = now(),
         attempts = attempts + 1,
         last_attempt_at = now()
   WHERE id = p_id
     AND status IN ('pending', 'failed')
     AND attempts < p_max_attempts
  RETURNING *;
$$;

REVOKE EXECUTE ON FUNCTION public.claim_outbox_item(bigint, integer) FROM anon, authenticated, public;
GRANT EXECUTE ON FUNCTION public.claim_outbox_item(bigint, integer) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_retry_pending_outbox()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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

  -- 'pending' primero (nunca procesados), luego 'failed' con intentos restantes y
  -- backoff lineal (5 min × intento). Lo que agotó los 5 intentos queda en 'failed'
  -- como registro, fuera del ciclo.
  FOR r IN
    SELECT id FROM public.notification_outbox
    WHERE created_at < now() - interval '5 minutes'
      AND attempts < 5
      AND (
        status = 'pending'
        OR (status = 'failed'
            AND coalesce(last_attempt_at, created_at) < now() - make_interval(mins => 5 * greatest(attempts, 1)))
      )
    ORDER BY (status = 'pending') DESC, created_at
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

REVOKE EXECUTE ON FUNCTION public.fn_retry_pending_outbox() FROM anon, authenticated, public;

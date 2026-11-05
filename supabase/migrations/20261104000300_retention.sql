-- Retention, called daily by the Vercel cron (/api/cron/cleanup) through the service role. Returns how many rows
-- each step touched.
--   webhook_events  after 90 days (idempotency only needs the redelivery window)
--   notifications   read ones after 180 days
--   rate_limits     windows expired for more than a day
--   audit_logs.ip   erased after 180 days (access logs are kept 6 months, Marco Civil art. 15; stated in /privacidade)
--   jobs            done after 7 days, dead after 30 (payloads may hold e-mail addresses)
--   invitations     expired ones right away, accepted ones after 30 days (they hold e-mail addresses of people who
--                   may never sign up; the membership and the audit log remain)
create function public.cleanup_old_records() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_events integer;
  v_notifications integer;
  v_limits integer;
  v_ips integer;
  v_jobs integer;
  v_invitations integer;
begin
  delete from public.webhook_events where created_at < now() - interval '90 days';
  get diagnostics v_events = row_count;
  delete from public.notifications where read_at is not null and created_at < now() - interval '180 days';
  get diagnostics v_notifications = row_count;
  delete from public.rate_limits where reset_at < now() - interval '1 day';
  get diagnostics v_limits = row_count;
  update public.audit_logs set ip = null where ip is not null and created_at < now() - interval '180 days';
  get diagnostics v_ips = row_count;
  delete from public.jobs
  where (status = 'done' and updated_at < now() - interval '7 days')
     or (status = 'dead' and updated_at < now() - interval '30 days');
  get diagnostics v_jobs = row_count;
  delete from public.invitations
  where (accepted_at is null and expires_at < now())
     or (accepted_at is not null and accepted_at < now() - interval '30 days');
  get diagnostics v_invitations = row_count;
  return jsonb_build_object(
    'webhook_events', v_events, 'notifications', v_notifications, 'rate_limits', v_limits, 'audit_ips', v_ips,
    'jobs', v_jobs, 'invitations', v_invitations
  );
end;
$$;
revoke execute on function public.cleanup_old_records() from public, anon, authenticated;
grant execute on function public.cleanup_old_records() to service_role;

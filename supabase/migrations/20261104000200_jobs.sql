-- Durable background jobs in Postgres (no Redis/queue service). enqueue() inserts a row and kicks processing
-- with after(); /api/cron/jobs retries what is left. Failed jobs back off exponentially and end as "dead" after
-- max_attempts (visible in /admin). Server-only: RLS on, no policies, service_role grants only.

create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  type text not null check (char_length(type) between 1 and 100),
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending', 'running', 'done', 'dead')),
  attempts integer not null default 0,
  max_attempts integer not null default 5 check (max_attempts between 1 and 50),
  run_at timestamptz not null default now(),
  locked_at timestamptz,
  last_error text check (char_length(last_error) <= 2000),
  -- Optional dedupe: enqueueing the same key again is a no-op while the job row exists.
  idempotency_key text unique check (char_length(idempotency_key) <= 200),
  -- Whose personal data is in the payload (e.g. an e-mail address): erased with the account (LGPD).
  user_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index jobs_ready_idx on public.jobs (run_at) where status = 'pending';
create index jobs_running_idx on public.jobs (locked_at) where status = 'running';
create index jobs_dead_idx on public.jobs (updated_at desc) where status = 'dead';
create index jobs_user_id_idx on public.jobs (user_id) where user_id is not null;
alter table public.jobs enable row level security;
create trigger jobs_updated_at before update on public.jobs
  for each row execute function public.set_updated_at();
revoke all on public.jobs from anon, authenticated;
grant all on public.jobs to service_role;

-- Takes up to p_limit due jobs (pending and run_at reached, or running with an expired lock = a worker that
-- died). `for update skip locked`: concurrent workers (after() + cron) never take the same job.
-- Jobs whose lock expired after their last attempt go straight to "dead".
create function public.claim_jobs(p_limit integer default 10, p_lock_seconds integer default 300)
returns setof public.jobs
language plpgsql security definer set search_path = '' as $$
begin
  update public.jobs
  set status = 'dead', locked_at = null, last_error = coalesce(last_error, 'worker timed out')
  where status = 'running' and locked_at < now() - make_interval(secs => p_lock_seconds) and attempts >= max_attempts;

  return query
  update public.jobs j
  set status = 'running', locked_at = now(), attempts = j.attempts + 1
  where j.id in (
    select c.id from public.jobs c
    where (c.status = 'pending' and c.run_at <= now())
       or (c.status = 'running' and c.locked_at < now() - make_interval(secs => p_lock_seconds))
    order by c.run_at
    limit greatest(1, least(p_limit, 100))
    for update skip locked
  )
  returning j.*;
end;
$$;

create function public.complete_job(p_id uuid) returns void
language sql security definer set search_path = '' as $$
  update public.jobs set status = 'done', locked_at = null, last_error = null
  where id = p_id and status = 'running';
$$;

-- Failure: back to pending after p_retry_in_seconds (computed by the worker: exponential backoff), or "dead"
-- once attempts reached max_attempts. Returns the new status.
create function public.fail_job(p_id uuid, p_error text, p_retry_in_seconds integer) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_status text;
begin
  update public.jobs
  set status = case when attempts >= max_attempts then 'dead' else 'pending' end,
      run_at = now() + make_interval(secs => greatest(p_retry_in_seconds, 1)),
      locked_at = null,
      last_error = left(coalesce(p_error, 'unknown error'), 2000)
  where id = p_id and status = 'running'
  returning status into v_status;
  return v_status;
end;
$$;

-- Admin "try again" for a dead job: one more attempt, now.
create function public.retry_job(p_id uuid) returns void
language sql security definer set search_path = '' as $$
  update public.jobs
  set status = 'pending', run_at = now(), max_attempts = greatest(max_attempts, attempts + 1), locked_at = null
  where id = p_id and status = 'dead';
$$;

revoke execute on function public.claim_jobs(integer, integer) from public, anon, authenticated;
revoke execute on function public.complete_job(uuid) from public, anon, authenticated;
revoke execute on function public.fail_job(uuid, text, integer) from public, anon, authenticated;
revoke execute on function public.retry_job(uuid) from public, anon, authenticated;
grant execute on function public.claim_jobs(integer, integer) to service_role;
grant execute on function public.complete_job(uuid) to service_role;
grant execute on function public.fail_job(uuid, text, integer) to service_role;
grant execute on function public.retry_job(uuid) to service_role;

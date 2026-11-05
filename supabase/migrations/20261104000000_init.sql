-- Base schema: profiles, organizations (multi-tenant), notifications, billing, audit, webhooks, rate limits,
-- feature flags and two-step verification. Every table has RLS enabled; tables without policies are server-only
-- (service role). Privileges are granted explicitly: new Supabase projects do not expose public tables to the API
-- roles by default, so every table needs its own grants (and RLS still decides which rows each user sees).
--
-- Helpers in policies are always called through a scalar subquery, `using ((select public.is_admin()))`, so
-- Postgres evaluates them once per statement (initPlan) instead of once per row.

create function public.set_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Profiles: 1:1 with auth.users ------------------------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  full_name text check (char_length(full_name) <= 120),
  role text not null default 'member' check (role in ('admin', 'member')),
  -- Stamped when the user becomes a platform admin: only MFA factors created before it are trusted for /admin.
  admin_since timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.profiles enable row level security;
create trigger profiles_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();

create policy "profiles: read own" on public.profiles
  for select to authenticated using ((select auth.uid()) = id);
create policy "profiles: update own" on public.profiles
  for update to authenticated using ((select auth.uid()) = id) with check ((select auth.uid()) = id);
-- Users read their row and may only change their name; role and admin_since are server-only.
revoke all on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;
grant update (full_name) on public.profiles to authenticated;
grant all on public.profiles to service_role;

create function public.handle_user_email_change() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.profiles set email = new.email where id = new.id;
  return new;
end;
$$;
create trigger on_auth_user_email_changed after update of email on auth.users
  for each row execute function public.handle_user_email_change();

-- Platform admin check for policies: `using ((select public.is_admin()))`.
create function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles where id = (select auth.uid()) and role = 'admin');
$$;
revoke execute on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated, service_role;
comment on function public.is_admin() is
  'True when the signed-in user has profiles.role = admin. In policies use (select public.is_admin()), never bare.';

-- Organizations ----------------------------------------------------------------------------------------------------
-- Business data belongs to an organization: new tables get `org_id` and policies through the helpers below (see
-- CLAUDE.md). Every user has a personal organization (individual account and billing), created at sign-up.
create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 120),
  -- Set only on the personal organization of a user; deleted with the user.
  personal_owner_id uuid unique references public.profiles (id) on delete cascade,
  stripe_customer_id text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.organizations enable row level security;
create trigger organizations_updated_at before update on public.organizations
  for each row execute function public.set_updated_at();

create table public.memberships (
  org_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'admin', 'member')),
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);
create index memberships_user_id_idx on public.memberships (user_id, org_id);
alter table public.memberships enable row level security;

-- Invitations: the e-mail gets a random token; only its SHA-256 is stored (a leaked table cannot accept them).
create table public.invitations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  email text not null check (email = lower(email) and char_length(email) <= 254),
  role text not null default 'member' check (role in ('admin', 'member')),
  token_hash text not null unique,
  invited_by uuid references public.profiles (id) on delete set null,
  expires_at timestamptz not null default now() + interval '7 days',
  accepted_at timestamptz,
  created_at timestamptz not null default now()
);
create index invitations_org_id_idx on public.invitations (org_id, created_at desc);
alter table public.invitations enable row level security;

-- Helpers (security definer: they read memberships without recursing into its own policies)
create function public.org_role_rank(role text) returns integer
language sql immutable set search_path = '' as $$
  select case role when 'owner' then 3 when 'admin' then 2 when 'member' then 1 else 0 end;
$$;

-- Organizations where the signed-in user has at least `min_role`. In policies:
--   using (org_id in (select public.my_org_ids()))            -- any member
--   using (org_id in (select public.my_org_ids('admin')))     -- admins and owners
-- The set is computed once per statement (the row's org_id is only compared against it): this is the fast form
-- for row-dependent checks. `(select public.is_org_member(org_id))` would still run once per row.
create function public.my_org_ids(min_role text default 'member') returns setof uuid
language sql stable security definer set search_path = '' as $$
  select m.org_id from public.memberships m
  where m.user_id = (select auth.uid()) and public.org_role_rank(m.role) >= public.org_role_rank(min_role);
$$;

-- Single checks (server code, RPC, policies on a fixed org): `(select public.is_org_member(<org>))`.
create function public.is_org_member(org uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.memberships m where m.org_id = is_org_member.org and m.user_id = (select auth.uid())
  );
$$;

-- True when the signed-in user has at least `role` (owner > admin > member) in `org`. The parameter is qualified
-- (has_org_role.role): a bare `role` would resolve to the memberships.role column and always be true.
create function public.has_org_role(org uuid, role text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.memberships m
    where m.org_id = has_org_role.org and m.user_id = (select auth.uid())
      and public.org_role_rank(m.role) >= public.org_role_rank(has_org_role.role)
  );
$$;

revoke execute on function public.org_role_rank(text) from public, anon;
revoke execute on function public.my_org_ids(text) from public, anon;
revoke execute on function public.is_org_member(uuid) from public, anon;
revoke execute on function public.has_org_role(uuid, text) from public, anon;
grant execute on function public.org_role_rank(text) to authenticated, service_role;
grant execute on function public.my_org_ids(text) to authenticated, service_role;
grant execute on function public.is_org_member(uuid) to authenticated, service_role;
grant execute on function public.has_org_role(uuid, text) to authenticated, service_role;

create policy "organizations: members read" on public.organizations
  for select to authenticated using (id in (select public.my_org_ids()));
create policy "organizations: admins rename" on public.organizations
  for update to authenticated
  using (id in (select public.my_org_ids('admin')))
  with check (id in (select public.my_org_ids('admin')));
revoke all on public.organizations from anon, authenticated;
grant select on public.organizations to authenticated;
grant update (name) on public.organizations to authenticated;
grant all on public.organizations to service_role;

-- Members see who else is in their organizations. Adding/removing members is server-only (invitations, actions).
create policy "memberships: members read" on public.memberships
  for select to authenticated using (org_id in (select public.my_org_ids()));
revoke all on public.memberships from anon, authenticated;
grant select on public.memberships to authenticated;
grant all on public.memberships to service_role;

create policy "invitations: org admins read" on public.invitations
  for select to authenticated using (org_id in (select public.my_org_ids('admin')));
revoke all on public.invitations from anon, authenticated;
grant select (id, org_id, email, role, invited_by, expires_at, accepted_at, created_at) on public.invitations to authenticated;
grant all on public.invitations to service_role;

-- Sign-up: profile + personal organization + owner membership, in the same transaction as the auth.users insert.
-- The name comes from user-controlled metadata, so it is trimmed to the column limit instead of failing the sign-up.
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_name text := nullif(
    left(btrim(coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name', '')), 120), ''
  );
  v_org uuid;
begin
  insert into public.profiles (id, email, full_name) values (new.id, new.email, v_name);
  insert into public.organizations (name, personal_owner_id) values (coalesce(v_name, 'Minha conta'), new.id)
  returning id into v_org;
  insert into public.memberships (org_id, user_id, role) values (v_org, new.id, 'owner');
  return new;
end;
$$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Two-step verification (TOTP) -------------------------------------------------------------------------------------
-- A user with a verified factor who signed in with the password only (aal1) must not reach data through the API
-- either: the restrictive "mfa: aal2 when enrolled" policies require aal2 for them. Users without a factor are
-- unaffected.
create function public.has_verified_mfa() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from auth.mfa_factors f where f.user_id = (select auth.uid()) and f.status = 'verified'
  );
$$;

create function public.mfa_satisfied() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select auth.jwt() ->> 'aal'), 'aal1') = 'aal2' or not public.has_verified_mfa();
$$;

-- Service role only: promoting someone to admin requires their factor to exist already.
create function public.user_has_verified_mfa(p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from auth.mfa_factors f where f.user_id = p_user and f.status = 'verified');
$$;

revoke execute on function public.has_verified_mfa() from public, anon;
revoke execute on function public.mfa_satisfied() from public, anon;
revoke execute on function public.user_has_verified_mfa(uuid) from public, anon, authenticated;
grant execute on function public.has_verified_mfa() to authenticated, service_role;
grant execute on function public.mfa_satisfied() to authenticated, service_role;
grant execute on function public.user_has_verified_mfa(uuid) to service_role;

-- Admin takeover by enrolment: whoever has an admin's password could enrol THEIR authenticator (the Auth API lets
-- any session enrol a first factor) and reach aal2. So an admin is trusted only with factors that already existed
-- when the role was granted: profiles.admin_since is stamped on promotion and a factor created later (by anyone)
-- blocks /admin until the operator re-approves (demote + promote). See README > Primeiro administrador.
create function public.profiles_admin_since() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.role = 'admin' and old.role is distinct from 'admin' then
    new.admin_since := now();
  elsif new.role <> 'admin' then
    new.admin_since := null;
  end if;
  return new;
end;
$$;
create trigger profiles_admin_since before update of role on public.profiles
  for each row execute function public.profiles_admin_since();

create function public.admin_mfa_trusted() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid()) and p.role = 'admin' and p.admin_since is not null
      and exists (
        select 1 from auth.mfa_factors f
        where f.user_id = p.id and f.status = 'verified' and f.created_at <= p.admin_since
      )
      and not exists (
        select 1 from auth.mfa_factors f
        where f.user_id = p.id and f.status = 'verified' and f.created_at > p.admin_since
      )
  );
$$;
revoke execute on function public.profiles_admin_since() from public, anon, authenticated;
revoke execute on function public.admin_mfa_trusted() from public, anon;
grant execute on function public.admin_mfa_trusted() to authenticated, service_role;

-- Notifications (bell + realtime) ----------------------------------------------------------------------------------
create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  type text not null default 'info' check (type in ('info', 'success', 'warning', 'error')),
  title text not null check (char_length(title) <= 200),
  body text check (char_length(body) <= 2000),
  link text check (link is null or (link like '/%' and link not like '//%' and position(chr(92) in link) = 0)),
  read_at timestamptz,
  -- Retried webhooks/jobs pass the same key, so a redelivery never duplicates the bell or the e-mail.
  idempotency_key text unique check (char_length(idempotency_key) <= 200),
  created_at timestamptz not null default now()
);
create index notifications_user_id_idx on public.notifications (user_id, created_at desc, id desc);
create index notifications_unread_idx on public.notifications (user_id) where read_at is null;
alter table public.notifications enable row level security;
create policy "notifications: read own" on public.notifications
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "notifications: mark own as read" on public.notifications
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
revoke all on public.notifications from anon, authenticated;
grant select on public.notifications to authenticated;
grant update (read_at) on public.notifications to authenticated;
grant all on public.notifications to service_role;

-- Welcome notification for every new account (shows the bell working from day one).
create function public.handle_new_profile() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.notifications (user_id, type, title, body, link)
  values (new.id, 'success', 'Bem-vindo(a)!', 'Sua conta foi criada. Explore o painel.', '/painel');
  return new;
end;
$$;
create trigger on_profile_created after insert on public.profiles
  for each row execute function public.handle_new_profile();

-- Realtime: Broadcast from the database instead of postgres_changes (which checks RLS for every subscriber on
-- every change and does not scale). One message goes to a private topic per user and Realtime authorizes the
-- subscription once, when joining, through the RLS policy on realtime.messages below. The notifications table is
-- deliberately NOT in the supabase_realtime publication.
create function public.broadcast_notification() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform realtime.send(
    jsonb_build_object(
      'id', new.id, 'type', new.type, 'title', new.title, 'body', new.body, 'link', new.link,
      'created_at', new.created_at
    ),
    'notification_created',
    'user:' || new.user_id::text || ':notifications',
    true
  );
  return null;
end;
$$;
revoke execute on function public.broadcast_notification() from public, anon, authenticated;

create trigger notifications_broadcast after insert on public.notifications
  for each row execute function public.broadcast_notification();

-- Only the owner may join `user:<own id>:notifications` (private channel, broadcast only).
create policy "notifications: receive own broadcasts" on realtime.messages
  for select to authenticated
  using (
    (select realtime.topic()) = 'user:' || (select auth.uid())::text || ':notifications'
    and realtime.messages.extension = 'broadcast'
  );

-- Subscriptions (Stripe, written by the webhook), per organization -------------------------------------------------
create table public.subscriptions (
  id text primary key,
  org_id uuid not null references public.organizations (id) on delete cascade,
  status text not null,
  price_id text,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index subscriptions_org_id_idx on public.subscriptions (org_id);
alter table public.subscriptions enable row level security;
create trigger subscriptions_updated_at before update on public.subscriptions
  for each row execute function public.set_updated_at();
create policy "subscriptions: org members read" on public.subscriptions
  for select to authenticated using (org_id in (select public.my_org_ids()));
revoke all on public.subscriptions from anon, authenticated;
grant select on public.subscriptions to authenticated;
grant all on public.subscriptions to service_role;

-- Access check for paid features (server code or policies on tenant tables). Only answers for members.
create function public.has_active_subscription(org uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.is_org_member(org) and exists (
    select 1 from public.subscriptions s
    where s.org_id = org and s.status in ('active', 'trialing')
      and (s.current_period_end is null or s.current_period_end > now())
  );
$$;
revoke execute on function public.has_active_subscription(uuid) from public, anon;
grant execute on function public.has_active_subscription(uuid) to authenticated, service_role;

-- Audit logs (server-only) -----------------------------------------------------------------------------------------
create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid,
  action text not null,
  entity text not null,
  entity_id text,
  metadata jsonb,
  ip text,
  created_at timestamptz not null default now()
);
create index audit_logs_actor_id_idx on public.audit_logs (actor_id, created_at);
create index audit_logs_entity_idx on public.audit_logs (entity, entity_id);
create index audit_logs_created_at_idx on public.audit_logs (created_at);
alter table public.audit_logs enable row level security;
revoke all on public.audit_logs from anon, authenticated;
grant all on public.audit_logs to service_role;

-- Webhook idempotency (server-only) --------------------------------------------------------------------------------
create table public.webhook_events (
  source text not null,
  id text not null,
  type text not null,
  created_at timestamptz not null default now(),
  -- Null while a delivery is being handled; a stale null claim (crash/timeout) is retried by processOnce().
  processed_at timestamptz,
  primary key (source, id)
);
create index webhook_events_created_at_idx on public.webhook_events (created_at);
alter table public.webhook_events enable row level security;
revoke all on public.webhook_events from anon, authenticated;
grant all on public.webhook_events to service_role;

-- Rate limiting in Postgres (no Redis): fixed window per key -------------------------------------------------------
create table public.rate_limits (
  key text primary key,
  count integer not null,
  reset_at timestamptz not null
);
alter table public.rate_limits enable row level security;
revoke all on public.rate_limits from anon, authenticated;
grant all on public.rate_limits to service_role;

create function public.rate_limit(p_key text, p_limit integer, p_window_seconds integer)
returns table (allowed boolean, remaining integer, reset_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare
  v_count integer;
  v_reset timestamptz;
begin
  insert into public.rate_limits as r (key, count, reset_at)
  values (p_key, 1, now() + make_interval(secs => p_window_seconds))
  on conflict (key) do update set
    count = case when r.reset_at <= now() then 1 else r.count + 1 end,
    reset_at = case when r.reset_at <= now() then now() + make_interval(secs => p_window_seconds) else r.reset_at end
  returning r.count, r.reset_at into v_count, v_reset;
  return query select v_count <= p_limit, greatest(p_limit - v_count, 0), v_reset;
end;
$$;
revoke execute on function public.rate_limit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.rate_limit(text, integer, integer) to service_role;

-- Reads a counter without consuming it: per-e-mail auth limits are checked first and only charged once the
-- captcha passed (otherwise anyone could lock someone else's account without solving a captcha).
create function public.rate_limit_peek(p_key text, p_limit integer) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select r.reset_at <= now() or r.count < p_limit from public.rate_limits r where r.key = p_key),
    true
  );
$$;
revoke execute on function public.rate_limit_peek(text, integer) from public, anon, authenticated;
grant execute on function public.rate_limit_peek(text, integer) to service_role;

-- Feature flags ----------------------------------------------------------------------------------------------------
-- Optional layer over the env defaults in src/lib/flags.ts. Signed-in users may read them (they are product
-- switches, not user data: `using (true)` on purpose); only the server (service role) changes them, e.g. in Studio
-- or an admin action.
create table public.feature_flags (
  key text primary key check (key ~ '^[a-z][a-z0-9_]{0,63}$'),
  enabled boolean not null default false,
  description text check (char_length(description) <= 500),
  updated_at timestamptz not null default now()
);
alter table public.feature_flags enable row level security;
create trigger feature_flags_updated_at before update on public.feature_flags
  for each row execute function public.set_updated_at();

create policy "feature_flags: signed-in users read" on public.feature_flags
  for select to authenticated using (true);
revoke all on public.feature_flags from anon, authenticated;
grant select on public.feature_flags to authenticated;
grant all on public.feature_flags to service_role;

-- Two-step verification on user data -------------------------------------------------------------------------------
-- Restrictive = ANDed with every permissive policy. New tables with user or organization data get the same policy.
create policy "mfa: aal2 when enrolled" on public.profiles
  as restrictive for all to authenticated
  using ((select public.mfa_satisfied())) with check ((select public.mfa_satisfied()));
create policy "mfa: aal2 when enrolled" on public.notifications
  as restrictive for all to authenticated
  using ((select public.mfa_satisfied())) with check ((select public.mfa_satisfied()));
create policy "mfa: aal2 when enrolled" on public.subscriptions
  as restrictive for all to authenticated
  using ((select public.mfa_satisfied())) with check ((select public.mfa_satisfied()));
create policy "mfa: aal2 when enrolled" on public.organizations
  as restrictive for all to authenticated
  using ((select public.mfa_satisfied())) with check ((select public.mfa_satisfied()));
create policy "mfa: aal2 when enrolled" on public.memberships
  as restrictive for all to authenticated
  using ((select public.mfa_satisfied())) with check ((select public.mfa_satisfied()));
create policy "mfa: aal2 when enrolled" on public.invitations
  as restrictive for all to authenticated
  using ((select public.mfa_satisfied())) with check ((select public.mfa_satisfied()));
create policy "mfa: aal2 when enrolled (private topics)" on realtime.messages
  as restrictive for select to authenticated
  using ((select realtime.topic()) not like 'user:%' or (select public.mfa_satisfied()));


create extension if not exists pgcrypto;

create table public.app_config (
  id int primary key default 1,
  master_password_hash text,
  master_salt text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint app_config_singleton check (id = 1)
);
insert into public.app_config (id) values (1);

create table public.admin_sessions (
  token uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '7 days')
);

create table public.bot_users (
  id uuid primary key default gen_random_uuid(),
  slot int not null unique check (slot between 1 and 15),
  label text not null default '',
  username text not null default '',
  password text not null default '',
  telegram_bot_token text not null default '',
  telegram_chat_id text not null default '',
  min_price numeric not null default 0,
  max_price numeric not null default 999999,
  payment_methods text[] not null default '{}',
  polling_interval_ms int not null default 1000 check (polling_interval_ms >= 200),
  is_active boolean not null default false,
  auth_token text,
  auth_token_at timestamptz,
  status text not null default 'idle',
  status_message text not null default '',
  last_polled_at timestamptz,
  orders_grabbed int not null default 0,
  seen_order_ids text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Pre-seed 15 empty slots
insert into public.bot_users (slot, label)
select g, 'User ' || g from generate_series(1,15) g;

create table public.bot_logs (
  id bigint primary key generated always as identity,
  user_id uuid references public.bot_users(id) on delete cascade,
  slot int,
  level text not null default 'info',
  message text not null,
  meta jsonb,
  created_at timestamptz not null default now()
);
create index bot_logs_created_at_idx on public.bot_logs (created_at desc);
create index bot_logs_user_idx on public.bot_logs (user_id, created_at desc);

-- Grants: backend-only via service_role
grant all on public.app_config to service_role;
grant all on public.admin_sessions to service_role;
grant all on public.bot_users to service_role;
grant all on public.bot_logs to service_role;
grant usage, select on all sequences in schema public to service_role;

-- Lock down with RLS (no policies = no access for anon/authenticated)
alter table public.app_config enable row level security;
alter table public.admin_sessions enable row level security;
alter table public.bot_users enable row level security;
alter table public.bot_logs enable row level security;

-- updated_at trigger
create or replace function public.tg_set_updated_at()
returns trigger language plpgsql set search_path = public as $$
begin
  new.updated_at = now();
  return new;
end $$;

create trigger bot_users_updated_at before update on public.bot_users
  for each row execute function public.tg_set_updated_at();
create trigger app_config_updated_at before update on public.app_config
  for each row execute function public.tg_set_updated_at();

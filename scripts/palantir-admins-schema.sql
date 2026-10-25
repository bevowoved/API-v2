create table if not exists public.palantir_admins (
    email      text primary key,
    created_at timestamptz not null default now()
);

alter table public.palantir_admins enable row level security;

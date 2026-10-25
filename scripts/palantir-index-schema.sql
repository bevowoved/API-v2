create table if not exists public.palantir_index (
    id          bigint generated always as identity primary key,
    built_at    bigint not null,
    expires_at  bigint not null,
    window_start bigint not null,
    window_end  bigint not null,
    payload     jsonb not null,
    created_at  timestamptz not null default now()
);

alter table public.palantir_index enable row level security;

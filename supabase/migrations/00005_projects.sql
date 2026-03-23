create table if not exists projects (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  canvas_json jsonb not null default '[]',
  created_at timestamptz not null default now()
);

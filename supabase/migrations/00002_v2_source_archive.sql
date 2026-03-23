-- ============================================================
-- PARTCOPY v2: Source Archive + Page Assets
-- ============================================================

-- Page assets: CSS, fonts, images, scripts referenced by a page
create table page_assets (
  id uuid primary key default gen_random_uuid(),
  page_id uuid not null references source_pages(id) on delete cascade,
  asset_type text not null check (asset_type in ('stylesheet', 'font', 'image', 'script', 'other')),
  url text not null,
  storage_path text,
  content_type text,
  size_bytes bigint,
  status_code int,
  initiator text,
  created_at timestamptz not null default now()
);

create index idx_page_assets_page on page_assets(page_id);
create index idx_page_assets_type on page_assets(asset_type);

-- Add final_html_path to source_pages
alter table source_pages add column if not exists final_html_path text;
alter table source_pages add column if not exists request_log_path text;
alter table source_pages add column if not exists css_bundle_path text;

-- Enrich source_sections with better features
alter table source_sections add column if not exists image_count int default 0;
alter table source_sections add column if not exists button_count int default 0;
alter table source_sections add column if not exists repeated_child_pattern text;
alter table source_sections add column if not exists class_tokens text[] default '{}';
alter table source_sections add column if not exists id_tokens text[] default '{}';
alter table source_sections add column if not exists computed_style_summary jsonb default '{}';

-- Add slot/token fields to block_instances for canonical blocks
alter table block_instances add column if not exists family_key text;
alter table block_instances add column if not exists variant_key text;

-- RLS for page_assets
alter table page_assets enable row level security;
create policy "page_assets_read" on page_assets for select using (auth.role() = 'authenticated');

-- New bucket for page-level HTML
-- (created via API, not SQL)

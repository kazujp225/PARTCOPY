-- ============================================================
-- PARTCOPY Database Schema
-- 4-layer architecture:
--   1. Tenant (org/workspace/project)
--   2. Corpus (sites/crawls/pages/sections)
--   3. Canonical Block (families/variants/instances)
--   4. Editor/Output (project pages/blocks/exports)
-- ============================================================

-- Enable extensions
create extension if not exists "vector";

-- ============================================================
-- Layer 1: Tenant
-- ============================================================

create table organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text unique not null,
  created_at timestamptz not null default now()
);

create table organization_members (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'admin', 'member')),
  created_at timestamptz not null default now(),
  unique(organization_id, user_id)
);

create table workspaces (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  slug text not null,
  created_at timestamptz not null default now(),
  unique(organization_id, slug)
);

create table projects (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name text not null,
  industry text,
  target_page_types text[] default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ============================================================
-- Layer 2: Corpus
-- ============================================================

create table source_sites (
  id uuid primary key default gen_random_uuid(),
  normalized_domain text unique not null,
  homepage_url text not null,
  industry text,
  company_type text,
  language text default 'ja',
  genre text default '',
  tags text[] default '{}',
  status text not null default 'discovered' check (status in ('discovered', 'queued', 'crawled', 'analyzed', 'failed')),
  first_seen_at timestamptz not null default now(),
  last_crawled_at timestamptz
);

create index idx_source_sites_industry on source_sites(industry);
create index idx_source_sites_genre on source_sites(genre);
create index idx_source_sites_status on source_sites(status);

create table crawl_runs (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references source_sites(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  trigger_type text not null default 'manual' check (trigger_type in ('manual', 'scheduled', 'benchmark')),
  status text not null default 'queued' check (status in ('queued', 'claimed', 'rendering', 'parsed', 'normalizing', 'done', 'failed')),
  worker_id text,
  worker_version text,
  error_code text,
  error_message text,
  page_count int default 0,
  section_count int default 0,
  queued_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);

create index idx_crawl_runs_status on crawl_runs(status);
create index idx_crawl_runs_site_id on crawl_runs(site_id);

create table source_pages (
  id uuid primary key default gen_random_uuid(),
  crawl_run_id uuid not null references crawl_runs(id) on delete cascade,
  site_id uuid not null references source_sites(id) on delete cascade,
  url text not null,
  path text not null,
  page_type text default 'unknown',
  title text,
  meta_description text,
  dom_storage_path text,
  screenshot_storage_path text,
  content_hash text,
  layout_hash text,
  created_at timestamptz not null default now()
);

create index idx_source_pages_crawl_run on source_pages(crawl_run_id);
create index idx_source_pages_page_type on source_pages(page_type);

create table source_sections (
  id uuid primary key default gen_random_uuid(),
  page_id uuid not null references source_pages(id) on delete cascade,
  site_id uuid not null references source_sites(id) on delete cascade,
  order_index int not null default 0,
  dom_path text,
  tag_name text,
  bbox_json jsonb,
  raw_html_storage_path text,
  sanitized_html_storage_path text,
  thumbnail_storage_path text,

  -- Classification
  block_family text,
  block_variant text,
  classifier_type text default 'heuristic',
  classifier_confidence float default 0,

  -- Features for ML
  features_jsonb jsonb default '{}',
  text_summary text default '',

  -- Layout signature for dedup/similarity
  layout_signature text,

  -- Embedding for similarity search
  embedding vector(384),

  created_at timestamptz not null default now()
);

create index idx_source_sections_page on source_sections(page_id);
create index idx_source_sections_family on source_sections(block_family);
create index idx_source_sections_site on source_sections(site_id);

create table section_labels (
  id uuid primary key default gen_random_uuid(),
  section_id uuid not null references source_sections(id) on delete cascade,
  label_source text not null check (label_source in ('heuristic', 'human', 'model')),
  block_family text not null,
  block_variant text,
  confidence float default 1.0,
  reviewer_user_id uuid references auth.users(id),
  model_version text,
  created_at timestamptz not null default now()
);

create index idx_section_labels_section on section_labels(section_id);

-- ============================================================
-- Layer 3: Canonical Block
-- ============================================================

create table block_families (
  id uuid primary key default gen_random_uuid(),
  key text unique not null,
  label text not null,
  label_ja text not null,
  description text,
  sort_order int default 0
);

-- Seed initial families
insert into block_families (key, label, label_ja, sort_order) values
  ('navigation',      'Navigation',      'ナビゲーション',    1),
  ('hero',            'Hero',            'ヒーロー',          2),
  ('feature',         'Feature',         '特徴・サービス',    3),
  ('social_proof',    'Social Proof',    '導入実績・信頼',    4),
  ('stats',           'Stats',           '数字・実績',        5),
  ('pricing',         'Pricing',         '料金プラン',        6),
  ('faq',             'FAQ',             'よくある質問',      7),
  ('content',         'Content',         'コンテンツ',        8),
  ('cta',             'CTA',             'CTA',               9),
  ('contact',         'Contact',         'お問い合わせ',      10),
  ('recruit',         'Recruit',         '採用',              11),
  ('footer',          'Footer',          'フッター',          12),
  ('news_list',       'News List',       'お知らせ',          13),
  ('timeline',        'Timeline',        '沿革・タイムライン', 14),
  ('company_profile', 'Company Profile', '会社概要',          15),
  ('gallery',         'Gallery',         'ギャラリー',        16),
  ('logo_cloud',      'Logo Cloud',      'ロゴ一覧',          17);

create table block_variants (
  id uuid primary key default gen_random_uuid(),
  family_key text not null references block_families(key),
  variant_key text unique not null,
  label text not null,
  slot_schema_json jsonb not null default '{}',
  default_token_schema_json jsonb not null default '{}',
  renderer_key text,
  version int not null default 1,
  created_at timestamptz not null default now()
);

-- Seed initial variants
insert into block_variants (family_key, variant_key, label, slot_schema_json) values
  ('hero', 'hero_centered',        'Hero Centered',        '{"headline":{"type":"text","required":true},"subheadline":{"type":"text"},"primary_cta":{"type":"cta"},"media":{"type":"media_slot"}}'),
  ('hero', 'hero_split_left',      'Hero Split Left',      '{"headline":{"type":"text","required":true},"subheadline":{"type":"text"},"primary_cta":{"type":"cta"},"secondary_cta":{"type":"cta"},"media":{"type":"media_slot"}}'),
  ('hero', 'hero_split_right',     'Hero Split Right',     '{"headline":{"type":"text","required":true},"subheadline":{"type":"text"},"primary_cta":{"type":"cta"},"media":{"type":"media_slot"}}'),
  ('hero', 'hero_with_trust',      'Hero + Trust Strip',   '{"headline":{"type":"text","required":true},"subheadline":{"type":"text"},"primary_cta":{"type":"cta"},"trust_logos":{"type":"media_list"}}'),
  ('feature', 'feature_grid_3',    'Feature Grid 3-col',   '{"section_title":{"type":"text"},"cards":{"type":"card_list","min":3,"max":3},"icon_style":{"type":"enum","values":["icon","image","emoji"]}}'),
  ('feature', 'feature_grid_4',    'Feature Grid 4-col',   '{"section_title":{"type":"text"},"cards":{"type":"card_list","min":4,"max":4}}'),
  ('feature', 'feature_grid_6',    'Feature Grid 6-col',   '{"section_title":{"type":"text"},"cards":{"type":"card_list","min":6,"max":6}}'),
  ('feature', 'feature_alternating','Feature Alternating',  '{"section_title":{"type":"text"},"items":{"type":"feature_list"}}'),
  ('pricing', 'pricing_3col',      'Pricing 3-Column',     '{"section_title":{"type":"text"},"plans":{"type":"plan_list","min":2,"max":4}}'),
  ('pricing', 'pricing_toggle',    'Pricing Toggle',       '{"section_title":{"type":"text"},"toggle_labels":{"type":"text_pair"},"plans":{"type":"plan_list"}}'),
  ('faq', 'faq_accordion',         'FAQ Accordion',        '{"section_title":{"type":"text"},"items":{"type":"qa_list"}}'),
  ('faq', 'faq_2col',              'FAQ 2-Column',         '{"section_title":{"type":"text"},"items":{"type":"qa_list"}}'),
  ('cta', 'cta_banner_single',     'CTA Banner',           '{"headline":{"type":"text"},"subtext":{"type":"text"},"primary_cta":{"type":"cta"}}'),
  ('cta', 'cta_banner_dual',       'CTA Banner Dual',      '{"headline":{"type":"text"},"primary_cta":{"type":"cta"},"secondary_cta":{"type":"cta"}}'),
  ('contact', 'contact_form_full', 'Contact Full Form',    '{"headline":{"type":"text"},"description":{"type":"text"},"form_fields":{"type":"form_schema"}}'),
  ('contact', 'contact_split',     'Contact Split',        '{"headline":{"type":"text"},"info":{"type":"contact_info"},"form_fields":{"type":"form_schema"}}'),
  ('footer', 'footer_sitemap',     'Footer Sitemap',       '{"columns":{"type":"link_group_list"},"copyright":{"type":"text"},"social_links":{"type":"link_list"}}'),
  ('footer', 'footer_minimal',     'Footer Minimal',       '{"copyright":{"type":"text"},"links":{"type":"link_list"}}'),
  ('navigation', 'nav_simple',     'Navigation Simple',    '{"logo":{"type":"media_slot"},"links":{"type":"link_list"},"cta":{"type":"cta"}}'),
  ('navigation', 'nav_mega',       'Navigation Mega Menu', '{"logo":{"type":"media_slot"},"menu_groups":{"type":"link_group_list"},"cta":{"type":"cta"}}'),
  ('social_proof', 'testimonial_cards', 'Testimonial Cards','{"section_title":{"type":"text"},"testimonials":{"type":"testimonial_list"}}'),
  ('social_proof', 'logo_strip',   'Logo Strip',           '{"section_title":{"type":"text"},"logos":{"type":"media_list"}}'),
  ('stats', 'stats_row',           'Stats Row',            '{"stats":{"type":"stat_list","min":3,"max":6}}'),
  ('stats', 'stats_with_text',     'Stats + Description',  '{"headline":{"type":"text"},"description":{"type":"text"},"stats":{"type":"stat_list"}}');

create table block_instances (
  id uuid primary key default gen_random_uuid(),
  source_section_id uuid references source_sections(id) on delete set null,
  block_variant_id uuid not null references block_variants(id),
  slot_values_jsonb jsonb not null default '{}',
  token_values_jsonb jsonb not null default '{}',
  provenance_jsonb jsonb default '{}',
  quality_score float,
  embedding vector(384),
  created_at timestamptz not null default now()
);

create index idx_block_instances_variant on block_instances(block_variant_id);

create table style_token_sets (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  tokens_jsonb jsonb not null default '{}',
  source_url text,
  industry text,
  created_at timestamptz not null default now()
);

-- ============================================================
-- Layer 4: Editor / Output
-- ============================================================

create table project_pages (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  slug text not null,
  title text,
  page_type text default 'home',
  seo_jsonb jsonb default '{}',
  status text not null default 'draft' check (status in ('draft', 'review', 'published', 'archived')),
  sort_order int default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(project_id, slug)
);

create table project_page_blocks (
  id uuid primary key default gen_random_uuid(),
  project_page_id uuid not null references project_pages(id) on delete cascade,
  position int not null default 0,
  block_variant_id uuid not null references block_variants(id),
  source_block_instance_id uuid references block_instances(id) on delete set null,
  slot_overrides_jsonb jsonb default '{}',
  token_overrides_jsonb jsonb default '{}',
  visibility_rules_jsonb jsonb default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_ppb_page on project_page_blocks(project_page_id);

create table project_assets (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  storage_path text not null,
  file_name text not null,
  mime_type text,
  width int,
  height int,
  size_bytes bigint,
  created_at timestamptz not null default now()
);

create table exports (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  format text not null check (format in ('static_html', 'nextjs_tailwind', 'wordpress', 'json_schema')),
  storage_path text,
  status text not null default 'pending' check (status in ('pending', 'generating', 'done', 'failed')),
  created_at timestamptz not null default now(),
  finished_at timestamptz
);

-- ============================================================
-- RLS Policies (basic - expand per role later)
-- ============================================================

alter table organizations enable row level security;
alter table organization_members enable row level security;
alter table workspaces enable row level security;
alter table projects enable row level security;
alter table project_pages enable row level security;
alter table project_page_blocks enable row level security;
alter table project_assets enable row level security;
alter table exports enable row level security;

-- Members can see their orgs
create policy "org_members_select" on organizations for select using (
  id in (select organization_id from organization_members where user_id = auth.uid())
);

-- Members can see their workspaces
create policy "workspace_members_select" on workspaces for select using (
  organization_id in (select organization_id from organization_members where user_id = auth.uid())
);

-- Members can see their projects
create policy "project_members_select" on projects for select using (
  workspace_id in (
    select w.id from workspaces w
    join organization_members om on om.organization_id = w.organization_id
    where om.user_id = auth.uid()
  )
);

-- Corpus tables: readable by all authenticated users (research data)
alter table source_sites enable row level security;
create policy "source_sites_read" on source_sites for select using (auth.role() = 'authenticated');

alter table source_sections enable row level security;
create policy "source_sections_read" on source_sections for select using (auth.role() = 'authenticated');

alter table block_families enable row level security;
create policy "block_families_read" on block_families for select using (true);

alter table block_variants enable row level security;
create policy "block_variants_read" on block_variants for select using (true);

alter table block_instances enable row level security;
create policy "block_instances_read" on block_instances for select using (auth.role() = 'authenticated');

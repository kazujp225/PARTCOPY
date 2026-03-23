-- ============================================================
-- PARTCOPY v3: Editable Layer (Mutation Model)
-- ============================================================
-- 追加する層:
--   A. DOM Editable Snapshot (編集用凍結DOM)
--   B. Section Nodes (編集可能ノード)
--   C. Patch Sets / Patches (変更履歴)
--   D. project_page_blocks 拡張 (render_mode)
-- ============================================================

-- ============================================================
-- A. section_dom_snapshots
-- 「編集用に凍結したDOMスナップショット」
-- raw = outerHTMLそのまま
-- sanitized = スクリプト除去済み
-- resolved = computed style インライン化済み（編集用）
-- ============================================================

create table section_dom_snapshots (
  id uuid primary key default gen_random_uuid(),
  section_id uuid not null references source_sections(id) on delete cascade,
  snapshot_type text not null check (snapshot_type in ('raw', 'sanitized', 'resolved')),
  html_storage_path text not null,
  dom_json_path text,
  node_count int default 0,
  css_strategy text not null default 'bundle' check (css_strategy in ('bundle', 'resolved_inline', 'scoped')),
  created_at timestamptz not null default now()
);

create index idx_dom_snapshots_section on section_dom_snapshots(section_id);
create index idx_dom_snapshots_type on section_dom_snapshots(snapshot_type);

-- ============================================================
-- B. section_nodes
-- Mutation Model の核。セクションを編集可能ノードに分解。
-- stable_key はパッチ適用時のアドレスになる。
-- ============================================================

create table section_nodes (
  id uuid primary key default gen_random_uuid(),
  snapshot_id uuid not null references section_dom_snapshots(id) on delete cascade,
  parent_node_id uuid references section_nodes(id) on delete cascade,
  stable_key text not null,
  node_type text not null check (node_type in (
    'root', 'container', 'heading', 'paragraph', 'text', 'link',
    'button', 'image', 'video', 'input', 'list', 'list_item',
    'icon', 'badge', 'card', 'form', 'other'
  )),
  tag_name text not null,
  order_index int not null default 0,
  text_content text,
  attrs_jsonb jsonb default '{}',
  bbox_json jsonb,
  computed_style_jsonb jsonb default '{}',
  editable boolean not null default true,
  selector_path text,
  created_at timestamptz not null default now()
);

create index idx_section_nodes_snapshot on section_nodes(snapshot_id);
create index idx_section_nodes_parent on section_nodes(parent_node_id);
create index idx_section_nodes_stable_key on section_nodes(stable_key);
create index idx_section_nodes_type on section_nodes(node_type);

-- ============================================================
-- C. section_patch_sets / section_patches
-- 「編集履歴」。base_snapshot に対する差分の集合。
-- ============================================================

create table section_patch_sets (
  id uuid primary key default gen_random_uuid(),
  section_id uuid not null references source_sections(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  base_snapshot_id uuid not null references section_dom_snapshots(id) on delete cascade,
  label text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_patch_sets_section on section_patch_sets(section_id);
create index idx_patch_sets_project on section_patch_sets(project_id);

create table section_patches (
  id uuid primary key default gen_random_uuid(),
  patch_set_id uuid not null references section_patch_sets(id) on delete cascade,
  node_stable_key text not null,
  op text not null check (op in (
    'set_text', 'set_attr', 'replace_asset',
    'remove_node', 'insert_after', 'move_node',
    'set_style_token', 'set_class'
  )),
  payload_jsonb jsonb not null default '{}',
  order_index int not null default 0,
  created_at timestamptz not null default now()
);

create index idx_patches_patch_set on section_patches(patch_set_id);
create index idx_patches_node_key on section_patches(node_stable_key);

-- ============================================================
-- D. project_page_blocks 拡張
-- render_mode で source_patch / canonical を分岐
-- ============================================================

alter table project_page_blocks
  add column if not exists render_mode text
    not null default 'source_patch'
    check (render_mode in ('source_patch', 'canonical'));

alter table project_page_blocks
  add column if not exists source_section_id uuid
    references source_sections(id) on delete set null;

alter table project_page_blocks
  add column if not exists patch_set_id uuid
    references section_patch_sets(id) on delete set null;

-- ============================================================
-- RLS
-- ============================================================

alter table section_dom_snapshots enable row level security;
create policy "dom_snapshots_read" on section_dom_snapshots
  for select using (auth.role() = 'authenticated');

alter table section_nodes enable row level security;
create policy "section_nodes_read" on section_nodes
  for select using (auth.role() = 'authenticated');

alter table section_patch_sets enable row level security;
create policy "patch_sets_read" on section_patch_sets
  for select using (auth.role() = 'authenticated');

alter table section_patches enable row level security;
create policy "patches_read" on section_patches
  for select using (auth.role() = 'authenticated');

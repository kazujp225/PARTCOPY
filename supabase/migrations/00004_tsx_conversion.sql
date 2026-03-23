-- Add TSX conversion storage path to source_sections
alter table source_sections
  add column if not exists tsx_code_storage_path text;

-- Add status_detail to crawl_runs
alter table crawl_runs add column if not exists status_detail text;

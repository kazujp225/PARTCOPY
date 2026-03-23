-- Add TSX conversion storage path to source_sections
alter table source_sections
  add column if not exists tsx_code_storage_path text;

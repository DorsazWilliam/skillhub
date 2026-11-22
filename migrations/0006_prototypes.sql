-- A fourth fixed area: prototypes/ (HTML prototypes, versioned like documents). See docs/DECISIONS.md (entry 47).
-- Additive: one area node and its everyone:viewer grant, like the other areas in 0003.

-- Free the reserved name if a top-level folder already uses it (only areas live at the top level since 0003).
UPDATE nodes SET name = name || ' (old)' WHERE parent_id IS NULL AND lower(name) = 'prototypes';

INSERT INTO nodes (id, parent_id, kind, name, path, inherit, created_by, created_at, updated_at) VALUES
  ('00000000000000000000000AP1', NULL, 'folder', 'prototypes', '/00000000000000000000000AP1/', 1, 'system', 0, 0);
INSERT INTO grants (id, node_id, principal_type, principal_id, role, created_by, created_at) VALUES
  ('0000000000000000000000GAP1', '00000000000000000000000AP1', 'team', 'everyone', 1, 'system', 0);

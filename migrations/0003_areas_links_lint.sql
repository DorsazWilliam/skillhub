-- Three fixed areas (rules, skills, documentation), skill folders, text files, canonical links and authoring warnings.
-- Additive: new columns, tables and rows only. See docs/DECISIONS.md (entries 19 to 28).

-- Documents carry a format: 'markdown' or the extension of a text file (sh, py, sql, ...).
ALTER TABLE nodes ADD COLUMN format TEXT NOT NULL DEFAULT 'markdown';

-- Free the reserved area names among existing top-level folders.
UPDATE nodes SET name = name || ' (old)' WHERE parent_id IS NULL AND lower(name) IN ('rules', 'skills', 'documentation');

-- The areas. Fixed ids, readable by everyone; grants below them work as before.
INSERT INTO nodes (id, parent_id, kind, name, path, inherit, created_by, created_at, updated_at) VALUES
  ('00000000000000000000000AR1', NULL, 'folder', 'rules', '/00000000000000000000000AR1/', 1, 'system', 0, 0),
  ('00000000000000000000000AS1', NULL, 'folder', 'skills', '/00000000000000000000000AS1/', 1, 'system', 0, 0),
  ('00000000000000000000000AD1', NULL, 'folder', 'documentation', '/00000000000000000000000AD1/', 1, 'system', 0, 0);
INSERT INTO grants (id, node_id, principal_type, principal_id, role, created_by, created_at) VALUES
  ('0000000000000000000000GAR1', '00000000000000000000000AR1', 'team', 'everyone', 1, 'system', 0),
  ('0000000000000000000000GAS1', '00000000000000000000000AS1', 'team', 'everyone', 1, 'system', 0),
  ('0000000000000000000000GAD1', '00000000000000000000000AD1', 'team', 'everyone', 1, 'system', 0);

-- Every other existing top-level folder (live or trashed) moves under documentation/, with its grants.
UPDATE nodes SET parent_id = '00000000000000000000000AD1'
  WHERE parent_id IS NULL AND id NOT IN ('00000000000000000000000AR1', '00000000000000000000000AS1', '00000000000000000000000AD1', '000000000000000000000000HB');
UPDATE nodes SET path = '/00000000000000000000000AD1' || path
  WHERE substr(path, 2, 26) NOT IN ('00000000000000000000000AR1', '00000000000000000000000AS1', '00000000000000000000000AD1', '000000000000000000000000HB');

-- _hub moves under skills/ and keeps its inheritance boundary and everyone:viewer grant.
UPDATE nodes SET parent_id = '00000000000000000000000AS1' WHERE id = '000000000000000000000000HB';
UPDATE nodes SET path = '/00000000000000000000000AS1' || path WHERE substr(path, 2, 26) = '000000000000000000000000HB';

-- Each built-in skill document becomes SKILL.md inside a skill folder of the same name.
-- One at a time, so sibling names never collide.
UPDATE nodes SET name = 'SKILL.md' WHERE id = '00000000000000000000000HB1' AND parent_id = '000000000000000000000000HB' AND deleted_at IS NULL;
INSERT INTO nodes (id, parent_id, kind, name, path, inherit, created_by, created_at, updated_at)
  SELECT '00000000000000000000000HF1', '000000000000000000000000HB', 'folder', 'hub-authoring', '/00000000000000000000000AS1/000000000000000000000000HB/00000000000000000000000HF1/', 1, 'system', 0, 0
  WHERE EXISTS (SELECT 1 FROM nodes WHERE id = '00000000000000000000000HB1' AND name = 'SKILL.md' AND parent_id = '000000000000000000000000HB');
UPDATE nodes SET parent_id = '00000000000000000000000HF1', path = '/00000000000000000000000AS1/000000000000000000000000HB/00000000000000000000000HF1/00000000000000000000000HB1/'
  WHERE id = '00000000000000000000000HB1' AND name = 'SKILL.md' AND parent_id = '000000000000000000000000HB';

UPDATE nodes SET name = 'SKILL.md' WHERE id = '00000000000000000000000HB2' AND parent_id = '000000000000000000000000HB' AND deleted_at IS NULL;
INSERT INTO nodes (id, parent_id, kind, name, path, inherit, created_by, created_at, updated_at)
  SELECT '00000000000000000000000HF2', '000000000000000000000000HB', 'folder', 'hub-promote', '/00000000000000000000000AS1/000000000000000000000000HB/00000000000000000000000HF2/', 1, 'system', 0, 0
  WHERE EXISTS (SELECT 1 FROM nodes WHERE id = '00000000000000000000000HB2' AND name = 'SKILL.md' AND parent_id = '000000000000000000000000HB');
UPDATE nodes SET parent_id = '00000000000000000000000HF2', path = '/00000000000000000000000AS1/000000000000000000000000HB/00000000000000000000000HF2/00000000000000000000000HB2/'
  WHERE id = '00000000000000000000000HB2' AND name = 'SKILL.md' AND parent_id = '000000000000000000000000HB';

UPDATE nodes SET name = 'SKILL.md' WHERE id = '00000000000000000000000HB3' AND parent_id = '000000000000000000000000HB' AND deleted_at IS NULL;
INSERT INTO nodes (id, parent_id, kind, name, path, inherit, created_by, created_at, updated_at)
  SELECT '00000000000000000000000HF3', '000000000000000000000000HB', 'folder', 'hub-access', '/00000000000000000000000AS1/000000000000000000000000HB/00000000000000000000000HF3/', 1, 'system', 0, 0
  WHERE EXISTS (SELECT 1 FROM nodes WHERE id = '00000000000000000000000HB3' AND name = 'SKILL.md' AND parent_id = '000000000000000000000000HB');
UPDATE nodes SET parent_id = '00000000000000000000000HF3', path = '/00000000000000000000000AS1/000000000000000000000000HB/00000000000000000000000HF3/00000000000000000000000HB3/'
  WHERE id = '00000000000000000000000HB3' AND name = 'SKILL.md' AND parent_id = '000000000000000000000000HB';

-- Only SKILL.md documents inside skills/ are skills now.
CREATE INDEX nodes_skill_md ON nodes (parent_id) WHERE name = 'SKILL.md' AND deleted_at IS NULL;
UPDATE nodes SET is_skill = 0 WHERE NOT (name = 'SKILL.md' AND substr(path, 2, 26) = '00000000000000000000000AS1');
DELETE FROM skill_fts WHERE doc_id NOT IN (SELECT id FROM nodes WHERE name = 'SKILL.md' AND substr(path, 2, 26) = '00000000000000000000000AS1');

-- Content search over published plain documents and files (find_skills never returns these).
CREATE VIRTUAL TABLE doc_fts USING fts5(doc_id UNINDEXED, name, body, tokenize = 'porter unicode61');
INSERT INTO doc_fts (doc_id, name, body)
  SELECT n.id, n.name, v.content FROM nodes n JOIN doc_versions v ON v.doc_id = n.id AND v.n = n.published_version
  WHERE n.kind = 'doc' AND n.deleted_at IS NULL AND n.name <> 'SKILL.md';

-- Canonical links ([[area/path]] and [[area/path|label]]), parsed from the published version and the working copy.
-- to_node is the target at write time; reads always re-resolve to_path.
CREATE TABLE links (
  from_node TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('published', 'draft')),
  ord INTEGER NOT NULL,
  to_path TEXT NOT NULL,
  label TEXT,
  to_node TEXT,
  PRIMARY KEY (from_node, kind, ord)
);
CREATE INDEX links_to_path ON links (lower(to_path));
CREATE INDEX links_to_node ON links (to_node);

-- Dismissed authoring warnings, keyed on the warning code and the text it flags.
CREATE TABLE lint_dismissals (
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  dismissed_by TEXT NOT NULL,
  dismissed_at INTEGER NOT NULL,
  PRIMARY KEY (node_id, key)
);

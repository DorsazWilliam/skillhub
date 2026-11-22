-- What agents actually use: per UTC day, person and node.
-- loads: get_skill over MCP on a skill (counted on its folder) or a document.
-- shown: times the node came back in find_skills or search results over MCP.
-- No foreign keys: rows outlive deleted nodes and are filtered on read. Kept 90 days (cleanup cron).
CREATE TABLE usage_daily (
  day TEXT NOT NULL,
  node_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  loads INTEGER NOT NULL DEFAULT 0,
  shown INTEGER NOT NULL DEFAULT 0,
  last_load_at INTEGER,
  PRIMARY KEY (day, node_id, actor_id)
);
CREATE INDEX usage_node ON usage_daily (node_id, day);

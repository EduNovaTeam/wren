-- 会话激活的技能。禁用技能或重新启用都不会恢复历史记录。
CREATE TABLE session_skills (
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  activated_at TEXT NOT NULL,
  PRIMARY KEY (session_id, name)
);

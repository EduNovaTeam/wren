-- Skill 的全局启停。Skill 内容以文件为准，这里只保存用户的选择。
CREATE TABLE skill_settings (
  name TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  updated_at TEXT NOT NULL
);

-- 每个会话已激活的 Skill。激活状态独立保存，不能只靠历史里的工具调用推断。
CREATE TABLE session_skills (
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  name TEXT NOT NULL,           -- Skill 目录名
  source TEXT NOT NULL CHECK (source IN ('builtin', 'user')),
  activated_at TEXT NOT NULL,
  PRIMARY KEY (session_id, name)
);

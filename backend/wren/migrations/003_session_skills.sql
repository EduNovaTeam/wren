-- 会话里生效中的 skill：用户用 /skill-name 指定过，或模型用 use_skill 读过它的正文。
-- 一旦生效，后续每个回合都把它放进系统提示，直到会话结束。
CREATE TABLE session_skills (
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  skill_name TEXT NOT NULL,
  activated_at TEXT NOT NULL,
  PRIMARY KEY (session_id, skill_name)
);

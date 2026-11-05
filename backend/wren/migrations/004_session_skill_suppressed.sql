-- 用户可以退出某个 skill 的「会话级生效」，退出后不再自动进入上下文。
-- 不删记录而是打标记：模型之后即使又读到这个 skill，也不该把它悄悄拉回生效状态；
-- 只有用户用 /名字 明确点名才清除这个标记。
ALTER TABLE session_skills ADD COLUMN suppressed_at TEXT;

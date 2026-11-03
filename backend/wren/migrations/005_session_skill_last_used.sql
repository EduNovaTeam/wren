-- 多个 skill 同时生效时需要一个「主导」：最近用过的那个。activated_at 只在首次启用时
-- 写入，排序结果是最早用的在前，和「用户刚才在用哪个」正好相反。
ALTER TABLE session_skills ADD COLUMN last_used_at TEXT;

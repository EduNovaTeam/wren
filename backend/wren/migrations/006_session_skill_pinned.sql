-- 「最近使用」能表达「刚才在用哪个」，但表达不了「用户明确选了它」。
-- 模型读一次别的 skill 就把它顶掉了，用户点的主导会无声消失。
ALTER TABLE session_skills ADD COLUMN pinned_at TEXT;

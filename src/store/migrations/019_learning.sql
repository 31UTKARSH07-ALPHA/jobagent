CREATE TABLE learning_plans (
 id INTEGER PRIMARY KEY, application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
 created_at TEXT NOT NULL, round TEXT NOT NULL, basis TEXT NOT NULL, content TEXT NOT NULL CHECK(json_valid(content))
) STRICT;
CREATE INDEX learning_plans_application ON learning_plans(application_id,id);
CREATE TABLE learning_progress (
 plan_id INTEGER NOT NULL REFERENCES learning_plans(id) ON DELETE CASCADE, item_id TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('attempted','revision','mastered')),
 attempts INTEGER NOT NULL, streak INTEGER NOT NULL, due_at TEXT NOT NULL,last_at TEXT NOT NULL,
 PRIMARY KEY(plan_id,item_id)
) STRICT;
CREATE TABLE learning_notes (
 plan_id INTEGER NOT NULL REFERENCES learning_plans(id) ON DELETE CASCADE,item_id TEXT NOT NULL,note TEXT NOT NULL,
 PRIMARY KEY(plan_id,item_id)
) STRICT;
CREATE TABLE learning_exercises (
 id INTEGER PRIMARY KEY,plan_id INTEGER NOT NULL REFERENCES learning_plans(id) ON DELETE CASCADE,
 item_id TEXT NOT NULL,answer TEXT NOT NULL,created_at TEXT NOT NULL
) STRICT;
CREATE TABLE learning_sessions (
 id INTEGER PRIMARY KEY, plan_id INTEGER NOT NULL REFERENCES learning_plans(id) ON DELETE CASCADE,
 created_at TEXT NOT NULL, finished_at TEXT, abandoned INTEGER NOT NULL DEFAULT 0 CHECK(abandoned IN (0,1)), question_ids TEXT NOT NULL CHECK(json_valid(question_ids))
) STRICT;
CREATE UNIQUE INDEX learning_active_mock ON learning_sessions(plan_id) WHERE finished_at IS NULL;
CREATE TABLE learning_answers (
 session_id INTEGER NOT NULL REFERENCES learning_sessions(id) ON DELETE CASCADE,
 position INTEGER NOT NULL, item_id TEXT NOT NULL, answer TEXT NOT NULL, feedback TEXT NOT NULL CHECK(json_valid(feedback)),
 created_at TEXT NOT NULL, PRIMARY KEY(session_id,position)
) STRICT;

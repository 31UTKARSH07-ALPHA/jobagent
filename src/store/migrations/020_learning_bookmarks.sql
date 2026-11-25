CREATE TABLE learning_bookmarks (
 plan_id INTEGER NOT NULL REFERENCES learning_plans(id) ON DELETE CASCADE,
 item_id TEXT NOT NULL,
 PRIMARY KEY(plan_id,item_id)
) STRICT;

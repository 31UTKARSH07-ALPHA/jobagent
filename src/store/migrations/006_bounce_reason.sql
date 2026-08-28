-- Why a message failed, not just that it did.
--
-- A bounce and a bounce are not the same thing, and the difference is the only spam signal a
-- sender can actually obtain. `550 5.1.1 user unknown` means the address-finding was wrong —
-- fix the cascade. `550 5.7.1 blocked` or "message rejected as spam" means the address was
-- fine and the *sending* is the problem — fix reputation, content or volume. Lumping them
-- together as `bounced_at` would average away the distinction and leave both undiagnosable.
--
-- A 4.x.x deferral is neither: the receiving server is asking us to come back later. It is
-- recorded so a run of them is visible, but it never marks the job BOUNCED, because that
-- state is terminal and a temporary failure is not.

ALTER TABLE outreach ADD COLUMN bounce_reason TEXT;

-- Set the first time we see a reply, a bounce or a deferral for this row, so the tracker can
-- skip rows it has already resolved without re-reading the mailbox.
ALTER TABLE outreach ADD COLUMN tracked_at TEXT;

CREATE INDEX outreach_tracking_idx ON outreach(sent_at) WHERE sent_at IS NOT NULL;

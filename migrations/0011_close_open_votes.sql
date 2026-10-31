-- The vote is gone, so a vote still running can never end. Nothing is re-judged:
-- those receipts never count and go back to being free to log. A draft the old
-- check flagged goes too, because the new code can't tell it was flagged and Log
-- it would count it. Clearing `vote` is what frees the unique index. Old code
-- reads this as a removed log, and a tap on its buttons as a vote that's over.
-- Safe to run again, and it has to be run again once the new Worker is live: the
-- old one keeps serving between this step and that one, and can open a vote.
UPDATE bills
SET status = 'deleted', vote = NULL, photo_urls = NULL, revision = revision + 1
WHERE vote = 'open' OR (kind = 'log' AND status = 'draft' AND photo_urls IS NOT NULL);

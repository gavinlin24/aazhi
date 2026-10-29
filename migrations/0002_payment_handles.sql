-- One row per way a person can be paid. Keyed on the Discord user rather than
-- a bill, so a handle set once is offered on every bill that person pays for.
CREATE TABLE payment_handles (
  user_id    TEXT NOT NULL,
  method     TEXT NOT NULL CHECK (method IN ('venmo', 'cashapp', 'zelle')),
  -- Stored normalised (no leading @ or $, Zelle phone as ten digits), and only
  -- after validation, so it is always safe to put in a link.
  handle     TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, method)
);

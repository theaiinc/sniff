-- sniff: topics to listen for, the posts found, and settings (profile,
-- communities, run bookkeeping). Starts empty: fill in the profile and add
-- topics from the web page or the API.

CREATE TABLE topics (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  query       TEXT NOT NULL,                -- search terms; "a OR b" searches each term
  sources     TEXT NOT NULL DEFAULT 'reddit,hn,stackexchange',
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE posts (
  id           TEXT PRIMARY KEY,
  source       TEXT NOT NULL,               -- reddit | hn | stackexchange
  external_id  TEXT NOT NULL,
  topic_id     TEXT,
  url          TEXT NOT NULL,
  title        TEXT,
  body         TEXT,                        -- excerpt
  author       TEXT,
  community    TEXT,                        -- r/name, Hacker News, Stack Overflow
  posted_at    TEXT NOT NULL,
  score        INTEGER,
  comments     INTEGER,
  -- AI reading (null until rated)
  relevance    INTEGER,                     -- 0-100: how welcome a reply from you would be
  intent       TEXT,                        -- asking_for_tool | problem | discussion | job | promotion | other
  summary      TEXT,
  pain_points  TEXT,                        -- JSON array of short phrases
  reply_draft  TEXT,
  status       TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'seen', 'replied', 'dismissed')),
  status_at    TEXT,
  fetched_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (source, external_id)
);
CREATE INDEX idx_posts_posted ON posts(posted_at);
CREATE INDEX idx_posts_status ON posts(status, relevance);
CREATE INDEX idx_posts_unrated ON posts(relevance) WHERE relevance IS NULL;

CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value_json  TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

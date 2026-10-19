-- How well the job fitted the resume when the bot looked at it (0-100, see server/src/match.js).
alter table public.applications add column if not exists match_score smallint
  check (match_score is null or match_score between 0 and 100);

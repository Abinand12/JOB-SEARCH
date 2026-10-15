-- Job Autopilot schema. Run once in the Supabase SQL editor (or `supabase db push`).
-- The Railway server talks to these tables with the service-role key; the RLS
-- policies below only matter for the dashboard's direct Realtime subscriptions.

create extension if not exists pgcrypto;

-- One row per user: the parsed resume profile plus bot settings.
create table if not exists public.profiles (
  user_id         uuid primary key references auth.users (id) on delete cascade,
  data            jsonb not null default '{}'::jsonb,   -- structured profile (see server/src/profile.js)
  settings        jsonb not null default '{}'::jsonb,   -- bot settings (daily limit, filters, auto-submit, ...)
  resume_text     text,
  resume_path     text,                                 -- object path in the "resumes" storage bucket
  resume_filename text,
  resume_mime     text,
  updated_at      timestamptz not null default now()
);

-- Long-lived tokens the Chrome extension uses to call the API. Only the hash is stored.
create table if not exists public.extension_tokens (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  token_hash   text not null unique,
  label        text,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz
);
create index if not exists extension_tokens_user_idx on public.extension_tokens (user_id);

-- Every job the bot touched.
create table if not exists public.applications (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users (id) on delete cascade,
  job_url            text not null,
  job_title          text,
  company            text,
  location           text,
  source             text not null default 'linkedin',    -- where the job was found
  method             text not null default 'easy_apply'
                       check (method in ('easy_apply', 'external_autofill', 'manual_assist')),
  ats                text,                                -- linkedin, greenhouse, lever, workday, ...
  status             text not null default 'in_progress'
                       check (status in ('in_progress', 'submitted', 'needs_verification',
                                         'needs_review', 'failed', 'skipped')),
  failure_reason     text,
  questions_answered integer not null default 0,
  llm_answers        integer not null default 0,
  started_at         timestamptz not null default now(),
  submitted_at       timestamptz,
  updated_at         timestamptz not null default now(),
  unique (user_id, job_url)
);
create index if not exists applications_user_started_idx on public.applications (user_id, started_at desc);
create index if not exists applications_user_status_idx on public.applications (user_id, status);

-- Bot verification (CAPTCHA / login wall) the user must clear by hand.
create table if not exists public.verification_alerts (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users (id) on delete cascade,
  application_id uuid references public.applications (id) on delete set null,
  kind           text not null,                       -- recaptcha, hcaptcha, turnstile, arkose, login_required, ...
  page_url       text,
  page_title     text,
  status         text not null default 'open' check (status in ('open', 'resolved', 'expired')),
  created_at     timestamptz not null default now(),
  resolved_at    timestamptz
);
create index if not exists verification_alerts_user_status_idx on public.verification_alerts (user_id, status);

-- Answers to screening questions, reused across applications so each question
-- costs at most one LLM call. Users can review and correct them in the dashboard.
create table if not exists public.question_answers (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  question_key text not null,                         -- normalized question text
  question     text not null,
  answer       text not null,
  field_type   text,
  source       text not null default 'llm' check (source in ('llm', 'user')),
  needs_review boolean not null default true,
  times_used   integer not null default 1,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (user_id, question_key)
);

-- Token usage per LLM call, so the dashboard can show what the bot costs.
create table if not exists public.llm_usage (
  id            bigserial primary key,
  user_id       uuid not null references auth.users (id) on delete cascade,
  provider      text not null,
  model         text not null,
  purpose       text not null,                        -- resume_parse, answers
  input_tokens  integer not null default 0,
  output_tokens integer not null default 0,
  created_at    timestamptz not null default now()
);
create index if not exists llm_usage_user_created_idx on public.llm_usage (user_id, created_at desc);

-- Row level security: users can only read their own rows.
alter table public.profiles            enable row level security;
alter table public.extension_tokens    enable row level security;
alter table public.applications        enable row level security;
alter table public.verification_alerts enable row level security;
alter table public.question_answers    enable row level security;
alter table public.llm_usage           enable row level security;

drop policy if exists "own profile" on public.profiles;
create policy "own profile" on public.profiles for select using (auth.uid() = user_id);
drop policy if exists "own applications" on public.applications;
create policy "own applications" on public.applications for select using (auth.uid() = user_id);
drop policy if exists "own alerts" on public.verification_alerts;
create policy "own alerts" on public.verification_alerts for select using (auth.uid() = user_id);
drop policy if exists "own answers" on public.question_answers;
create policy "own answers" on public.question_answers for select using (auth.uid() = user_id);
drop policy if exists "own usage" on public.llm_usage;
create policy "own usage" on public.llm_usage for select using (auth.uid() = user_id);
-- extension_tokens deliberately has no policy: only the server (service role) reads it.

-- Live updates for the dashboard (new verification alerts, application status changes).
do $$
begin
  alter publication supabase_realtime add table public.verification_alerts;
exception when duplicate_object then null;
end $$;
do $$
begin
  alter publication supabase_realtime add table public.applications;
exception when duplicate_object then null;
end $$;

-- Private bucket for resume files.
insert into storage.buckets (id, name, public)
values ('resumes', 'resumes', false)
on conflict (id) do nothing;

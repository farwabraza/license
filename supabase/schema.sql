-- STRADA schema v2. Paste the whole file into Supabase → SQL Editor → Run.
-- The app talks to Supabase only from the server with the service key, so RLS is not used.

create table if not exists topics (
  id        text primary key,
  ord       int not null,
  slug      text not null,
  title_it  text not null,
  title_en  text not null
);

create table if not exists subtopics (
  id             text primary key,
  topic_id       text not null references topics(id),
  ord            int not null,
  slug           text not null,
  title_it       text not null,
  title_en       text not null,
  narration      text,
  terms          jsonb not null default '[]',
  image_url      text,
  audio_url      text,
  question_count int not null default 0
);
create index if not exists subtopics_topic on subtopics(topic_id, ord);

create table if not exists questions (
  id           text primary key,
  subtopic_id  text not null references subtopics(id),
  topic_id     text not null references topics(id),
  ord          int not null,
  q_it         text not null,
  answer       boolean not null,
  image_url    text,
  q_en         text,
  trap_words   jsonb not null default '[]',
  trap_type    text not null default 'none',
  why_en       text,
  reform_check boolean not null default false
);
create index if not exists questions_sub on questions(subtopic_id, ord);
create index if not exists questions_topic on questions(topic_id);

-- one row per distinct Italian exam word, across the whole course
create table if not exists terms (
  id           text primary key,
  it           text not null,
  en           text not null,
  note         text,
  topic_id     text not null references topics(id),
  subtopic_ids jsonb not null default '[]'
);
create index if not exists terms_topic on terms(topic_id);

-- Leitner box per official question per user
create table if not exists progress (
  user_id     text not null,
  question_id text not null references questions(id),
  box         int not null default 0,
  streak      int not null default 0,
  seen        int not null default 0,
  wrong       int not null default 0,
  last_seen   timestamptz,
  due         timestamptz not null default now(),
  primary key (user_id, question_id)
);
create index if not exists progress_due on progress(user_id, due);

-- Leitner box per word per user
create table if not exists term_progress (
  user_id   text not null,
  term_id   text not null references terms(id),
  box       int not null default 0,
  streak    int not null default 0,
  seen      int not null default 0,
  wrong     int not null default 0,
  last_seen timestamptz,
  due       timestamptz not null default now(),
  primary key (user_id, term_id)
);
create index if not exists term_progress_due on term_progress(user_id, due);

-- stage progress per stop: Teach → Review → Quiz
create table if not exists subtopic_progress (
  user_id       text not null,
  subtopic_id   text not null references subtopics(id),
  lesson_done   boolean not null default false,
  review_done   boolean not null default false,
  quiz_passed   boolean not null default false,
  best_accuracy int,
  attempts      int not null default 0,
  updated_at    timestamptz not null default now(),
  primary key (user_id, subtopic_id)
);

create table if not exists sessions (
  id          uuid primary key default gen_random_uuid(),
  user_id     text not null,
  kind        text not null,            -- quiz | review_stage | topic_test | repair | exam | review | words
  ref_id      text,                     -- subtopic id for quiz/review_stage, topic id for topic_test
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  correct     int,
  total       int,
  passed      boolean,
  detail      jsonb
);
create index if not exists sessions_user on sessions(user_id, kind, started_at desc);

create table if not exists tutor_cache (
  question_id text not null references questions(id),
  user_answer boolean not null,
  answer_en   text not null,
  created_at  timestamptz not null default now(),
  primary key (question_id, user_answer)
);

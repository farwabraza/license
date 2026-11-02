-- One-off: score each stop from your most recent finished topic run (topic questions), as the app now does when a
-- run finishes. Paste into Supabase → SQL Editor → Run, in the project the STRADA app uses.
-- Each stop gets one quiz attempt from its own first-try score (its questions minus the ones missed in the run):
-- best accuracy kept, passed at 90%, lesson marked done. A stop with an attempt is open in the app from then on.
-- Safe to run twice: the session it used is marked stops_backfilled and is skipped after that.

with run as (                                   -- the latest finished topic run not yet used
  select id, user_id, ref_id as topic_id, coalesce(detail->'missed', '[]'::jsonb) as missed
  from sessions
  where kind = 'marathon' and finished_at is not null
    and coalesce((detail->>'stops_backfilled')::boolean, false) = false
  order by finished_at desc
  limit 1
), per_stop as (
  select run.user_id, q.subtopic_id,
         count(*) as total,
         count(*) filter (where not run.missed ? q.id) as correct
  from run join questions q on q.topic_id = run.topic_id
  group by run.user_id, q.subtopic_id
), scored as (
  select user_id, subtopic_id, round(100.0 * correct / total)::int as acc from per_stop
), upserted as (
  insert into subtopic_progress as p (user_id, subtopic_id, lesson_done, review_done, quiz_passed, best_accuracy, attempts, updated_at)
  select user_id, subtopic_id, true, false, acc >= 90, acc, 1, now() from scored
  on conflict (user_id, subtopic_id) do update set
    lesson_done   = true,
    quiz_passed   = p.quiz_passed or excluded.quiz_passed,
    best_accuracy = greatest(coalesce(p.best_accuracy, 0), excluded.best_accuracy),
    attempts      = p.attempts + 1,
    updated_at    = now()
  returning subtopic_id, quiz_passed, best_accuracy, attempts
), marked as (
  update sessions set detail = coalesce(detail, '{}'::jsonb) || '{"stops_backfilled": true}'::jsonb
  where id = (select id from run)
)
select s.ord as stop, s.title_en, sc.acc as run_pct, u.best_accuracy, u.quiz_passed, u.attempts
from upserted u join subtopics s on s.id = u.subtopic_id join scored sc on sc.subtopic_id = u.subtopic_id
order by s.ord;

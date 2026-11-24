-- Product metrics over the D1 `events` log. Run with:
--   npx wrangler d1 execute wiki-reels-app --remote --file docs/metrics.sql
-- Each query is independent; ts is in milliseconds.

-- Completion, likes, Not interested, by day and A/B bucket parity.
SELECT date(ts / 1000, 'unixepoch') AS day,
       bucket % 2 AS arm,
       count(*) AS views,
       round(avg(1.0 * pages_seen / n_pages), 3) AS completion,
       round(avg(liked), 3) AS like_rate,
       round(avg(not_interested + less_topic), 3) AS negative_rate,
       round(avg(reward), 3) AS mean_reward
FROM events
WHERE ts > (unixepoch() - 14 * 86400) * 1000 AND mode = 'feed'
GROUP BY day, arm ORDER BY day, arm;

-- Sessions (30-minute gap): reels per session and distinct fields per session.
WITH ordered AS (
  SELECT user_id, ts, field,
         CASE WHEN ts - lag(ts) OVER (PARTITION BY user_id ORDER BY ts) > 1800000 THEN 1 ELSE 0 END AS new_session
  FROM events WHERE ts > (unixepoch() - 7 * 86400) * 1000
), numbered AS (
  SELECT *, sum(new_session) OVER (PARTITION BY user_id ORDER BY ts) AS session FROM ordered
)
SELECT round(avg(n), 1) AS reels_per_session, round(avg(fields), 2) AS fields_per_session
FROM (SELECT user_id, session, count(*) AS n, count(DISTINCT field) AS fields FROM numbered GROUP BY user_id, session);

-- Exploration hit rate: share of explore picks with positive reward, vs exploit picks.
SELECT reason, count(*) AS n, round(avg(reward > 0), 3) AS hit_rate, round(avg(reward), 3) AS mean_reward
FROM events WHERE reason IS NOT NULL AND ts > (unixepoch() - 7 * 86400) * 1000
GROUP BY reason ORDER BY n DESC;

-- Day-1 and day-7 return of new users (cohort = first-seen day).
SELECT date(u.created_at / 1000, 'unixepoch') AS cohort,
       count(*) AS users,
       round(avg(EXISTS (SELECT 1 FROM events e WHERE e.user_id = u.id
                         AND e.ts BETWEEN u.created_at + 86400000 AND u.created_at + 2 * 86400000)), 3) AS d1_return,
       round(avg(EXISTS (SELECT 1 FROM events e WHERE e.user_id = u.id
                         AND e.ts BETWEEN u.created_at + 7 * 86400000 AND u.created_at + 8 * 86400000)), 3) AS d7_return
FROM users u
WHERE u.created_at > (unixepoch() - 30 * 86400) * 1000
GROUP BY cohort ORDER BY cohort;

-- Return after a reset: users whose profile_version increased, and whether they kept watching afterwards.
SELECT count(*) AS reset_users,
       round(avg(after_views >= 10), 3) AS kept_watching
FROM (
  SELECT user_id, sum(profile_version = max_v) AS after_views
  FROM (SELECT user_id, profile_version, max(profile_version) OVER (PARTITION BY user_id) AS max_v FROM events)
  GROUP BY user_id HAVING max(max_v) > 1
);

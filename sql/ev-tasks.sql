/*======================================================================
  EV Tasks (ev-bot) — cards waiting for an estimated value
  Snowflake APP_PROD. Same card columns as question 4131 (so ev-bot reads
  them the same way), limited to cards with an OPEN estimate_value task.

  Source of "waiting": APP_PROD.ADMIN.TASKS, skill_kind = 'estimate_value'
  (the same task 4131 uses for ESTIMATED_VALUE_DATE).
  ⚠ CONFIRM the "still open" condition (marked below) with the check query
    at the bottom before saving — it may be finished_at, a status, or both.

  No {{filters}}: ev-bot pulls the whole list and narrows it itself.
  Not limited to the Arena warehouse user: customer submissions waiting for
  an estimate show too. Add the 4131 user_id / status lines to restrict.
  NOTE: "INSERT" is a reserved word — keep it double-quoted.
  ======================================================================*/
SELECT
  'https://admin.arenaclub.com/cards/' || cards.id || '/estimate-value' AS card_url,
  cards.front_slab_picture_url,
  cards.sport,
  cards.set_name,
  cards."INSERT"                                AS "INSERT",
  cards.player_name,
  cards.set_number,                             -- card # (e.g. OP16-098, US189)
  cards.parallel_name,
  cards.parallel_total,
  cards.grading_company,
  cards.grading_company || ' ' || cards.overall AS grade,
  cards.estimated_value_cents / 100             AS estimated_value,
  cards.last_comp_value_cents / 100             AS last_comp,      -- NULL = last comp required on first pass
  cards.status                                  AS item_status,
  ccert.cert_number                             AS cert_number,
  cards.number                                  AS "8ac_number",
  cards.storage_bin_id,
  cards.storage_bin_slot,
  t.requested_at,
  cards.id                                      AS item_id
FROM (SELECT * FROM APP_PROD.ADMIN.CARDS WHERE NOT COALESCE(_SNOWFLAKE_DELETED, FALSE)) cards
INNER JOIN (
  SELECT
    card_id,
    MIN(created_at) AS requested_at
  FROM APP_PROD.ADMIN.TASKS
  WHERE skill_kind = 'estimate_value'
    AND NOT COALESCE(_SNOWFLAKE_DELETED, FALSE)
    AND finished_at IS NULL                     -- ⚠ CONFIRM: the "still open" condition
  GROUP BY card_id
) t ON t.card_id = cards.id
LEFT JOIN (SELECT * FROM APP_PROD.ADMIN.CARD_CERT_NUMBER WHERE NOT COALESCE(_SNOWFLAKE_DELETED, FALSE)) ccert
       ON ccert.card_id = cards.id
WHERE cards.status NOT IN ('shipped', 'archived')
ORDER BY t.requested_at
LIMIT 5000;

/*----------------------------------------------------------------------
  CHECK QUERY — run this first (separately) to see which column marks an
  open estimate_value task. Compare a task you know is still waiting with
  one that's done: whichever column is empty/different on the waiting one
  (finished_at, status, completed_at…) is the "still open" condition above.

  SELECT *
  FROM APP_PROD.ADMIN.TASKS
  WHERE skill_kind = 'estimate_value'
    AND NOT COALESCE(_SNOWFLAKE_DELETED, FALSE)
  ORDER BY created_at DESC
  LIMIT 50;
----------------------------------------------------------------------*/

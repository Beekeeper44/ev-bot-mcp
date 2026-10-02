/*======================================================================
  Card inventory (split schema) — Snowflake APP_PROD
  CHANGE 2026-08-12: tag now reads public.items ONLY (COALESCE fallback to
  admin.cards."tag" removed, in BOTH the SELECT and the {{tag}} filter).
  Per arena-data-mappings: `tag` is admin-WRITTEN but READ from public.items.

  CHANGE 2026-09-02a: added GRADING_COMPANY column + filters for
  {{set_name}}, {{player_name}}, {{parallel_name}}, {{grading_company}},
  {{grade}}. All are ADMIN-owned catalog/grade columns per
  column-ownership.md, so they filter off admin.cards, not public.items.

  CHANGE 2026-09-02b: scope to cards physically in the warehouse.
  public.items.status is a DIFFERENT field from admin.cards.status
  (column-ownership.md) and is the fresh consumer-side owner. Excluding
  'in_marketplace' (listed for sale) and 'retrieved' (customer pulled it);
  'retrieved' is also what every pending_shipping card carries.
  Row impact: 193,738 -> ~110,050.

  CHANGE 2026-09-10: added EV_AGE_DAYS — days between the EV date
  (ESTIMATED_VALUE_DATE) and today. Dates are taken under the LA session
  (ts::timestamp) and CURRENT_DATE is session-tz, so both sides are LA
  dates; no CONVERT_TIMEZONE needed. Optional {{min_ev_age_days}} /
  {{max_ev_age_days}} filters live in the OUTER WHERE — the alias is not
  referenceable in the inner WHERE.

  CHANGE 2026-09-11: added TIMES_SOLD_BACK — distinct repack purchases the
  card has been in (public.repack_purchase_items.item_id = cards.id, joined
  to repack_purchases where category='card'). COUNT(DISTINCT rp.id) so a
  duplicated purchase-item line can't double-count. Never NULL. Optional
  {{min_times_sold_back}} filter in the OUTER WHERE.

  CHANGE 2026-09-28: added ITEM_ID (last column) — cards.id, which is the
  same UUID as public.items.id.

  CHANGE 2026-09-30: added SET_NUMBER — the card number printed on the card
  (e.g. US189), from admin.cards.set_number. Optional {{set_number}} filter:
  contains-match, case-insensitive, ignores a leading '#'.

  CHANGE 2026-10-01: ESTIMATED_VALUE_DATE / EV_AGE_DAYS now mean "when the
  EV was last APPROVED" — an approval or a recomp on the estimate-value page
  (or ev-bot). Source: the newest admin.estimated_value record with
  grading_task_status = 'approved' (finished_at, else created_at).
  Before, they used the estimate_value TASK's created_at, which is when the
  card entered the EV queue and never moved on a recomp.
  Cards with no approved record fall back to the old task date;
  EV_DATE_SOURCE says which one you're looking at ('approved' | 'task').
  Also added LAST_COMP — last comp on that same approved record (ev-bot uses
  it to know which cards still need a last comp).

  NOTE: "tag"/"INSERT" are reserved words — keep them double-quoted.
  ======================================================================*/
SELECT
  "SOURCE"."CARD_URL"               AS "CARD_URL",
  "SOURCE"."FRONT_SLAB_PICTURE_URL" AS "FRONT_SLAB_PICTURE_URL",
  "SOURCE"."SPORT"                  AS "SPORT",
  "SOURCE"."SET_NAME"               AS "SET_NAME",
  "SOURCE"."SET_NUMBER"             AS "SET_NUMBER",
  "SOURCE"."INSERT"                 AS "INSERT",
  "SOURCE"."PLAYER_NAME"            AS "PLAYER_NAME",
  "SOURCE"."PARALLEL_NAME"          AS "PARALLEL_NAME",
  "SOURCE"."PARALLEL_TOTAL"         AS "PARALLEL_TOTAL",
  "SOURCE"."GRADING_COMPANY"        AS "GRADING_COMPANY",
  "SOURCE"."GRADE"                  AS "GRADE",
  "SOURCE"."ESTIMATED_VALUE_DATE"   AS "ESTIMATED_VALUE_DATE",
  "SOURCE"."EV_DATE_SOURCE"         AS "EV_DATE_SOURCE",
  "SOURCE"."EV_AGE_DAYS"            AS "EV_AGE_DAYS",
  "SOURCE"."ESTIMATED_VALUE"        AS "ESTIMATED_VALUE",
  "SOURCE"."LAST_COMP"              AS "LAST_COMP",
  "SOURCE"."NUMBER"                 AS "NUMBER",
  "SOURCE"."TAG"                    AS "TAG",
  "SOURCE"."ITEM_STATUS"            AS "ITEM_STATUS",
  "SOURCE"."TIMES_SOLD_BACK"        AS "TIMES_SOLD_BACK",
  "SOURCE"."CERT_NUMBER"            AS "CERT_NUMBER",
  "SOURCE"."8ac_number"             AS "8ac_number",
  "SOURCE"."STORAGE_BIN_ID"         AS "STORAGE_BIN_ID",
  "SOURCE"."STORAGE_BIN_SLOT"       AS "STORAGE_BIN_SLOT",
  "SOURCE"."PURCHASE_COST"          AS "PURCHASE_COST",
  "SOURCE"."PURCHASE_LOCATION"      AS "PURCHASE_LOCATION",
  "SOURCE"."PO_NUMBER"              AS "PO_NUMBER",
  "SOURCE"."ITEM_ID"                AS "ITEM_ID"
FROM (
  SELECT
    'https://admin.arenaclub.com/cards/' || cards.id || '/estimate-value' AS card_url,
    cards.front_slab_picture_url,
    cards.card_type_id || '-' || cards.parallel_id AS card_type_parallel_id,
    cards.sport,
    cards.team,
    cards.set_name,
    cards.set_number::text                        AS set_number,
    cards."INSERT" AS "INSERT",
    cards.player_name,
    cards.parallel_name,
    cards.parallel_total,
    cards.grading_company                         AS grading_company,
    cards.grading_company || ' ' || cards.overall AS grade,
    -- 2026-10-01: last approval / recomp date; old task date only if never approved
    COALESCE(eva.ev_approved_date, ev.ac_comp_date) AS estimated_value_date,
    CASE WHEN eva.ev_approved_date IS NOT NULL THEN 'approved'
         WHEN ev.ac_comp_date      IS NOT NULL THEN 'task' END AS ev_date_source,
    DATEDIFF('day', COALESCE(eva.ev_approved_date, ev.ac_comp_date), CURRENT_DATE) AS ev_age_days,
    cards.estimated_value_cents / 100             AS estimated_value,
    -- 2026-10-01: last comp from the same approved estimate record
    eva.last_comp                                 AS last_comp,
    spa.purchase_cost_cents / 100                 AS purchase_cost,
    admin_orders.purchase_location                AS purchase_location,
    pm.po_number                                  AS po_number,
    orders.number,
    cards__i."TAG"                                AS "TAG",
    cards__i.status                               AS item_status,
    COALESCE(rc.repack_count, 0)                  AS times_sold_back,
    ccert.cert_number                             AS cert_number,
    cards.number                                  AS "8ac_number",
    cards.storage_bin_id,
    cards.storage_bin_slot,
    cards.id                                      AS item_id
  FROM (SELECT * FROM APP_PROD.ADMIN.CARDS WHERE NOT COALESCE(_SNOWFLAKE_DELETED, FALSE)) cards
  LEFT JOIN (SELECT * FROM APP_PROD.PUBLIC.ITEMS WHERE NOT COALESCE(_SNOWFLAKE_DELETED, FALSE)) cards__i ON cards__i.id = cards.id AND cards__i.category = 'card'  -- tag + status owner
  INNER JOIN (SELECT * FROM APP_PROD.PUBLIC.USERS WHERE NOT COALESCE(_SNOWFLAKE_DELETED, FALSE)) users  ON cards.user_id  = users.id
  INNER JOIN (SELECT * FROM APP_PROD.PUBLIC.CATEGORY_ORDERS WHERE NOT COALESCE(_SNOWFLAKE_DELETED, FALSE)) orders ON cards.order_id = orders.id
  INNER JOIN (SELECT * FROM APP_PROD.ADMIN.ORDERS WHERE NOT COALESCE(_SNOWFLAKE_DELETED, FALSE)) admin_orders ON admin_orders.id = orders.id
  LEFT JOIN (SELECT ica.*, coi.category_order_id AS buy_order_id
          FROM (SELECT * FROM APP_PROD.PUBLIC.ITEM_COST_ACCOUNTING WHERE NOT COALESCE(_SNOWFLAKE_DELETED, FALSE)) ica
          LEFT JOIN (SELECT * FROM APP_PROD.PUBLIC.CATEGORY_ORDER_ITEMS WHERE NOT COALESCE(_SNOWFLAKE_DELETED, FALSE)) coi ON coi.id = ica.buy_order_item_id) spa
         ON spa.item_id = cards.id
        AND spa.buy_order_id = orders.id
  LEFT JOIN (SELECT * FROM APP_PROD.ADMIN.CARD_CERT_NUMBER WHERE NOT COALESCE(_SNOWFLAKE_DELETED, FALSE)) ccert
         ON ccert.card_id = cards.id
  LEFT JOIN (
    SELECT
      poi.order_id,
      MAX(po.number) AS po_number
    FROM (SELECT * FROM APP_PROD.ADMIN.PURCHASE_ORDER_ITEMS WHERE NOT COALESCE(_SNOWFLAKE_DELETED, FALSE)) poi
    JOIN (SELECT * FROM APP_PROD.ADMIN.PURCHASE_ORDERS WHERE NOT COALESCE(_SNOWFLAKE_DELETED, FALSE)) po
      ON po.id = poi.purchase_order_id
    GROUP BY poi.order_id
  ) pm ON pm.order_id = orders.id
  LEFT JOIN (
    SELECT
      rpi.item_id           AS card_id,
      COUNT(DISTINCT rp.id) AS repack_count
    FROM (SELECT * FROM APP_PROD.PUBLIC.REPACK_PURCHASE_ITEMS WHERE NOT COALESCE(_SNOWFLAKE_DELETED, FALSE)) rpi
    JOIN (SELECT * FROM APP_PROD.PUBLIC.REPACK_PURCHASES WHERE NOT COALESCE(_SNOWFLAKE_DELETED, FALSE)) rp
      ON rp.id = rpi.repack_purchase_id
     AND rp.category = 'card'
    GROUP BY rpi.item_id
  ) rc ON rc.card_id = cards.id
  LEFT JOIN (
    /* NEW 2026-10-01: newest LIVE estimate per card — the newest "approved" or
       "done_skip_verify" (recomp) box on the admin estimate-value page. Timestamps are timestamptz; under the LA session
       ::timestamp is already LA, same as the task date below. */
    SELECT card_id, ev_approved_date, last_comp
    FROM (
      SELECT
        card_id,
        COALESCE(finished_at, created_at)::timestamp::date AS ev_approved_date,
        last_comp_value_cents / 100                         AS last_comp,
        ROW_NUMBER() OVER (
          PARTITION BY card_id
          ORDER BY COALESCE(finished_at, created_at) DESC, created_at DESC, id DESC
        ) AS rn
      FROM APP_PROD.ADMIN.ESTIMATED_VALUE
      WHERE NOT COALESCE(_SNOWFLAKE_DELETED, FALSE)
        -- live values: approvals AND recomps saved with skip-verify
        AND grading_task_status IN ('approved', 'done_skip_verify')
    ) x
    WHERE rn = 1
  ) eva ON eva.card_id = cards.id
  LEFT JOIN (
    /* fallback only (cards never approved): when the estimate_value task was created */
    SELECT
      card_id,
      MAX(created_at::timestamp)::date AS ac_comp_date
    FROM APP_PROD.ADMIN.TASKS
    WHERE skill_kind = 'estimate_value'
    GROUP BY card_id
  ) ev ON ev.card_id = cards.id
  WHERE
    cards.user_id = '00838bfd-7979-41bd-81f5-c6777c32d6c4'
    AND admin_orders.ready_to_reveal_email_sent_at IS NOT NULL
    AND cards.status NOT IN ('shipped', 'archived')
    AND COALESCE(cards__i.status, 'hidden') NOT IN ('in_marketplace', 'retrieved')
    [[AND LOWER(cards.sport) ILIKE '%' || LOWER({{sport}}) || '%']]
    [[AND LOWER(cards__i."TAG") ILIKE '%' || LOWER({{tag}}) || '%']]
    [[AND LOWER(cards.set_name)        ILIKE '%' || LOWER({{set_name}})        || '%']]
    [[AND LOWER(cards.player_name)     ILIKE '%' || LOWER({{player_name}})     || '%']]
    [[AND LOWER(cards.parallel_name)   ILIKE '%' || LOWER({{parallel_name}})   || '%']]
    [[AND LOWER(cards.grading_company) ILIKE '%' || LOWER({{grading_company}}) || '%']]
    [[AND LOWER(NVL(cards.grading_company, '') || ' ' || NVL(cards.overall::text, ''))
          ILIKE '%' || LOWER({{grade}}) || '%']]
    [[AND cards.estimated_value_cents >= FLOOR({{min_estimated_value}} * 100)]]
    [[AND cards.estimated_value_cents <= CEIL({{max_estimated_value}}  * 100)]]
    [[AND ccert.cert_number::text ILIKE '%' || {{cert_number}} || '%']]
    [[AND cards.number::text ILIKE '%' || {{ac_number}} || '%']]
    [[AND LOWER(LTRIM(cards.set_number::text, '#')) ILIKE '%' || LOWER(LTRIM({{set_number}}, '#')) || '%']]
) AS "SOURCE"
WHERE 1 = 1
  [[AND "SOURCE"."EV_AGE_DAYS" >= {{min_ev_age_days}}]]
  [[AND "SOURCE"."EV_AGE_DAYS" <= {{max_ev_age_days}}]]
  [[AND "SOURCE"."TIMES_SOLD_BACK" >= {{min_times_sold_back}}]]
ORDER BY "SOURCE"."8ac_number" DESC
LIMIT 1048575;

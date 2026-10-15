/*======================================================================
  ev-bot · Order cards (fast) — every card in one order, customers' included.
  Snowflake APP_PROD. Same columns as before, so ev-bot needs no code change.
  Paste into the question EV_ORDERS_CARD_ID points to (default 44123).
  order_number is REQUIRED (Text) — ev-bot always sends it.
  - Finds the order number in PUBLIC.CATEGORY_ORDERS, PUBLIC.ORDERS and ADMIN.ORDERS
    (the old version only looked in CATEGORY_ORDERS, so PO / Arena Club orders never matched).
  - Cards via ADMIN.CARDS.order_id plus ADMIN.ORDER_ITEMS.
  - Every lookup is filtered to this order's ids first; no SELECT *.
  NOTE: "INSERT"/"TAG" are reserved words — keep them double-quoted.
  ======================================================================*/
WITH
ord AS (
  SELECT id, number FROM APP_PROD.PUBLIC.CATEGORY_ORDERS
  WHERE  number = TRY_TO_NUMBER(LTRIM(TRIM({{order_number}}), '#')) AND NOT COALESCE(_SNOWFLAKE_DELETED, FALSE)
  UNION
  SELECT id, number FROM APP_PROD.PUBLIC.ORDERS
  WHERE  number = TRY_TO_NUMBER(LTRIM(TRIM({{order_number}}), '#')) AND NOT COALESCE(_SNOWFLAKE_DELETED, FALSE)
  UNION
  SELECT id, number FROM APP_PROD.ADMIN.ORDERS
  WHERE  number = TRY_TO_NUMBER(LTRIM(TRIM({{order_number}}), '#')) AND NOT COALESCE(_SNOWFLAKE_DELETED, FALSE)
),
o AS (
  SELECT id, MAX(number) AS number FROM ord GROUP BY id
),
links AS (
  SELECT id AS card_id, order_id
  FROM   APP_PROD.ADMIN.CARDS
  WHERE  order_id IN (SELECT id FROM o) AND NOT COALESCE(_SNOWFLAKE_DELETED, FALSE)
  UNION
  SELECT card_id, order_id
  FROM   APP_PROD.ADMIN.ORDER_ITEMS
  WHERE  order_id IN (SELECT id FROM o) AND card_id IS NOT NULL AND NOT COALESCE(_SNOWFLAKE_DELETED, FALSE)
),
lk AS (
  SELECT card_id, MIN(order_id) AS order_id FROM links GROUP BY card_id
)
SELECT
  'https://admin.arenaclub.com/cards/' || cards.id || '/estimate-value' AS card_url,
  cards.front_slab_picture_url,
  cards.sport,
  cards.set_name,
  cards.set_number::text                        AS set_number,
  cards."INSERT"                                AS "INSERT",
  cards.player_name,
  cards.parallel_name,
  cards.parallel_total,
  cards.grading_company,
  cards.grading_company || ' ' || cards.overall AS grade,
  cards.estimated_value_cents / 100             AS estimated_value,
  o.number::text                                AS order_number,
  o.number                                      AS number,
  i."TAG"                                       AS "TAG",
  i.status                                      AS item_status,
  cards.status                                  AS card_status,
  u.email                                       AS owner_email,
  cc.cert_number                                AS cert_number,
  cards.number                                  AS "8ac_number",
  cards.storage_bin_id,
  cards.storage_bin_slot,
  cards.id                                      AS item_id
FROM lk
JOIN o ON o.id = lk.order_id
JOIN APP_PROD.ADMIN.CARDS cards
  ON cards.id = lk.card_id AND NOT COALESCE(cards._SNOWFLAKE_DELETED, FALSE)
LEFT JOIN (SELECT id, "TAG", status FROM APP_PROD.PUBLIC.ITEMS
           WHERE id IN (SELECT card_id FROM lk) AND category = 'card'
             AND NOT COALESCE(_SNOWFLAKE_DELETED, FALSE)) i ON i.id = cards.id
LEFT JOIN (SELECT id, email FROM APP_PROD.PUBLIC.USERS
           WHERE NOT COALESCE(_SNOWFLAKE_DELETED, FALSE)) u ON u.id = cards.user_id
LEFT JOIN (SELECT card_id, cert_number FROM APP_PROD.ADMIN.CARD_CERT_NUMBER
           WHERE card_id IN (SELECT card_id FROM lk)
             AND NOT COALESCE(_SNOWFLAKE_DELETED, FALSE)) cc ON cc.card_id = cards.id
ORDER BY cards.number;

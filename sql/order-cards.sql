/*======================================================================
  ev-bot · Order cards — every card in one order, customers' included.
  Snowflake APP_PROD. Same column names as question 4131 so ev-bot shows
  them the same way. Use this if question 44123 doesn't return one row per
  card with ITEM_ID: save it as a question and set EV_ORDERS_CARD_ID to it.
  {{order_number}} is REQUIRED (Text) — ev-bot always sends it.
  NOTE: "INSERT"/"TAG" are reserved words — keep them double-quoted.
  ======================================================================*/
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
  orders.number::text                           AS order_number,
  orders.number                                 AS number,
  cards__i."TAG"                                AS "TAG",
  cards__i.status                               AS item_status,
  cards.status                                  AS card_status,
  users.email                                   AS owner_email,
  ccert.cert_number                             AS cert_number,
  cards.number                                  AS "8ac_number",
  cards.storage_bin_id,
  cards.storage_bin_slot,
  cards.id                                      AS item_id
FROM (SELECT * FROM APP_PROD.ADMIN.CARDS WHERE NOT COALESCE(_SNOWFLAKE_DELETED, FALSE)) cards
INNER JOIN (SELECT * FROM APP_PROD.PUBLIC.CATEGORY_ORDERS WHERE NOT COALESCE(_SNOWFLAKE_DELETED, FALSE)) orders ON cards.order_id = orders.id
LEFT JOIN (SELECT * FROM APP_PROD.PUBLIC.ITEMS WHERE NOT COALESCE(_SNOWFLAKE_DELETED, FALSE)) cards__i ON cards__i.id = cards.id AND cards__i.category = 'card'
LEFT JOIN (SELECT * FROM APP_PROD.PUBLIC.USERS WHERE NOT COALESCE(_SNOWFLAKE_DELETED, FALSE)) users ON users.id = cards.user_id
LEFT JOIN (SELECT * FROM APP_PROD.ADMIN.CARD_CERT_NUMBER WHERE NOT COALESCE(_SNOWFLAKE_DELETED, FALSE)) ccert ON ccert.card_id = cards.id
WHERE orders.number::text = LTRIM({{order_number}}, '#')
ORDER BY cards.number;

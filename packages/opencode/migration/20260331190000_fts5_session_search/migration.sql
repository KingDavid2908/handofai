CREATE VIRTUAL TABLE IF NOT EXISTS `part_search` USING fts5(
  `content`,
  `session_id`,
  `message_id`,
  tokenize='porter unicode61'
);

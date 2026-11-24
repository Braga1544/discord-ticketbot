-- run as root, fill in <PASSWORD> and <DB>, narrow '%' to your docker network
-- ddl only on ticketbot_*, table-level create works in mariadb before the table exists
-- config_change_log read-only
CREATE USER IF NOT EXISTS 'ticketbot'@'%' IDENTIFIED BY '<PASSWORD>';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES ON `<DB>`.`ticketbot_settings` TO 'ticketbot'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES ON `<DB>`.`ticketbot_categories` TO 'ticketbot'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES ON `<DB>`.`ticketbot_subteams` TO 'ticketbot'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES ON `<DB>`.`ticketbot_voice_groups` TO 'ticketbot'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES ON `<DB>`.`ticketbot_reaction_roles` TO 'ticketbot'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES ON `<DB>`.`ticketbot_role_managers` TO 'ticketbot'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES ON `<DB>`.`ticketbot_assignable_roles` TO 'ticketbot'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES ON `<DB>`.`ticketbot_state` TO 'ticketbot'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES ON `<DB>`.`ticketbot_status` TO 'ticketbot'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES ON `<DB>`.`ticketbot_transcripts` TO 'ticketbot'@'%';
GRANT SELECT ON `<DB>`.`config_change_log` TO 'ticketbot'@'%';
FLUSH PRIVILEGES;

-- utf8mb4_unicode_ci, every statement ends with ";" at end of line
CREATE TABLE IF NOT EXISTS ticketbot_settings (
  setting_key VARCHAR(191) NOT NULL, value MEDIUMTEXT NULL, name VARCHAR(255) NULL, description TEXT NULL,
  PRIMARY KEY (setting_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS ticketbot_categories (
  id INT NOT NULL AUTO_INCREMENT, sort INT NOT NULL DEFAULT 0, name VARCHAR(100) NOT NULL,
  discord_category_id VARCHAR(20) NOT NULL, default_roles TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS ticketbot_subteams (
  id INT NOT NULL AUTO_INCREMENT, sort INT NOT NULL DEFAULT 0, name VARCHAR(100) NOT NULL, roles TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS ticketbot_voice_groups (
  id INT NOT NULL AUTO_INCREMENT, name VARCHAR(100) NOT NULL, channel_ids TEXT NOT NULL DEFAULT '[]', ping_roles TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS ticketbot_reaction_roles (
  id INT NOT NULL AUTO_INCREMENT, sort INT NOT NULL DEFAULT 0, role_id VARCHAR(20) NOT NULL, channel_id VARCHAR(20) NOT NULL,
  required_role_id VARCHAR(20) NULL, min_account_age_days INT NOT NULL DEFAULT 0, start_time CHAR(5) NULL, end_time CHAR(5) NULL,
  message_id VARCHAR(20) NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS ticketbot_role_managers (
  id INT NOT NULL AUTO_INCREMENT, name VARCHAR(100) NOT NULL, manager_roles TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS ticketbot_assignable_roles (
  id INT NOT NULL AUTO_INCREMENT, manager_id INT NOT NULL, role_id VARCHAR(20) NOT NULL, name VARCHAR(100) NOT NULL,
  PRIMARY KEY (id),
  CONSTRAINT fk_ticketbot_assignable_manager FOREIGN KEY (manager_id) REFERENCES ticketbot_role_managers (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS ticketbot_state (
  setting_key VARCHAR(191) NOT NULL, value MEDIUMTEXT NULL,
  PRIMARY KEY (setting_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS ticketbot_status (
  id TINYINT NOT NULL, bot_tag VARCHAR(100) NULL, started_at DATETIME NULL, config_loaded_at DATETIME NULL,
  config_change_id BIGINT NULL, last_error TEXT NULL, error_at DATETIME NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS ticketbot_transcripts (
  id INT NOT NULL AUTO_INCREMENT, channel_name VARCHAR(100) NOT NULL, category VARCHAR(100) NULL,
  creator_discord_id VARCHAR(20) NULL, creator_name VARCHAR(100) NULL, opened_at DATETIME NULL, closed_at DATETIME NULL,
  closed_by_id VARCHAR(20) NULL, closed_by_name VARCHAR(100) NULL, content LONGTEXT NOT NULL,
  source ENUM('bot','import') NOT NULL,
  PRIMARY KEY (id), UNIQUE KEY uq_channel_source (channel_name, source),
  INDEX idx_creator (creator_discord_id), INDEX idx_opened (opened_at), INDEX idx_closed (closed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

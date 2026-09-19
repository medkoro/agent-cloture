CREATE DATABASE IF NOT EXISTS agent_cloture;
USE agent_cloture;

CREATE TABLE IF NOT EXISTS closing_sessions (
  id CHAR(36) PRIMARY KEY,
  dossier VARCHAR(120) NOT NULL,
  period CHAR(7) NOT NULL,
  state VARCHAR(32) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  INDEX idx_closing_period (dossier, period)
);

CREATE TABLE IF NOT EXISTS closing_events (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  session_id CHAR(36) NOT NULL,
  event_type VARCHAR(32) NOT NULL,
  payload JSON NOT NULL,
  created_at DATETIME(3) NOT NULL,
  INDEX idx_event_session (session_id),
  CONSTRAINT fk_event_session FOREIGN KEY (session_id) REFERENCES closing_sessions(id)
);

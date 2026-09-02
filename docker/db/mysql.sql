SET NAMES utf8mb4;

CREATE TABLE users (
  id INT PRIMARY KEY AUTO_INCREMENT,
  name VARCHAR(100) NOT NULL,
  email VARCHAR(190) NOT NULL,
  -- Two accounts on one address is never intended and is painful to undo later.
  UNIQUE KEY uniq_users_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE conversations (
  id INT PRIMARY KEY AUTO_INCREMENT,
  title VARCHAR(200) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE conversation_participants (
  conversation_id INT NOT NULL,
  user_id INT NOT NULL,
  PRIMARY KEY (conversation_id, user_id),
  -- The PK covers "who is in conversation X"; this covers the inbox query,
  -- "which conversations is user Y in", which is otherwise a full scan.
  KEY idx_participants_user (user_id),
  CONSTRAINT fk_participants_conversation
    FOREIGN KEY (conversation_id) REFERENCES conversations (id) ON DELETE CASCADE,
  CONSTRAINT fk_participants_user
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE messages (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  conversation_id INT NOT NULL,
  sender_id INT NOT NULL,
  client_id VARCHAR(64) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  -- Every read of this table is "the newest N rows of one conversation".
  -- Without this index that is a scan of the whole table, ordered in memory.
  KEY idx_messages_conversation_recent (conversation_id, id DESC),

  -- Idempotency for sends. A retried or double-clicked POST carrying the same
  -- clientId now collides here instead of inserting a second copy. NULLs do not
  -- collide in MySQL, so clients that send no clientId are unaffected.
  UNIQUE KEY uniq_messages_client (conversation_id, sender_id, client_id),

  CONSTRAINT fk_messages_conversation
    FOREIGN KEY (conversation_id) REFERENCES conversations (id) ON DELETE CASCADE,
  CONSTRAINT fk_messages_sender
    FOREIGN KEY (sender_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO users (id, name, email) VALUES
  (1, 'Alice', 'alice@example.com'),
  (2, 'Bob', 'bob@example.com'),
  (3, 'Carol', 'carol@example.com');

INSERT INTO conversations (id, title) VALUES
  (1, 'Support — order #1042'),
  (2, 'Design sync');

INSERT INTO conversation_participants (conversation_id, user_id) VALUES
  (1, 1), (1, 2), (2, 1), (2, 3);

INSERT INTO messages (id, conversation_id, sender_id, client_id) VALUES
  (1, 1, 2, NULL),
  (2, 1, 1, NULL),
  (3, 2, 3, NULL);

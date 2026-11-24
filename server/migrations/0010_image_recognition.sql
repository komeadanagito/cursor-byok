-- Existing manual models have always accepted image attachments.
ALTER TABLE model_configs ADD COLUMN supports_images INTEGER NOT NULL DEFAULT 1 CHECK (supports_images IN (0, 1));

CREATE TABLE image_descriptions (
    conversation_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    image_digest TEXT NOT NULL,
    description TEXT NOT NULL,
    FOREIGN KEY (conversation_id, message_id) REFERENCES messages(conversation_id, message_id) ON DELETE CASCADE,
    PRIMARY KEY (conversation_id, message_id, image_digest)
) WITHOUT ROWID;

ALTER TABLE providers ADD COLUMN request_format TEXT NOT NULL DEFAULT 'openai_chat'
  CHECK (request_format IN ('openai_chat', 'openai_responses', 'anthropic_messages', 'gemini_generate'));

UPDATE providers SET request_format = 'anthropic_messages' WHERE api_type = 'anthropic';
UPDATE providers SET request_format = 'gemini_generate' WHERE api_type = 'gemini';

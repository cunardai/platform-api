-- 007_more_model_rates.sql
-- Seed rates for models the app uses that weren't in 006, so their usage prices
-- correctly (a missing rate silently charges 0 credits). USD per 1M tokens.
INSERT INTO model_rates (model, input_per_mtok, output_per_mtok) VALUES
  ('claude-opus-4-7', 5.00, 25.00),   -- suggest-mappings uses this (older Opus id)
  ('gpt-4o',          2.50, 10.00)    -- callAI OpenAI branch + LLM example fallback
ON CONFLICT (model) DO NOTHING;

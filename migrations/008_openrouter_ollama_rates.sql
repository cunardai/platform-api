-- 008_openrouter_ollama_rates.sql
-- Rates for the non-Anthropic providers callAI can use. USD per 1M tokens.
--
-- ⚠️ PLACEHOLDER VALUES — tune to reality:
--   • OpenRouter: set to the model's current OpenRouter price.
--   • Ollama (local GPU): set to your amortized GPU $/1M-token cost — there's no
--     provider invoice, so this is your infra cost recovery.
-- Edit any value live via PUT /credits/model-rates/:model (no redeploy needed).
INSERT INTO model_rates (model, input_per_mtok, output_per_mtok) VALUES
  -- OpenRouter (cloud) — live prices from openrouter.ai/api/v1/models, 2026-06-12
  ('nvidia/nemotron-3-super-120b-a12b',                  0.09, 0.45),
  ('nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free', 0.00, 0.00),  -- :free tier
  ('google/gemma-4-31b-it',                              0.12, 0.35),
  ('meta-llama/llama-4-maverick',                        0.15, 0.60),
  -- Ollama (local GPU — PLACEHOLDER; set to your amortized GPU $/1M cost)
  ('gemma3:27b', 0.30, 0.30),
  ('gemma4:31b', 0.35, 0.35),
  ('qwen3:30b',  0.30, 0.30)
ON CONFLICT (model) DO NOTHING;

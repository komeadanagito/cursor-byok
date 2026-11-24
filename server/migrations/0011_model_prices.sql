-- Per (provider_url, model_id) pricing for provider_llm calls, replacing the
-- global token_pricing settings row.
CREATE TABLE model_prices (
    provider_url TEXT NOT NULL,
    model_id TEXT NOT NULL,
    input_per_million REAL NOT NULL CHECK (input_per_million >= 0),
    output_per_million REAL NOT NULL CHECK (output_per_million >= 0),
    -- NULL means the cache traffic prices the same as fresh input.
    cache_read_per_million REAL CHECK (cache_read_per_million >= 0),
    cache_write_per_million REAL CHECK (cache_write_per_million >= 0),
    currency TEXT NOT NULL CHECK (currency IN ('USD', 'CNY')),
    updated_at_ms INTEGER NOT NULL,
    PRIMARY KEY (provider_url, model_id)
);

DELETE FROM service_settings WHERE setting_key = 'token_pricing';

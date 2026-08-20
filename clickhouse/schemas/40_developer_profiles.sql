-- Developer identity map — collapse multiple logins (github, gitlab, ado, jira)
-- onto one canonical person via canonical_login.
CREATE TABLE IF NOT EXISTS cockpit.developer_identity_map
(
    organization_id String,
    login           String,
    provider        String,
    display_name    Nullable(String),
    email           Nullable(String),
    avatar_url      Nullable(String),
    canonical_login String,
    synced_at       DateTime  DEFAULT now()
)
ENGINE = ReplacingMergeTree(synced_at)
ORDER BY (organization_id, provider, login)
SETTINGS index_granularity = 8192;

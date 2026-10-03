UPDATE settings
SET value = 'true', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE key = 'publicStatus' AND value = 'false';

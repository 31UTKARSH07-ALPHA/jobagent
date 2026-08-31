/**
 * Load `.env` for a CLI somebody typed by hand.
 *
 * The scheduled runs go through `scripts/run-daily.sh`, which passes
 * `--env-file-if-exists=.env` to node. Nothing typed at a prompt does, so every documented
 * one-off — `node src/notify/telegram.ts --test`, `node src/contacts/domain.ts --name=…` —
 * started without a bot token or an API key and failed with a message about setup that had
 * already been done.
 *
 * Calling this at a CLI entry point makes the two paths behave the same. It is deliberately
 * *not* called by the library code: a stage must take its configuration from the environment
 * it was given, so that a test can control it and so a run cannot pick up a stray file.
 */
export function loadEnv(path = '.env'): void {
  try {
    process.loadEnvFile(path);
  } catch {
    // Absent or unreadable is fine — the variables may already be set, and every caller
    // reports a missing one in its own words.
  }
}

# Backup and recovery

## Implemented (Phase 1): encrypted device backup

**POS → Device → Backup** (manager PIN required) creates a file
`local-butcher-device-backup-<timestamp>.tlbbackup.json` containing every local table: products,
photos, price history, stock ledger, sales, items, payments, outbox, audit log and settings.

- Encryption: **AES-256-GCM** (authenticated) with a key from **PBKDF2-SHA256, 310,000 iterations**
  and a random 16-byte salt and 12-byte IV, via the browser's Web Crypto API.
- Integrity: GCM authentication plus a **SHA-256** of the content stored in the encrypted manifest,
  and per-table record counts.
- Manifest: created time, store ID, device ID, local schema version, record counts, unsynced sale count.
- Excluded: the manager PIN hash. No credentials exist in Phase 1.
- The file is decrypted and verified right after creation, before it is downloaded.
- **Check a backup file** decrypts a chosen file and shows its manifest without touching live data.

To store on an external drive: export on the phone/computer, then copy the file to the USB stick or
hard drive with the file manager. The browser cannot write to external drives by itself.

**Keep the passphrase.** Without it the file cannot be opened; there is no recovery.

Tested: `tests/integration/local-db.test.ts` round-trips record counts and totals, includes photos,
excludes the PIN, rejects a wrong passphrase and a tampered file.

## Implemented (0.8.0): nightly cloud database backup

Every night at **12:30 AM Manila time** GitHub runs `.github/workflows/db-backup.yml`, which runs
`scripts/db-backup.sh` against the Supabase database and keeps the result for **90 days**.

- Contents: `public-data.sql` (every row of every table: products, prices, stock, sales, shifts,
  members, staff, settings, audit log), `auth-data.sql` (staff sign-in accounts), `public-schema.sql`
  (for reference) and `manifest.txt` (time, schema version, row count per table).
- Not included: product photos. They stay in Supabase Storage and are in each device backup.
- Encryption: a **7-Zip archive, AES-256, file names hidden**, with the `BACKUP_PASSPHRASE` secret.
  The job opens the archive with the passphrase before it counts the backup as made.
- The repository is public, so anyone signed in to GitHub can download the archives. Without the
  passphrase they are unreadable. Use a long passphrase (at least 16 characters; the job refuses
  shorter ones) and do not reuse it anywhere.
- The job writes each run to `backup_runs`; **Back Office → Backups** shows the last good backup,
  and every Back Office page warns when there was none in the last 36 hours. GitHub also emails the
  account owner when a run fails.
- GitHub pauses scheduled jobs in a public repository after 60 days without any commit. It emails
  first; the job is switched back on with one click (Actions → Database backup → Enable workflow).

### One-time setup (owner)

1. **Run migration 12** (`supabase/migrations/20261030000012_backups_and_lockdown.sql`) in the
   Supabase SQL Editor.
2. **Copy the connection string.** In Supabase, open the project, press **Connect** at the top, and
   copy the **Session pooler** URI (it looks like
   `postgresql://postgres.<project>:[YOUR-PASSWORD]@aws-0-<region>.pooler.supabase.com:5432/postgres`).
   Put the database password in place of `[YOUR-PASSWORD]`. If you do not know it, reset it under
   Project Settings → Database; the app does not use it, so nothing else changes. Use the Session
   pooler, not the Direct connection: GitHub's machines cannot reach the direct one.
3. **Choose a backup passphrase** of at least 16 characters (for example four unrelated words).
   Write it down and keep it with the hard drive. Without it no backup can be opened.
4. In GitHub, open the repository → **Settings → Secrets and variables → Actions → New repository
   secret**, and add `SUPABASE_DB_URL` (step 2) and `BACKUP_PASSPHRASE` (step 3). Never paste these
   into a chat or a file in the repository.
5. Open **Actions → Database backup → Run workflow**. After about two minutes the run shows a green
   tick and Back Office → Backups shows it.

### Copying to the home hard drive (weekly)

Actions → Database backup → the newest run with a green tick → **Artifacts** → download. GitHub
wraps the file in a .zip; inside is `local-butcher-db-<time>.7z`. Copy it to the hard drive. To
check it, open it with 7-Zip (free, 7-zip.org) and type the passphrase: the four files should be
there.

### Restoring the cloud database

Only needed if the Supabase project is lost or damaged. This needs a computer with PostgreSQL 17's
`psql` (or ask for help with this step).

1. Create a **new** Supabase project. Run every migration in `supabase/migrations` in order, up to
   the `schema_version` written in the backup's `manifest.txt`.
2. Unpack the .7z with the passphrase into a folder.
3. Copy the new project's Session pooler URI, then run
   `TARGET_DB_URL='postgresql://…' scripts/db-restore.sh <folder>`.
   The script refuses a project that already has sign-in accounts or sales, or that is at another
   schema version, so it cannot overwrite the live shop. Everything goes in one transaction: if any
   step fails, nothing is kept. At the end it compares every table's row count with the backup.
4. Put the new project's URL and anon key into Vercel (`NEXT_PUBLIC_SUPABASE_URL`,
   `NEXT_PUBLIC_SUPABASE_ANON_KEY`), redeploy, and update the `SUPABASE_DB_URL` secret.
   Product photos are not restored by the script: devices keep showing the photos they already
   have, but the new cloud has none until they are added again.

Tested: `npm run test:backup` fills a local database, backs it up, checks a wrong passphrase fails
and file names are hidden, restores into a second fresh database, compares row counts, sales totals
and sign-in accounts, and checks both refusals.

## Not yet implemented

| Feature | Phase |
|---|---|
| Restore wizard (verify → preview → detect duplicate sale IDs → restore to staging → reconcile → owner confirms → log) | 7 (a device-to-device restore may come earlier with Phase 2) |
| Product photos in the nightly backup | 7b |

A restore will never overwrite live data on file selection.

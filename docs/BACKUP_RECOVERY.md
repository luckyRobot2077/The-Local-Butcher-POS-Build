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

## Not yet implemented

| Feature | Phase |
|---|---|
| Restore wizard (verify → preview → detect duplicate sale IDs → restore to staging → reconcile → owner confirms → log) | 7 (a device-to-device restore may come earlier with Phase 2) |
| Full cloud backup export (database + Storage photos) | 7 |
| Scheduled off-site database backups (do not rely on Supabase Free having daily backups) | 7 |
| "Last verified backup" for cloud data | 7 |

A restore will never overwrite live data on file selection.

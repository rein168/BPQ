/**
 * R2 Backup Service
 *
 * Syncs the local SQLite database file to Cloudflare R2 so it survives
 * Koyeb container restarts and redeployments.
 *
 * Flow:
 *   1. On startup → download DB from R2 if local file is missing (fresh container)
 *   2. Every SYNC_INTERVAL_MS → upload DB to R2 if any writes happened
 *   3. On graceful shutdown (SIGTERM/SIGINT) → final upload
 *
 * Required env vars:
 *   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME
 *
 * Optional:
 *   R2_DB_KEY          – object key in the bucket (default: "bpq.db")
 *   R2_SYNC_INTERVAL   – sync interval in seconds (default: 60)
 */

const { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'bpq.db');
const DB_WAL_PATH = DB_PATH + '-wal';
const DB_SHM_PATH = DB_PATH + '-shm';

let s3 = null;
let bucket = null;
let dbKey = 'bpq.db';
let syncInterval = null;
let dirty = false;
let enabled = false;

/**
 * Check if R2 is configured via environment variables.
 */
function isConfigured() {
  return !!(
    process.env.R2_ACCOUNT_ID &&
    process.env.R2_ACCESS_KEY_ID &&
    process.env.R2_SECRET_ACCESS_KEY &&
    process.env.R2_BUCKET_NAME
  );
}

/**
 * Initialize the S3 client for R2.
 */
function initClient() {
  const accountId = process.env.R2_ACCOUNT_ID;
  bucket = process.env.R2_BUCKET_NAME;
  dbKey = process.env.R2_DB_KEY || 'bpq.db';

  s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });

  enabled = true;
  console.log(`☁️  R2 backup enabled → bucket "${bucket}", key "${dbKey}"`);
}

/**
 * Download the DB from R2 to local disk. Returns true if downloaded.
 */
async function downloadDb() {
  if (!enabled) return false;

  try {
    // Check if object exists first
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: dbKey }));
  } catch (err) {
    if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
      console.log('☁️  No DB found in R2 — starting fresh.');
      return false;
    }
    throw err;
  }

  console.log('☁️  Downloading DB from R2...');
  const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: dbKey }));
  const chunks = [];
  for await (const chunk of response.Body) {
    chunks.push(chunk);
  }
  const buffer = Buffer.concat(chunks);
  fs.writeFileSync(DB_PATH, buffer);
  console.log(`☁️  DB restored from R2 (${(buffer.length / 1024).toFixed(1)} KB)`);
  return true;
}

/**
 * Upload the DB to R2. Checkpoints WAL first for a consistent snapshot.
 */
async function uploadDb(db) {
  if (!enabled) return;
  if (!fs.existsSync(DB_PATH)) return;

  try {
    // Checkpoint WAL to merge pending writes into the main DB file
    if (db) {
      try {
        db.pragma('wal_checkpoint(TRUNCATE)');
      } catch (err) {
        console.warn('☁️  WAL checkpoint warning:', err.message);
      }
    }

    const fileBuffer = fs.readFileSync(DB_PATH);
    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: dbKey,
      Body: fileBuffer,
      ContentType: 'application/x-sqlite3',
    }));

    dirty = false;
    console.log(`☁️  DB backed up to R2 (${(fileBuffer.length / 1024).toFixed(1)} KB)`);
  } catch (err) {
    console.error('☁️  R2 upload error:', err.message);
  }
}

/**
 * Mark the DB as dirty (a write happened). Called after mutations.
 */
function markDirty() {
  dirty = true;
}

/**
 * Initialize the R2 backup system:
 *   - Download DB from R2 if local file is missing
 *   - Start periodic sync timer
 *   - Register shutdown hooks
 *
 * Call BEFORE requiring db.js so the restored file is in place.
 * Returns { downloaded: boolean } or null if R2 is not configured.
 */
async function init() {
  if (!isConfigured()) {
    console.log('☁️  R2 backup not configured — using local DB only.');
    return null;
  }

  initClient();

  // Download DB if local file doesn't exist (fresh container)
  let downloaded = false;
  if (!fs.existsSync(DB_PATH)) {
    downloaded = await downloadDb();
  } else {
    console.log('☁️  Local DB exists — will sync to R2 periodically.');
  }

  return { downloaded };
}

/**
 * Start the periodic sync timer. Must be called after db.js is loaded
 * so we can pass the db instance for WAL checkpointing.
 */
function startSync(db) {
  if (!enabled) return;

  const intervalSec = parseInt(process.env.R2_SYNC_INTERVAL, 10) || 60;

  syncInterval = setInterval(async () => {
    if (dirty) {
      await uploadDb(db);
    }
  }, intervalSec * 1000);

  // Don't keep the process alive just for the sync timer
  if (syncInterval.unref) syncInterval.unref();

  console.log(`☁️  R2 sync every ${intervalSec}s (when dirty)`);

  // Graceful shutdown: final upload
  const shutdown = async (signal) => {
    console.log(`\n☁️  ${signal} received — final R2 backup...`);
    clearInterval(syncInterval);
    await uploadDb(db);
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

module.exports = {
  isConfigured,
  init,
  startSync,
  markDirty,
  uploadDb,
  downloadDb,
};

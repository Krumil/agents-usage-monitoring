import Database from "better-sqlite3";
import webpush from "web-push";

const dbPath = process.env.DATABASE_PATH ?? ".data/claude-usage.sqlite";
const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = process.env;

if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY || !VAPID_SUBJECT) {
  console.error("Set VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, and VAPID_SUBJECT before running.");
  process.exit(1);
}

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

const title = process.argv[2] ?? "Claude Code Usage";
const body = process.argv[3] ?? "Test notification — your phone is wired up.";

const db = new Database(dbPath);
const tableExists = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='push_subscriptions'")
  .get();

if (!tableExists) {
  console.log(`No push_subscriptions table in ${dbPath}. Start the server once, then subscribe from your phone.`);
  db.close();
  process.exit(0);
}

const rows = db.prepare("SELECT endpoint, subscription_json FROM push_subscriptions").all();
if (rows.length === 0) {
  console.log("No subscriptions stored yet. Install the PWA and tap Enable alerts on your phone first.");
  db.close();
  process.exit(0);
}

let sent = 0;
let pruned = 0;
for (const row of rows) {
  const subscription = JSON.parse(row.subscription_json);
  try {
    await webpush.sendNotification(subscription, JSON.stringify({ title, body, url: "/" }));
    sent += 1;
  } catch (error) {
    if (error?.statusCode === 404 || error?.statusCode === 410) {
      db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(row.endpoint);
      pruned += 1;
    } else {
      console.error(`Failed for ${row.endpoint}:`, error?.statusCode ?? error?.message ?? error);
    }
  }
}

console.log(`Sent ${sent} notification(s), pruned ${pruned} expired subscription(s).`);
db.close();

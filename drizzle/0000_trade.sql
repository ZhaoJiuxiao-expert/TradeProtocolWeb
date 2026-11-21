CREATE TABLE IF NOT EXISTS trade_clock (
 id INTEGER PRIMARY KEY CHECK(id=1),
 revision INTEGER NOT NULL CHECK(revision>=0),
 fees INTEGER NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS trade_items (id TEXT PRIMARY KEY, data TEXT NOT NULL);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS trade_accounts (id TEXT PRIMARY KEY, balance INTEGER NOT NULL CHECK(balance>=0));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS trade_blocks (idx INTEGER PRIMARY KEY, data TEXT NOT NULL);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS trade_receipts (actor TEXT NOT NULL, key TEXT NOT NULL, digest TEXT NOT NULL, item_id TEXT NOT NULL, PRIMARY KEY(actor,key));

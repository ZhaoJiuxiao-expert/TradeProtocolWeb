CREATE TABLE IF NOT EXISTS real_items (
 id TEXT PRIMARY KEY, seller TEXT NOT NULL, buyer TEXT, status TEXT NOT NULL,
 data TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS real_blocks (
 idx INTEGER PRIMARY KEY, data TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS real_receipts (
 actor TEXT NOT NULL, key TEXT NOT NULL, digest TEXT NOT NULL, item_id TEXT NOT NULL,
 PRIMARY KEY (actor,key)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS real_used_codes (
 digest TEXT PRIMARY KEY
);

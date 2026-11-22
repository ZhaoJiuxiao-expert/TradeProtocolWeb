CREATE TABLE IF NOT EXISTS personal_clock (
 id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL CHECK(revision>=0), secret TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS personal_items (
 id TEXT PRIMARY KEY, seller TEXT NOT NULL, buyer TEXT, status TEXT NOT NULL,
 order_key TEXT UNIQUE, data TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS personal_receipts (
 actor TEXT NOT NULL, key TEXT NOT NULL, digest TEXT NOT NULL, item_id TEXT NOT NULL,
 PRIMARY KEY(actor,key)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS personal_blocks (
 idx INTEGER PRIMARY KEY, item_id TEXT NOT NULL UNIQUE, data TEXT NOT NULL
);

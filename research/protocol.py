"""Offline simulation. A submitted actor name is a test fixture, not authentication."""
import argparse
import hashlib
import json
import sqlite3
import sys
from datetime import datetime, timezone

from pricing import update

VERSION = "trade-sim/3"
ZERO = "0" * 64

def encode(obj):
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)

def digest(obj):
    return hashlib.sha256(encode(obj).encode()).hexdigest()

def need(ok, reason):
    if not ok:
        raise ValueError(reason)

def string(v):
    return isinstance(v, str) and bool(v.strip())

def cents(v):
    return type(v) is int and v > 0

def new_state():
    return {"opening": {}, "wallet": {}, "deals": {}, "claims": {}}

def locked(s):
    return sum(d["escrow"] for d in s["deals"].values())

def apply(s, event):
    actor, action, deal, p = (event[k] for k in ("actor", "action", "deal", "payload"))
    need(string(actor) and string(deal) and isinstance(p,dict), "invalid command")
    if action == "open":
        need(not s["opening"] and actor == "simulator" and deal=="*" and p and
             all(string(k) and cents(v) for k,v in p.items()), "invalid opening balances")
        s["opening"], s["wallet"] = p.copy(), p.copy()
        return
    wallets = s["wallet"]
    need(bool(wallets), "missing opening balances")
    if action == "quote":
        need(deal not in s["deals"] and actor in wallets, "invalid seller or quote ID")
        stages = p["stages"]
        need(isinstance(stages,list) and stages and string(p["right"]) and string(p["claim"]) and
             p["unit"]=="TEST_CNY_CENT" and p["buyer"] in wallets and actor!=p["buyer"]
             and string(p["arbiter"]) and p["arbiter"] not in (actor,p["buyer"]), "invalid terms")
        for st in stages:
            need(string(st["name"]) and cents(st["amount"]) and string(st["verifier"])
                 and isinstance(st["proofs"],list) and st["proofs"], "invalid stage")
            for proof in st["proofs"]:
                need(string(proof["kind"]) and string(proof["issuer"]), "invalid proof specification")
        s["deals"][deal] = dict(terms=p, seller=actor, quote_hash=digest(p), state="quoted",
                                 stage=0, escrow=0, paid=0, refunded=0, proofs=[], history=[])
        return
    d=s["deals"][deal]
    t=d["terms"]; idx=d["stage"]; st=t["stages"][idx]; status=d["state"]
    buyer=t["buyer"]; seller=d["seller"]
    if action == "accept":
        need(status=="quoted" and actor==buyer and p["quote_hash"]==d["quote_hash"], "quote mismatch")
        need(t["claim"] not in s["claims"], "right already committed")
        s["claims"][t["claim"]]=deal
        d["state"]="accepted"
    else:
        need(type(p["stage"]) is int and p["stage"]==idx, "wrong stage")
        if action=="fund":
            n=st["amount"]
            need(status=="accepted" and actor==buyer and wallets[buyer]>=n, "cannot fund")
            wallets[buyer]-=n; d["escrow"]+=n; d["state"]="funded"
        elif action=="deliver":
            need(status=="funded", "cannot record delivery")
            spec=st["proofs"][len(d["proofs"])]
            need(actor==spec["issuer"] and p["kind"]==spec["kind"] and string(p["receipt"]), "wrong evidence")
            d["proofs"].append({"kind":p["kind"],"receipt":p["receipt"]})
            if len(d["proofs"])==len(st["proofs"]): d["state"]="delivered"
        elif action=="verify":
            need(status=="delivered" and actor==st["verifier"] and string(p["receipt"]), "cannot verify")
            d["state"]="verified"
        elif action=="dispute":
            need(status in ("funded","delivered") and actor in (seller,buyer) and string(p["reason"]), "cannot dispute")
            d["state"]="disputed"
        elif action in ("settle","resolve"):
            if action=="settle":
                need(status=="verified" and actor=="settlement", "cannot settle")
                paid=d["escrow"]
            else:
                paid=p["seller_cents"]
                need(status=="disputed" and actor==t["arbiter"] and type(paid) is int
                     and 0<=paid<=d["escrow"] and string(p["reason"]), "invalid resolution")
            refund=d["escrow"]-paid
            wallets[seller]+=paid; wallets[buyer]+=refund
            d["paid"]+=paid; d["refunded"]+=refund; d["escrow"]=0
            d["history"].append(dict(stage=idx,outcome=action,seller=paid,refund=refund))
            if action=="resolve": d["state"]="closed_by_resolution"
            elif idx+1==len(t["stages"]): d["state"]="closed"
            else: d["stage"]+=1; d["proofs"]=[]; d["state"]="accepted"
        else:
            raise ValueError("unknown action")
    need(min(wallets.values())>=0 and sum(wallets.values())+locked(s)==sum(s["opening"].values()),"balance invariant")

def connect(path):
    db=sqlite3.connect(path,timeout=15)
    db.execute("CREATE TABLE IF NOT EXISTS blocks (n INTEGER PRIMARY KEY, key TEXT UNIQUE NOT NULL, body TEXT NOT NULL, hash TEXT NOT NULL)")
    return db

def replay(db):
    state=new_state(); prev=ZERO; count=0
    for n,key,raw,h in db.execute("SELECT n,key,body,hash FROM blocks ORDER BY n"):
        b=json.loads(raw)
        need(n==count+1 and b["height"]==n and b["previous"]==prev and b["version"]==VERSION and
             b["event"]["id"]==key and digest(b)==h,"chain verification failed")
        apply(state,b["event"])
        need(update(state,b["event"])==b["price_view"],"price replay mismatch")
        prev=h; count=n
    return state,prev,count

def submit(db,event):
    need(set(event)=={"id","actor","action","deal","payload"} and string(event["id"]), "invalid envelope")
    with db:
        db.execute("BEGIN IMMEDIATE")
        s,prev,count=replay(db)
        existing=db.execute("SELECT body,hash FROM blocks WHERE key=?",(event["id"],)).fetchone()
        if existing:
            need(json.loads(existing[0])["event"]==event,"idempotency conflict")
            return existing[1]
        apply(s,event)
        b=dict(height=count+1,previous=prev,version=VERSION,time_utc=datetime.now(timezone.utc).isoformat(),event=event)
        b["price_view"]=update(s,event)
        h=digest(b)
        db.execute("INSERT INTO blocks VALUES(?,?,?,?)",(count+1,event["id"],encode(b),h))
        return h

if __name__=="__main__":
    parser=argparse.ArgumentParser()
    parser.add_argument("action",choices=["verify","submit"]);parser.add_argument("database")
    args=parser.parse_args()
    if args.action=="verify":
        from pathlib import Path
        db=sqlite3.connect(Path(args.database).resolve().as_uri()+"?mode=ro",uri=True)
        state,head,count=replay(db)
        print(json.dumps(dict(blocks=count,head=head,state=state),indent=2,ensure_ascii=False))
    else: print(submit(connect(args.database),json.load(sys.stdin)))


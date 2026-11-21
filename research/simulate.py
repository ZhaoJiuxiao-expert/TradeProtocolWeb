import json,sys,sqlite3
from pathlib import Path
from protocol import connect, digest, submit, replay, locked
from concurrent.futures import ProcessPoolExecutor

SELLERS="ABCDEFG"
CASES=["single-high","coalition-three","coalition-four","normal-gradual","normal-jump"]
def trades(case):
    # One identical, interleaved opening book in all markets.
    for _ in range(3):
        for s,p in zip(SELLERS,[1180,1190,1200,1200,1200,1210,1220]):
            yield "seed",s,p,1200
    if case=="single-high":
        for _ in range(21): yield "test","D",1800,1200
    elif case.startswith("coalition"):
        partners="ABC" if case.endswith("three") else "ABCD"
        for i in range(21): yield "test",partners[i%len(partners)],840,1200
    else:
        for p in ([1260,1320,1380,1440,1500] if case.endswith("gradual") else [1500]*5):
            for s in SELLERS: yield "test",s,p,p
    for _ in range(3):
        for s in SELLERS:
            p=1500 if case.startswith("normal") else 1200
            yield "followup",s,p,p

def run(args):
    case,root=args; directory=root/case;directory.mkdir()
    db=connect(directory/"chain.sqlite")
    def event(i,a,actor,p):
        return dict(id=i+"-"+a,actor=actor,deal=i,action=a,payload=p)
    submit(db,event("*","open","simulator",dict(buyer=50000000,**{s:1 for s in SELLERS})))
    rows=[]
    for n,(phase,s,p,truth) in enumerate(trades(case),1):
        i=str(n)
        terms=dict(right="one tested body delivered",claim=case+"-"+i,unit="TEST_CNY_CENT",buyer="buyer",arbiter="arb",
          market=dict(model="Canon AE-1",finish="silver/black",kit="body-only",grade="B",days=2,warranty=30,credit=95),
          stages=[dict(name="delivery",amount=p*100,verifier="buyer",proofs=[dict(kind="arrival",issuer="carrier")])])
        for a,actor,payload in [("quote",s,terms),("accept","buyer",dict(quote_hash=digest(terms))),("fund","buyer",dict(stage=0)),
            ("deliver","carrier",dict(stage=0,kind="arrival",receipt="sim-"+i)),("verify","buyer",dict(stage=0,receipt="checked-"+i)),
            ("settle","settlement",dict(stage=0))]:
            h=submit(db,event(i,a,actor,payload))
        block=json.loads(db.execute("select body from blocks where hash=?",(h,)).fetchone()[0])
        v=block["price_view"];o=v["order_weighted"];m=v["merchant_equal"]
        rows.append(dict(n=n,phase=phase,seller=s,price=p,scenario_fair=truth,
            old=o["after"]["reference"],new=m["after"]["reference"],merchants=o["after"]["sellers"],
            old_flag=o["flag"],new_flag=m["flag"],block=block["height"],hash=h))
    state,head,count=replay(db)
    assert count==1+6*len(rows) and len(state["price_history"])==len(rows) and locked(state)==0
    assert rows[20]["old"]==rows[20]["new"]==120000
    out=dict(case=case,head=head,count=count,rows=rows)
    (directory/"results.json").write_text(json.dumps(out,indent=2))
    db.close()
    return case,count

if __name__=="__main__":
    root=Path(sys.argv[1]);root.mkdir(exist_ok=False)
    with ProcessPoolExecutor(max_workers=5) as pool:
        for result in pool.map(run,[(case,root) for case in CASES]): print(result,flush=True)

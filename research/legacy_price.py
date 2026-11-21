"""Deterministic price views. Prices in simulated cents, integer half-up median."""
RULE = "camera-comps/1"
WINDOW = 21

def median(xs):
    s=sorted(xs)
    return (s[(len(s)-1)//2]+s[len(s)//2]+1)//2 if s else None

def key(terms):
    x=terms["market"]
    if x["grade"] not in ("A","B","C") or not all(isinstance(x[k],str) and x[k] for k in ("model","kit","finish")):
        raise ValueError("invalid camera specification")
    for k in ("days","warranty","credit"):
        if type(x[k]) is not int or x[k]<0: raise ValueError("invalid market attributes")
    if x["credit"]>100 or x["days"]<1: raise ValueError("invalid delivery or credit")
    return [terms["unit"],x["model"],x["kit"],x["finish"],x["grade"],
            "1-3d" if x["days"]<=3 else "4-7d" if x["days"]<=7 else "8+d",
            x["warranty"],"90+" if x["credit"]>=90 else "70-89" if x["credit"]>=70 else "<70"]

def stats(rows):
    rows=rows[-WINDOW:]
    values=[r["price"] for r in rows]
    m=median(values)
    sellers=len({r["seller"] for r in rows})
    return dict(ids=[r["id"] for r in rows],n=len(rows),sellers=sellers,
                reference=m if len(rows)>=3 and sellers>=3 else None,
                mad=median([abs(v-m) for v in values]),
                mean=round(sum(values)/len(values)) if values else None)

def update(state,event):
    action=event["action"]
    d=state["deals"].get(event["deal"])
    if not d or "market" not in d["terms"] or action not in ("quote","settle","resolve"): return None
    t=d["terms"]; group=key(t); history=state.setdefault("price_history",[])
    if len(t["stages"])!=1: raise ValueError("camera price requires one bundled sale")
    def peers(): return [r for r in history if r["key"]==group]
    before=stats(peers())
    price=t["stages"][0]["amount"]
    flag=None
    if before["reference"] is not None:
        m=before["reference"]; delta=price-m
        if abs(delta)>max(3*before["mad"],m*15//100):
            flag="high" if delta>0 else "low"
    included=action=="settle" and d["state"]=="closed" and d["refunded"]==0
    if included:
        history.append(dict(id=event["deal"],seller=d["seller"],price=d["paid"],key=group))
    broad=stats([r for r in history if r["key"][:2]==group[:2]])
    return dict(rule=RULE,group=group,included=included,flag=flag,before=before,
                after=stats(peers()),model_only=broad)

from legacy_price import WINDOW, key, median, update as legacy_update

def equal_view(rows):
    groups={}
    for row in rows[-WINDOW:]:
        groups.setdefault(row["seller"],[]).append(row["price"])
    values={s:median(xs) for s,xs in groups.items()}
    mid=median(list(values.values()))
    published=mid if len(values)>=3 else None
    return dict(merchant_medians=values,reference=published,
                mad=median([abs(x-mid) for x in values.values()]))

def update(state,event):
    d=state["deals"].get(event["deal"])
    if not d or "market" not in d["terms"] or event["action"] not in ("quote","settle","resolve"):
        return None
    group=key(d["terms"])
    def peers(): return [r for r in state.get("price_history",[]) if r["key"]==group]
    before=equal_view(peers())
    old=legacy_update(state,event)
    price=d["terms"]["stages"][0]["amount"]
    ref=before["reference"]
    flag=None
    if ref is not None and abs(price-ref)>max(3*before["mad"],ref*15//100):
        flag="high" if price>ref else "low"
    return dict(order_weighted=old,merchant_equal=dict(rule="merchant-median/1",before=before,
                after=equal_view(peers()),flag=flag))

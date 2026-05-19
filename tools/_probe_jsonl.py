import json, sys
for ln in open(sys.argv[1]):
    o = json.loads(ln)
    if o.get("type") == "frame" and o.get("tracks"):
        print(json.dumps(o, indent=2)[:1800])
        break

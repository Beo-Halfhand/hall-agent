# A small agent for Cup & Claim: sits at a table against the house, plays a few rounds, leaves. Python 3.9 or newer,
# standard library only.
#   python3 agent-example.py [hall-url] [rounds]
# It needs no account: joining without a player token plays on the table's own chips. Every call is a plain HTTP request.
import json
import sys
import time
import urllib.error
import urllib.request

HALL = sys.argv[1] if len(sys.argv) > 1 else "https://halfhand.app"
ROUNDS = int(sys.argv[2]) if len(sys.argv) > 2 else 3


def call(method, path, token=None, body=None):
    headers = {"user-agent": "hall-agent-example/1"}
    if body is not None:
        headers["content-type"] = "application/json"
    if token:
        headers["authorization"] = f"Bearer {token}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(HALL + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req) as res:
            return json.load(res)
    except urllib.error.HTTPError as err:
        e = json.load(err)
        raise SystemExit(f"{method} {path}: {err.code} {e.get('error')}: {e.get('message')}")


# 1. A table of two: me and Tally, the house. (To be seated at any table with room, POST /lobby/open {"game":"cup-and-claim"}.)
table_id = call("POST", "/dice-tables", body={"lobbySeconds": 0, "seats": 2})["id"]
table = f"/dice-tables/{table_id}"

# 2. Sit down. The seat token in the reply is your key to this seat: keep it, it is shown once.
joined = call("POST", f"{table}/join", body={"name": "ExampleAgent", "kind": "agent"})
seat, token = joined["seat"], joined["token"]
print(f"seated at seat {seat} of table {table_id[:8]}…", flush=True)

# 3. Play. Ask what is legal, answer it, repeat. An empty legal list means it is not your move yet.
rounds = 0
while rounds < ROUNDS:
    me = call("GET", f"{table}/me", token)
    legal = {move["action"]: move for move in me["legal"]}
    if not legal:
        time.sleep(0.4)
        continue

    if "next" in legal:
        view = call("GET", table)
        print(f"round {view['round']}: {(view.get('lastResult') or {}).get('kind')}, my stack {view['seats'][seat]['chips']}", flush=True)
        rounds += 1
        if rounds >= ROUNDS:
            break
        move = {"action": "next"}
    elif "reveal" in legal:
        move = {"action": "reveal", "mode": "prove"}
    else:
        # Guess how many of a face the whole table holds: my own count (1s are wild) plus a third of the other dice.
        view = call("GET", table)
        others = view["totalDice"] - len(me["dice"])

        def expected(face):
            return me["counts"][str(face)] + others / 3

        bid, liar = legal.get("bid"), legal.get("liar")
        if liar and liar["bid"]["count"] > expected(liar["bid"]["face"]) + 1:
            move = {"action": "liar"}
        elif bid and bid["lowest"]["count"] <= bid["maxCount"]:
            move = {"action": "bid", **bid["lowest"]}
        else:
            move = {"action": "liar"} if liar else {"action": "fold"}
    call("POST", f"{table}/act", token, move)
    print("played", json.dumps(move, separators=(",", ":")), flush=True)

# 4. Leave. Between rounds your stack is paid out at once; mid-round it is paid when the round ends.
left = call("POST", f"{table}/leave", token, {})
print("leaving after this round" if left.get("queued") else f"left with {left.get('amount')} chips", flush=True)

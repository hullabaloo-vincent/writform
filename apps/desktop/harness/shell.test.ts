// The shell's logic that can be proven without a window: how the app
// stands with a server (the link machine), what "Jump back in" shows, and
// that a server's data never outlives the server.

import { check, finish } from "./env";

import { greeting, mergeRecents, whenLabel, type Recent } from "../src/platform/recentsModel";
import { INITIAL_LINK, phaseOf, reduceLink, type LinkEvent, type LinkState } from "../src/stores/sessionMachine";

const user = { id: 7, username: "ada", display_name: "Ada" } as never;
const session = { addr: "10.0.0.2:7311", user };
const target = { addr: "10.0.0.2:7311", name: "The Scriptorium", username: "ada" };
const run = (events: LinkEvent[], from: LinkState = INITIAL_LINK) => events.reduce(reduceLink, from);

check("a first launch is local, with nothing to wait for", run([{ type: "boot", target: null }]).link === "local");
check("a remembered server: open at once, reconnecting behind it", run([{ type: "boot", target }]).link === "resuming" && run([{ type: "boot", target }]).target?.name === "The Scriptorium");
check("…then connected", run([{ type: "boot", target }, { type: "connected", session }]).link === "connected" && run([{ type: "boot", target }, { type: "connected", session }]).target === null);
{
  const s = run([{ type: "boot", target }, { type: "resume-failed", reason: "unreachable", addr: target.addr }]);
  check("…or unreachable, still naming the server", s.link === "unreachable" && s.target?.name === "The Scriptorium" && s.session === null);
  check("try again goes back to reconnecting", reduceLink(s, { type: "retry" }).link === "resuming");
  check("…and can succeed", run([{ type: "retry" }, { type: "connected", session }], s).link === "connected");
}
{
  const s = run([{ type: "boot", target }, { type: "resume-failed", reason: "expired", addr: target.addr }]);
  check("…or signed out, so the sign-in can open at that server", s.link === "expired" && s.target?.addr === target.addr);
  check("retry is only for a server that didn't answer", reduceLink(s, { type: "retry" }) === s);
}
check("a slow resume stops saying reconnecting", run([{ type: "boot", target }, { type: "resume-slow" }]).link === "unreachable");
check("…but a late answer still connects", run([{ type: "boot", target }, { type: "resume-slow" }, { type: "connected", session }]).link === "connected");
check("slowness means nothing once settled", run([{ type: "boot", target: null }, { type: "resume-slow" }]).link === "local" && run([{ type: "connected", session }, { type: "resume-slow" }]).link === "connected");
check("a late failure never undoes a sign-in", run([{ type: "boot", target }, { type: "connected", session }, { type: "resume-failed", reason: "unreachable", addr: target.addr }]).link === "connected");
check("nothing to resume and nothing in memory: local", run([{ type: "boot", target: null }, { type: "resume-failed", reason: null, addr: null }]).link === "local");
{
  const s = run([{ type: "connected", session }, { type: "expired" }]);
  check("a session rejected mid-use: signed out of that server, by name", s.link === "expired" && s.target?.addr === session.addr && s.target?.username === "ada" && s.session === null);
  check("…once", reduceLink(s, { type: "expired" }) === s);
}
check("leaving (disconnect or sign out) is local again", run([{ type: "connected", session }, { type: "left" }]).link === "local");
check("only connected has a session", (["local", "resuming", "unreachable", "expired"] as const).every((l) => phaseOf(l) === "offline") && phaseOf("connected") === "connected");
{
  // Whatever happens, in any order, the invariants hold.
  const events: LinkEvent[] = [
    { type: "boot", target },
    { type: "boot", target: null },
    { type: "connected", session },
    { type: "resume-failed", reason: "unreachable", addr: target.addr },
    { type: "resume-failed", reason: "expired", addr: "other:1" },
    { type: "resume-failed", reason: null, addr: null },
    { type: "resume-slow" },
    { type: "expired" },
    { type: "left" },
    { type: "retry" },
  ];
  let seed = 42;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  let ok = true;
  let state = INITIAL_LINK;
  for (let i = 0; i < 5000 && ok; i += 1) {
    state = reduceLink(state, events[Math.floor(rand() * events.length)]);
    const connected = state.link === "connected";
    ok = connected === (state.session !== null) && (state.link === "local" ? state.target === null : connected || state.target !== null);
  }
  check("5,000 random events: a session exactly when connected, a target exactly when waiting on a server", ok, JSON.stringify(state));
}

// ---- Jump back in
{
  const r = (key: string, at: number, title = key): Recent => ({ kind: "document", key, title, detail: "", at, place: "device" });
  const merged = mergeRecents([[r("a", 100), r("b", 300)], [r("c", 200), r("a", 250, "a renamed")], [r("zero", 0), r("nan", Number.NaN)]], 3);
  check("newest first, across the lists", merged.map((x) => x.key).join(",") === "b,a,c");
  check("one entry per thing — the newer one", merged[1].title === "a renamed" && merged[1].at === 250);
  check("the limit holds, and nothing undated gets in", mergeRecents([[r("a", 3), r("b", 2), r("c", 1)]], 2).length === 2 && !merged.some((x) => x.key === "zero" || x.key === "nan"));
  check("ties are stable", mergeRecents([[r("b", 5), r("a", 5)]]).map((x) => x.key).join("") === "ab");

  const now = Date.UTC(2026, 9, 10, 12, 0, 0);
  const ago = (ms: number) => whenLabel(now - ms, now);
  check(
    "times read the way people say them",
    ago(5_000) === "just now" && ago(61_000) === "a minute ago" && ago(5 * 60_000) === "5 minutes ago" && ago(3_600_000) === "an hour ago" && ago(5 * 3_600_000) === "5 hours ago" && ago(26 * 3_600_000) === "yesterday" && ago(3 * 86_400_000) === "3 days ago" && /\d/.test(ago(40 * 86_400_000)) && !ago(40 * 86_400_000).includes("ago"),
    [ago(61_000), ago(26 * 3_600_000), ago(40 * 86_400_000)].join(" | "),
  );
  check("a clock that ran backwards doesn't say 'in the future'", whenLabel(now + 60_000, now) === "just now");
  check("the greeting knows the hour and your name", greeting(8, "Ada") === "Good morning, Ada" && greeting(14, "") === "Good afternoon" && greeting(21, " Ada ") === "Good evening, Ada" && greeting(3, "") === "Still up");
}

finish();

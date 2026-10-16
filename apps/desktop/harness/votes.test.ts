// Voting on the pieces written for a prompt (a sprint battle): who can vote
// for what, how many have voted while it is open, closing it, and the
// pieces with their votes once it has closed.

import { check, finish } from "./env";
import { mountPoint } from "./dom";

import type { JSONContent } from "@tiptap/core";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { sessionApi } from "../src/apps/sessions/api";
import { Pieces } from "../src/apps/sessions/Pieces";
import { installSessionsWsHandler, useSessions } from "../src/apps/sessions/store";
import { backend } from "../src/lib/backend";
import { ConfirmHost } from "../src/platform/confirm";
import { useSession } from "../src/stores/session";

const g = globalThis as unknown as Record<string, unknown>;
g.IS_REACT_ACT_ENVIRONMENT = true;
(window as unknown as Record<string, unknown>).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

const para = (text: string): JSONContent => ({ type: "paragraph", content: [{ type: "text", text }] });
const piece = (...lines: string[]): JSONContent => ({ type: "doc", content: lines.map(para) });
const user = (id: number, name: string) => ({ id, username: name.toLowerCase(), display_name: name, avatar_attachment_id: null, accent_color: null });
const me = user(7, "Vin");
const ana = user(8, "Ana");
const bo = user(9, "Bo");
useSession.setState({ session: { user: me, addr: "host:1" } } as never);

const prompt = { id: 41, session_id: 1, creator_id: 8, position: 0, prompt_doc: piece("A door opens."), timer_seconds: 600, state: "ended", started_at: 0, ends_at: 0, ended_at: Date.now() - 1000 } as never;
const subs = [
  { id: 100, prompt_id: 41, author: me, doc: piece("My door was red."), updated_at: 0 },
  { id: 101, prompt_id: 41, author: ana, doc: piece("Her door was blue."), updated_at: 0 },
  { id: 102, prompt_id: 41, author: bo, doc: piece("His door was green."), updated_at: 0 },
  { id: 103, prompt_id: 41, author: user(10, "Cy"), doc: piece(), updated_at: 0 },
];
const detailWith = (votes: unknown) =>
  ({ session: { id: 1, channel_id: 1, creator: ana, title: "Battle", state: "active", chat_channel_id: 2, created_at: 0, ended_at: null }, prompts: [prompt], submissions: subs, votes }) as never;

const calls: string[] = [];
let refuse: unknown = null;
const api = sessionApi as unknown as Record<string, unknown>;
api.vote = async (p: number, s: number) => {
  if (refuse) throw refuse;
  calls.push(`vote ${p} ${s}`);
  return null;
};
api.withdrawVote = async (p: number) => {
  calls.push(`withdraw ${p}`);
  return null;
};
api.closeVoting = async (p: number) => {
  calls.push(`close ${p}`);
  return null;
};
let next: unknown = null;
api.detail = async () => next;
useSessions.setState({ activeSessionId: 1 } as never);

const open = { prompt_id: 41, votes_cast: 2, my_vote: null, closed_at: null, tally: [] };
useSessions.setState({ detail: detailWith([open]) });
const host = mountPoint();
const root = createRoot(host);
const render = (canClose: boolean) => act(async () => root.render(createElement(Pieces, { prompt, index: 0, sessionTitle: "Battle", canClose })));
await render(false);

const voteButtons = () => [...host.querySelectorAll<HTMLButtonElement>(".wf-piece-vote")];
const bar = () => host.querySelector(".wf-vote-bar")?.textContent ?? "";
check("asked to vote, with how many have", /Vote for the piece you liked best/.test(bar()) && /2 votes so far/.test(bar()), bar());
check("a vote for each other piece with words in it, none for one's own", voteButtons().length === 2 && !host.querySelector(".wf-piece.mine .wf-piece-vote"));
check("no counts while the voting is open", !host.querySelector(".wf-piece-votes"));
check("only whoever runs the prompt closes it", ![...host.querySelectorAll(".wf-vote-bar button")].length);

await act(async () => voteButtons()[0].click());
check("a vote is sent for that piece", calls[calls.length - 1] === "vote 41 101");
check("…and shown as the reader's", voteButtons()[0].getAttribute("aria-pressed") === "true" && voteButtons()[0].textContent?.trim() === "Your vote" && /3 votes so far/.test(bar()), bar());
await act(async () => voteButtons()[1].click());
check("voting for another moves it", calls[calls.length - 1] === "vote 41 102" && voteButtons()[0].getAttribute("aria-pressed") === "false" && voteButtons()[1].getAttribute("aria-pressed") === "true" && /3 votes so far/.test(bar()));
await act(async () => voteButtons()[1].click());
check("pressed again, it is taken back", calls[calls.length - 1] === "withdraw 41" && voteButtons().every((b) => b.getAttribute("aria-pressed") === "false") && /2 votes so far/.test(bar()));

// What the others do arrives as a count.
let deliver: ((e: unknown) => void) | null = null;
(backend as unknown as Record<string, unknown>).onWsEvent = (fn: (e: unknown) => void) => {
  deliver = fn;
  return () => {
    deliver = null;
  };
};
const stop = installSessionsWsHandler();
await act(async () => deliver?.({ ev: "event", room: "session:1", kind: "prompt.voted", data: { session_id: 1, prompt_id: 41, votes_cast: 5 } }));
check("others' votes arrive as a count", /5 votes so far/.test(bar()), bar());

refuse = { code: "voting_closed", message: "voting on this prompt has closed" };
next = detailWith([{ ...open, closed_at: Date.now(), tally: [] }]);
await act(async () => voteButtons()[0].click());
await act(async () => new Promise((r) => setTimeout(r, 20)));
check("a vote after the voting closed reads the session again", !host.querySelector(".wf-piece-vote") && /Voting is closed/.test(bar()));
refuse = null;

// Closing it.
await act(async () => useSessions.setState({ detail: detailWith([open]) }));
await render(true);
const dialogs = mountPoint();
const dialogRoot = createRoot(dialogs);
await act(async () => dialogRoot.render(createElement(ConfirmHost)));
const closeButton = [...host.querySelectorAll<HTMLButtonElement>(".wf-vote-bar button")].find((b) => b.textContent === "Close voting");
check("whoever runs the prompt may close the voting", !!closeButton);
next = detailWith([{ prompt_id: 41, votes_cast: 3, my_vote: 101, closed_at: Date.now(), tally: [{ submission_id: 102, votes: 2 }, { submission_id: 101, votes: 1 }] }]);
await act(async () => closeButton!.click());
check("…after asking", (dialogs.textContent ?? "").includes("No one can vote after this") && !calls.includes("close 41"));
const confirm = [...dialogs.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Close voting");
await act(async () => confirm?.click());
await act(async () => new Promise((r) => setTimeout(r, 20)));
check("closing it is sent", calls.includes("close 41"));
const names = [...host.querySelectorAll(".wf-piece > header strong")].map((n) => n.textContent);
check("closed: the most voted first", names[0] === "Bo" && names[1] === "Ana", names.join());
check("…each with its votes", [...host.querySelectorAll(".wf-piece-votes")].map((v) => v.textContent).join() === "2 votes,1 vote,0 votes,0 votes");
check("…the most voted marked", host.querySelector(".wf-piece.most > header strong")?.textContent === "Bo" && /Bo got the most votes \(2 votes\)/.test(bar()), bar());
check("…and no more voting", voteButtons().length === 0 && !host.querySelector(".wf-vote-bar button"));

const fold = host.querySelector<HTMLButtonElement>(".wf-subs-toggle")!;
await act(async () => fold.click());
check("folded, it says who got the most", /most votes: Bo/.test(fold.textContent ?? ""), fold.textContent ?? "");
await act(async () => fold.click());

await act(async () => useSessions.setState({ detail: detailWith([{ prompt_id: 41, votes_cast: 2, my_vote: null, closed_at: Date.now(), tally: [{ submission_id: 100, votes: 1 }, { submission_id: 101, votes: 1 }] }]) }));
await render(false);
check("a tie is said as one", /You and Ana tied with 1 vote each/.test(bar()), bar());
await act(async () => useSessions.setState({ detail: detailWith([{ prompt_id: 41, votes_cast: 0, my_vote: null, closed_at: Date.now(), tally: [] }]) }));
await render(false);
check("…and no votes at all", /No one voted/.test(bar()));

// No voting where it means nothing.
await act(async () => useSessions.setState({ detail: { ...detailWith([open]), submissions: subs.slice(0, 2) } as never }));
await render(false);
check("with one other piece there is still something to choose", voteButtons().length === 1);
await act(async () => useSessions.setState({ detail: { ...detailWith([open]), submissions: [subs[0], subs[3]] } as never }));
await render(false);
check("one piece with words: no voting", !host.querySelector(".wf-vote-bar") && voteButtons().length === 0);
await act(async () => useSessions.setState({ detail: { ...detailWith(undefined) } as never }));
await render(false);
check("a server that counts no votes: no voting", !host.querySelector(".wf-vote-bar"));

stop();
await act(async () => root.unmount());
await act(async () => dialogRoot.unmount());
finish();

// The sign-in form follows the server's rule for new accounts (anyone, with
// an invite code, or no one), and the trust prompt says when a server is
// reached through a proxy.

import { check, finish } from "./env";
import { mountPoint } from "./dom";

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

import { ConnectFlow } from "../src/connect/ConnectFlow";
import { backend, type ProbeResult } from "../src/lib/backend";

const g = globalThis as unknown as Record<string, unknown>;
g.IS_REACT_ACT_ENVIRONMENT = true;
(window as unknown as Record<string, unknown>).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

const registered: unknown[][] = [];
let next: Partial<ProbeResult> = {};
const b = backend as unknown as Record<string, unknown>;
b.probeServer = async (addr: string): Promise<ProbeResult> => ({ addr, server_name: "Test", protocol_version: 1, trust: { status: "trusted" }, ...next });
b.register = async (...args: unknown[]) => {
  registered.push(args);
  throw { code: "stop", message: "stopped here" };
};

const show = async (probe: Partial<ProbeResult>): Promise<{ root: Root; el: HTMLElement }> => {
  next = probe;
  const el = mountPoint();
  const root = createRoot(el);
  await act(async () => root.render(createElement(ConnectFlow)));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  return { root, el };
};
const buttons = (el: HTMLElement) => [...el.querySelectorAll("button")];
const type = async (input: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

{
  const { root, el } = await show({ registration: "closed" });
  check("a server taking no one has no Create account", !buttons(el).some((x) => x.textContent === "Create account"));
  check("…and says so", (el.textContent ?? "").includes("isn’t taking new accounts") || (el.textContent ?? "").includes("isn't taking new accounts"), el.textContent ?? "");
  await act(async () => root.unmount());
}

{
  const { root, el } = await show({ registration: "invite" });
  const tab = buttons(el).find((x) => x.textContent === "Create account")!;
  await act(async () => tab.click());
  const code = el.querySelector('input[placeholder="invite code"]') as HTMLInputElement | null;
  check("a server taking invited people asks for the code", !!code && (el.textContent ?? "").includes("invite code from its admin"));
  const inputs = [...el.querySelectorAll("input")] as HTMLInputElement[];
  await type(inputs.find((i) => i.placeholder === "username")!, "newcomer");
  await type(inputs.find((i) => i.type === "password")!, "a-long-password");
  const submit = () => buttons(el).find((x) => x.type === "submit")!;
  check("…and waits for it", submit().disabled);
  await type(code!, " abcd2345ef ");
  check("…then lets the account be made", !submit().disabled);
  await act(async () => submit().click());
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  check("the code goes with the new account", registered.length === 1 && registered[0][4] === "abcd2345ef", JSON.stringify(registered));
  await act(async () => root.unmount());
}

{
  const { root, el } = await show({ registration: "open" });
  check("anyone: the usual form, no code", buttons(el).some((x) => x.textContent === "Create account") && !el.querySelector('input[placeholder="invite code"]'));
  await act(async () => root.unmount());
}

{
  const { root, el } = await show({ trust: { status: "new", fingerprint: "3f2a-91cc-04b7-e812" }, via_proxy: true });
  check("a server through a proxy is said to be", (el.textContent ?? "").includes("through a proxy such as Cloudflare") && (el.textContent ?? "").includes("3f2a-91cc-04b7-e812"), el.textContent ?? "");
  await act(async () => root.unmount());
}

finish();

/**
 * Lightweight self-check for dual-select rules (run with node --experimental-strip-types or tsx if available).
 * Kept as a plain module for typecheck; logic is covered by manual HITL acceptance too.
 */
import {
  compareLabel,
  swapSelection,
  toggleCommitSelection,
} from "./selection";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

const t1 = toggleCommitSelection([], "a");
assert(t1.ok && t1.selectedHashes.join() === "a", "first select");

const t2 = toggleCommitSelection(["a"], "b");
assert(t2.ok && t2.selectedHashes.join() === "a,b", "second select");

const t3 = toggleCommitSelection(["a", "b"], "c");
assert(!t3.ok && t3.reason.includes("two"), "third rejected");

const t4 = toggleCommitSelection(["a", "b"], "a");
assert(t4.ok && t4.selectedHashes.join() === "b", "deselect");

assert(swapSelection(["a", "b"]).join() === "b,a", "swap");
assert(compareLabel(["aaa", "bbb"], (h) => h.slice(0, 3)) === "aaa → bbb", "label");

console.log("selection.test.ts ok");

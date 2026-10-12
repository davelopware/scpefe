import assert from "node:assert/strict";
import test from "node:test";
import { validateRevisionActivityPage, validateRevisionActivityRequest,
  validateRevisionActivityComparison } from "../src/contracts.mjs";

const id = (digit: string) => digit.repeat(64);
const slot = "ab".repeat(16);
const record = (revisionId: string) => ({ revisionId, previousHead: id("1"),
  contentParent: id("1"), mergeSources: [], timestampMs: 100,
  actorSlotId: slot, actorName: "Ada", actorEmail: "ada@example.test",
  clientName: "Ada", clientEmail: "ada@example.test", device: "Desk",
  eventType: "", kind: 1, storageKind: 2, foreign: false, provisional: false,
  bodyAvailable: true, textAvailable: true });

test("activity pages keep paging and body availability explicit", () => {
  assert.deepEqual(validateRevisionActivityRequest(20, 20), { offset: 20, count: 20 });
  assert.throws(() => validateRevisionActivityRequest(-1, 20), /page request/);
  const page = validateRevisionActivityPage({ items: [record(id("2"))],
    nextOffset: 1, hasMore: false }, 0, 20);
  assert.equal(page.items[0].revisionId, id("2"));
  assert.equal(page.items[0].textAvailable, true);
  assert.throws(() => validateRevisionActivityPage({ items: [record(id("2"))],
    nextOffset: 2, hasMore: false }, 0, 20), /activity page/);
  assert.deepEqual(validateRevisionActivityPage({ items: [], nextOffset: 0,
    hasMore: false, unavailable: true }, 0, 20), { items: [], nextOffset: 0,
    hasMore: false, unavailable: true });
  assert.deepEqual(validateRevisionActivityComparison({ available: false }),
    { available: false });
  assert.throws(() => validateRevisionActivityComparison({ available: false,
    text: "secret" }), /revision comparison/);
});

test("event details are decoded from the authenticated CBOR map", () => {
  const note = Buffer.from("done");
  const cbor = Buffer.concat([Buffer.from([0xa4, 0x01, 0x50]), Buffer.from(slot, "hex"),
    Buffer.from([0x03, 0x02, 0x04, 0x01, 0x05, 0x64]), note]).toString("hex");
  const page = validateRevisionActivityPage({ items: [{ ...record(id("3")),
    kind: 2, storageKind: 0, bodyAvailable: false, eventType: "backup",
    eventDetailsCbor: cbor }], nextOffset: 1, hasMore: false }, 0, 20);
  assert.deepEqual(page.items[0].details, { affectedSlotId: slot,
    retainedDeltas: 2, outcome: 1, note: "done" });
  assert.equal("eventDetailsCbor" in page.items[0], false);
  assert.throws(() => validateRevisionActivityPage({ items: [{ ...record(id("3")),
    eventDetailsCbor: "a101" }], nextOffset: 1, hasMore: false }, 0, 20),
  /event details/);
});

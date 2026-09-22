import test from "node:test";
import { lifecycleCaseName, runMountedLock } from
  "./lock-start-rendered-integration.test.mjs";

const origins = ["rn-picker-cancel", "rn-mismatch", "rn-create-fault",
  "rn-stage-lease-fault", "rn-post-authorization-revalidation",
  "ro-picker-cancel", "ro-dialog-cancel",
  "ro-wrong-password", "ro-pre-authorization-revalidation",
  "ro-post-authorization-revalidation", "ro-invitation", "rx-retry",
  "rx-cancel", "rx-open-ack"];

for (const origin of origins) {
  test(lifecycleCaseName(origin), (t) => runMountedLock(t, origin));
}

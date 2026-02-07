/**
 * Integration test for the Hive broker and client.
 * Run with: npx tsx test/broker-test.ts
 */

import { HiveBroker } from "../src/broker/server.js";
import { HiveClient } from "../src/client/connection.js";
import type { BrokerMessage } from "../src/broker/protocol.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (condition) {
    console.log(`  ✓ ${msg}`);
    passed++;
  } else {
    console.log(`  ✗ ${msg}`);
    failed++;
  }
}

async function waitForMessage(
  client: HiveClient,
  predicate: (msg: BrokerMessage) => boolean,
  timeoutMs = 3000
): Promise<BrokerMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.offMessage(handler);
      reject(new Error("Timeout waiting for message"));
    }, timeoutMs);
    const handler = (msg: BrokerMessage) => {
      if (predicate(msg)) {
        clearTimeout(timer);
        client.offMessage(handler);
        resolve(msg);
      }
    };
    client.onMessage(handler);
  });
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log("\n🐝 Hive Broker Integration Tests\n");

  // ── Start Broker ──────────────────────────────────────────────────
  console.log("Starting broker...");
  const broker = new HiveBroker();
  const port = await broker.start();
  console.log(`Broker listening on port ${port}\n`);
  assert(port > 0, `Broker started on port ${port}`);

  // ── Test 1: Client Connection & Registration ──────────────────────
  console.log("\n--- Test 1: Connection & Registration ---");

  const hub = new HiveClient();
  await hub.connect(`ws://127.0.0.1:${port}`);
  assert(hub.isConnected(), "Hub connected");

  // Listen for registration confirmation
  const hubRegistered = waitForMessage(hub, (m) => m.type === "registered");
  hub.register({
    id: "hub-001",
    name: "hub",
    role: "hub — human operator",
    cwd: "/test",
    interactive: true,
  });
  const regMsg = await hubRegistered;
  assert(regMsg.type === "registered", "Hub received registration confirmation");
  if (regMsg.type === "registered") {
    assert(regMsg.agents.length === 1, `Agent list has 1 agent (got ${regMsg.agents.length})`);
    assert(regMsg.agents[0].name === "hub", `Agent name is "hub"`);
  }

  // ── Test 2: Second Client Joins ───────────────────────────────────
  console.log("\n--- Test 2: Second Client Joins ---");

  const scout = new HiveClient();
  await scout.connect(`ws://127.0.0.1:${port}`);
  assert(scout.isConnected(), "Scout connected");

  // Hub should get agent_joined notification
  const hubNotified = waitForMessage(hub, (m) => m.type === "agent_joined");

  const scoutRegistered = waitForMessage(scout, (m) => m.type === "registered");
  scout.register({
    id: "scout-001",
    name: "scout",
    role: "recon agent",
    parentId: "hub-001",
    cwd: "/test/src",
    interactive: true,
  });
  const scoutReg = await scoutRegistered;
  assert(scoutReg.type === "registered", "Scout received registration");
  if (scoutReg.type === "registered") {
    assert(scoutReg.agents.length === 2, `Agent list has 2 agents (got ${scoutReg.agents.length})`);
  }

  const joinMsg = await hubNotified;
  assert(joinMsg.type === "agent_joined", "Hub notified of scout joining");
  if (joinMsg.type === "agent_joined") {
    assert(joinMsg.agent.name === "scout", `Joined agent is "scout"`);
    assert(joinMsg.agent.parentId === "hub-001", "Parent ID is correct");
  }

  // Check known agents cache
  await sleep(100);
  assert(hub.getKnownAgents().length === 2, `Hub knows 2 agents`);
  assert(scout.getKnownAgents().length === 2, `Scout knows 2 agents`);

  // ── Test 3: Direct Message (fire-and-forget) ─────────────────────
  console.log("\n--- Test 3: DM (fire-and-forget) ---");

  const scoutGotDm = waitForMessage(scout, (m) => m.type === "dm");
  hub.send({ type: "dm", to: "scout", content: "Hello scout!" });
  const dm = await scoutGotDm;
  assert(dm.type === "dm", "Scout received DM");
  if (dm.type === "dm") {
    assert(dm.fromName === "hub", `DM from "hub"`);
    assert(dm.content === "Hello scout!", "DM content matches");
    assert(dm.correlationId === undefined, "No correlationId (fire-and-forget)");
  }

  // ── Test 4: DM Request/Response ───────────────────────────────────
  console.log("\n--- Test 4: DM Request/Response ---");

  const correlationId = "test-corr-001";

  // Scout listens for DM, then sends response
  const scoutGotReqDm = waitForMessage(scout, (m) => m.type === "dm" && m.correlationId === correlationId);

  hub.send({
    type: "dm",
    to: "scout",
    content: "What did you find?",
    correlationId,
  });

  const reqDm = await scoutGotReqDm;
  assert(reqDm.type === "dm" && reqDm.correlationId === correlationId, "Scout received DM with correlationId");

  // Scout replies
  const hubGotResponse = waitForMessage(
    hub,
    (m) => m.type === "dm_response" && m.correlationId === correlationId
  );
  scout.send({
    type: "dm_response",
    to: "hub",
    correlationId,
    content: "Found 12 TypeScript files in src/",
  });

  const response = await hubGotResponse;
  assert(response.type === "dm_response", "Hub received dm_response");
  if (response.type === "dm_response") {
    assert(response.correlationId === correlationId, "CorrelationId matches");
    assert(response.content === "Found 12 TypeScript files in src/", "Response content matches");
    assert(response.fromName === "scout", "Response from scout");
  }

  // ── Test 5: Broadcast ─────────────────────────────────────────────
  console.log("\n--- Test 5: Broadcast ---");

  // Add a third client
  const worker = new HiveClient();
  await worker.connect(`ws://127.0.0.1:${port}`);
  const workerReg = waitForMessage(worker, (m) => m.type === "registered");
  worker.register({
    id: "worker-001",
    name: "worker",
    role: "general worker",
    cwd: "/test",
    interactive: true,
  });
  await workerReg;
  await sleep(100);

  const scoutGotBroadcast = waitForMessage(scout, (m) => m.type === "broadcast");
  const workerGotBroadcast = waitForMessage(worker, (m) => m.type === "broadcast");

  hub.send({ type: "broadcast", content: "Everyone report status!" });

  const [scoutBc, workerBc] = await Promise.all([scoutGotBroadcast, workerGotBroadcast]);
  assert(scoutBc.type === "broadcast" && scoutBc.content === "Everyone report status!", "Scout got broadcast");
  assert(workerBc.type === "broadcast" && workerBc.content === "Everyone report status!", "Worker got broadcast");

  // Make sure sender didn't get their own broadcast (verify by timeout)
  let hubGotOwnBroadcast = false;
  const selfCheck = waitForMessage(hub, (m) => m.type === "broadcast", 500).then(() => {
    hubGotOwnBroadcast = true;
  }).catch(() => {});
  await selfCheck;
  assert(!hubGotOwnBroadcast, "Hub did NOT receive its own broadcast");

  // ── Test 6: Status Updates ────────────────────────────────────────
  console.log("\n--- Test 6: Status Updates ---");

  const hubGotStatus = waitForMessage(hub, (m) => m.type === "status_changed");
  scout.send({ type: "status_update", status: "busy" });
  const statusMsg = await hubGotStatus;
  assert(statusMsg.type === "status_changed", "Hub received status change");
  if (statusMsg.type === "status_changed") {
    assert(statusMsg.name === "scout", "Status from scout");
    assert(statusMsg.status === "busy", "Status is busy");
  }

  // Check cached status
  await sleep(100);
  const scoutInfo = hub.getAgentByName("scout");
  assert(scoutInfo?.status === "busy", "Hub cache updated scout to busy");

  // ── Test 7: DM to Offline Agent ───────────────────────────────────
  console.log("\n--- Test 7: DM to Offline Agent ---");

  const hubGotError = waitForMessage(hub, (m) => m.type === "error");
  hub.send({ type: "dm", to: "nonexistent", content: "hello?", correlationId: "err-001" });
  const errMsg = await hubGotError;
  assert(errMsg.type === "error", "Got error for offline agent");
  if (errMsg.type === "error") {
    assert(errMsg.message.includes("not online"), `Error message: "${errMsg.message}"`);
    assert(errMsg.correlationId === "err-001", "Error has correlationId");
  }

  // ── Test 8: Channel Operations ────────────────────────────────────
  console.log("\n--- Test 8: Channels ---");

  const allGotCreated = Promise.all([
    waitForMessage(hub, (m) => m.type === "channel_created"),
    waitForMessage(scout, (m) => m.type === "channel_created"),
    waitForMessage(worker, (m) => m.type === "channel_created"),
  ]);

  hub.send({ type: "channel_create", channel: "backend" });
  await allGotCreated;
  assert(true, "All agents notified of channel creation");

  // Scout joins
  scout.send({ type: "channel_join", channel: "backend" });
  await sleep(100);

  // Hub sends to channel (scout should get it, worker should not)
  const scoutGotChannelMsg = waitForMessage(scout, (m) => m.type === "channel_message");
  let workerGotChannelMsg = false;
  const workerCheck = waitForMessage(worker, (m) => m.type === "channel_message", 500)
    .then(() => { workerGotChannelMsg = true; })
    .catch(() => {});

  hub.send({ type: "channel_send", channel: "backend", content: "Backend update!" });

  const chMsg = await scoutGotChannelMsg;
  assert(chMsg.type === "channel_message" && chMsg.content === "Backend update!", "Scout received channel message");

  await workerCheck;
  assert(!workerGotChannelMsg, "Worker did NOT receive channel message (not a member)");

  // ── Test 9: Agent List ────────────────────────────────────────────
  console.log("\n--- Test 9: Agent List ---");

  const hubGotList = waitForMessage(hub, (m) => m.type === "agent_list");
  hub.send({ type: "list_agents" });
  const listMsg = await hubGotList;
  assert(listMsg.type === "agent_list", "Got agent list");
  if (listMsg.type === "agent_list") {
    assert(listMsg.agents.length === 3, `List has 3 agents (got ${listMsg.agents.length})`);
    const names = listMsg.agents.map((a) => a.name).sort();
    assert(JSON.stringify(names) === '["hub","scout","worker"]', `Names: ${names.join(", ")}`);
  }

  // ── Test 10: Duplicate Name Handling ──────────────────────────────
  console.log("\n--- Test 10: Duplicate Name ---");

  const scout2 = new HiveClient();
  await scout2.connect(`ws://127.0.0.1:${port}`);
  const scout2Reg = waitForMessage(scout2, (m) => m.type === "registered");
  scout2.register({
    id: "scout-002",
    name: "scout",
    role: "another scout",
    cwd: "/test",
    interactive: true,
  });
  const s2Reg = await scout2Reg;
  if (s2Reg.type === "registered") {
    const myInfo = s2Reg.agents.find((a) => a.id === "scout-002");
    assert(myInfo?.name === "scout-2", `Duplicate renamed to "${myInfo?.name}"`);
  }
  scout2.close();
  await sleep(100);

  // ── Test 11: Rename ───────────────────────────────────────────────
  console.log("\n--- Test 11: Rename ---");

  const hubGotRename = waitForMessage(hub, (m) => m.type === "agent_renamed");
  scout.send({ type: "rename", name: "scout-renamed" });

  const renameMsg = await hubGotRename;
  assert(renameMsg.type === "agent_renamed", "Hub notified of rename");
  if (renameMsg.type === "agent_renamed") {
    assert(renameMsg.oldName === "scout", `Old name is "${renameMsg.oldName}"`);
    assert(renameMsg.newName === "scout-renamed", `New name is "${renameMsg.newName}"`);
  }

  await sleep(100);
  assert(!!hub.getAgentByName("scout-renamed"), "Hub cache has new scout name");
  assert(!hub.getAgentByName("scout"), "Hub cache no longer has old scout name");

  // DM to new name works
  const renamedGotDm = waitForMessage(scout, (m) => m.type === "dm" && m.content === "ping renamed");
  hub.send({ type: "dm", to: "scout-renamed", content: "ping renamed" });
  const renamedDm = await renamedGotDm;
  assert(renamedDm.type === "dm", "Renamed agent received DM via new name");

  // DM to old name fails
  const hubGotOldNameError = waitForMessage(hub, (m) => m.type === "error" && m.correlationId === "rename-old-name");
  hub.send({ type: "dm", to: "scout", content: "ping old", correlationId: "rename-old-name" });
  const oldNameError = await hubGotOldNameError;
  assert(oldNameError.type === "error", "DM to old name failed");
  if (oldNameError.type === "error") {
    assert(oldNameError.message.includes("not online"), `Old-name DM error: "${oldNameError.message}"`);
  }

  // Rename to taken name fails
  const scoutRenameTaken = waitForMessage(scout, (m) => m.type === "error");
  scout.send({ type: "rename", name: "worker" });
  const takenErr = await scoutRenameTaken;
  assert(takenErr.type === "error", "Rename to taken name failed");
  if (takenErr.type === "error") {
    assert(takenErr.message.toLowerCase().includes("taken"), `Taken-name error: "${takenErr.message}"`);
  }

  // ── Test 12: Disconnect ───────────────────────────────────────────
  console.log("\n--- Test 12: Disconnect ---");

  const hubGotLeft = waitForMessage(hub, (m) => m.type === "agent_left" && m.name === "worker");
  worker.close();
  const leftMsg = await hubGotLeft;
  assert(leftMsg.type === "agent_left", "Hub notified of worker leaving");
  if (leftMsg.type === "agent_left") {
    assert(leftMsg.name === "worker", `Left agent is "worker"`);
  }

  await sleep(100);
  assert(hub.getKnownAgents().length === 2, `Hub now knows 2 agents (hub + scout-renamed)`);

  // ── Test 13: File Reservations ───────────────────────────────────
  console.log("\n--- Test 13: File Reservations ---");

  // 1) Agent can reserve paths + all get reservations_updated
  const hubGotReserveUpdate1 = waitForMessage(
    hub,
    (m) => m.type === "reservations_updated" && !!m.reservations["scout-001"]
  );
  const scoutGotReserveUpdate1 = waitForMessage(
    scout,
    (m) => m.type === "reservations_updated" && !!m.reservations["scout-001"]
  );

  scout.reserve(["/repo/file.ts"], "refactoring core file");

  const [reserveUpdateHub1, reserveUpdateScout1] = await Promise.all([
    hubGotReserveUpdate1,
    scoutGotReserveUpdate1,
  ]);

  assert(
    reserveUpdateHub1.type === "reservations_updated" &&
      reserveUpdateHub1.reservations["scout-001"]?.paths.includes("/repo/file.ts"),
    "Hub received reservation update"
  );
  assert(
    reserveUpdateScout1.type === "reservations_updated" &&
      reserveUpdateScout1.reservations["scout-001"]?.paths.includes("/repo/file.ts"),
    "Scout received reservation update"
  );

  // 2) Second agent trying same path gets error
  const hubReserveConflict = waitForMessage(
    hub,
    (m) => m.type === "error" && m.message.includes("reserved")
  );
  hub.reserve(["/repo/file.ts"], "trying conflicting lock");
  const conflictError = await hubReserveConflict;
  assert(conflictError.type === "error", "Conflicting reservation rejected");
  if (conflictError.type === "error") {
    assert(conflictError.message.includes("scout-renamed"), `Conflict owner identified: "${conflictError.message}"`);
  }

  // 3) Directory reservation blocks file within it
  const hubGotReserveUpdate2 = waitForMessage(
    hub,
    (m) => m.type === "reservations_updated" && !!m.reservations["scout-001"]?.paths.includes("/repo/dir/")
  );
  scout.reserve(["/repo/dir/"], "directory lock");
  await hubGotReserveUpdate2;
  assert(true, "Directory reservation applied");

  const hubDirConflict = waitForMessage(
    hub,
    (m) => m.type === "error" && m.message.includes("reserved")
  );
  hub.reserve(["/repo/dir/sub/file.ts"], "attempt inside locked dir");
  const dirConflict = await hubDirConflict;
  assert(dirConflict.type === "error", "Directory reservation blocked nested file");

  // 4) Agent can release specific paths
  const hubGotReleaseSpecific = waitForMessage(
    hub,
    (m) => m.type === "reservations_updated"
  );
  scout.release(["/repo/file.ts"]);
  const releaseSpecific = await hubGotReleaseSpecific;
  assert(releaseSpecific.type === "reservations_updated", "Release specific path update broadcast");
  if (releaseSpecific.type === "reservations_updated") {
    const scoutRes = releaseSpecific.reservations["scout-001"];
    assert(!scoutRes?.paths.includes("/repo/file.ts"), "Specific file reservation released");
    assert(!!scoutRes?.paths.includes("/repo/dir/"), "Other reservation remained after partial release");
  }

  // 5) Agent can release all paths
  const hubGotReleaseAll = waitForMessage(
    hub,
    (m) => m.type === "reservations_updated" && !m.reservations["scout-001"]
  );
  scout.release();
  const releaseAll = await hubGotReleaseAll;
  assert(releaseAll.type === "reservations_updated", "Release-all broadcast received");
  if (releaseAll.type === "reservations_updated") {
    assert(!releaseAll.reservations["scout-001"], "All reservations cleared for scout");
  }

  // 6) Reservations auto-cleared on disconnect
  const locker = new HiveClient();
  await locker.connect(`ws://127.0.0.1:${port}`);
  const lockerRegistered = waitForMessage(locker, (m) => m.type === "registered");
  locker.register({
    id: "locker-001",
    name: "locker",
    role: "reservation test agent",
    cwd: "/test",
    interactive: true,
  });
  await lockerRegistered;

  const hubGotLockerReserve = waitForMessage(
    hub,
    (m) => m.type === "reservations_updated" && !!m.reservations["locker-001"]
  );
  locker.reserve(["/repo/locker.ts"], "temporary lock");
  const lockerReserved = await hubGotLockerReserve;
  assert(lockerReserved.type === "reservations_updated", "Locker reservation broadcast received");

  const hubGotLockerCleared = waitForMessage(
    hub,
    (m) => m.type === "reservations_updated" && !m.reservations["locker-001"]
  );
  locker.close();
  const lockerCleared = await hubGotLockerCleared;
  assert(lockerCleared.type === "reservations_updated", "Locker reservations auto-cleared on disconnect");

  // 7) New agent connecting receives current reservations
  const hubGotReserveForObserver = waitForMessage(
    hub,
    (m) => m.type === "reservations_updated" && !!m.reservations["scout-001"]
  );
  scout.reserve(["/repo/current.ts"], "active reservation for join test");
  await hubGotReserveForObserver;

  const observer = new HiveClient();
  await observer.connect(`ws://127.0.0.1:${port}`);
  const observerRegistered = waitForMessage(observer, (m) => m.type === "registered");
  observer.register({
    id: "observer-001",
    name: "observer",
    role: "reservation observer",
    cwd: "/test",
    interactive: true,
  });
  const observerReg = await observerRegistered;
  assert(observerReg.type === "registered", "Observer registered");
  if (observerReg.type === "registered") {
    const scoutReservation = observerReg.reservations["scout-001"];
    assert(!!scoutReservation, "Observer received current reservation map on connect");
    assert(
      !!scoutReservation?.paths.includes("/repo/current.ts"),
      "Observer sees scout reserved path from registered payload"
    );
  }

  observer.close();

  // Clean reservation state before final cleanup
  const hubGotFinalRelease = waitForMessage(
    hub,
    (m) => m.type === "reservations_updated" && !m.reservations["scout-001"]
  );
  scout.release();
  await hubGotFinalRelease;
  assert(true, "Reservation state reset before cleanup");

  // ── Test 14: Rich Presence ───────────────────────────────────────
  console.log("\n--- Test 14: Rich Presence ---");

  const presenceTimestamp = new Date().toISOString();
  const hubGotPresence = waitForMessage(
    hub,
    (m) =>
      m.type === "status_changed" &&
      m.name === "scout-renamed" &&
      m.statusMessage === "exploring"
  );

  scout.send({
    type: "presence_update",
    statusMessage: "exploring",
    lastActivityAt: presenceTimestamp,
  });

  const presenceMsg = await hubGotPresence;
  assert(presenceMsg.type === "status_changed", "Presence update broadcast as status_changed with statusMessage");
  if (presenceMsg.type === "status_changed") {
    assert(!!presenceMsg.lastActivityAt, "Presence broadcast includes lastActivityAt");
  }

  await sleep(100);
  const presenceInfo = hub.getAgentByName("scout-renamed");
  assert(presenceInfo?.statusMessage === "exploring", "Agent info includes statusMessage after presence update");
  assert(!!presenceInfo?.lastActivityAt, "Agent info includes lastActivityAt after presence update");

  const hubGotStatusWithPresence = waitForMessage(
    hub,
    (m) => m.type === "status_changed" && m.name === "scout-renamed" && m.status === "busy"
  );
  scout.send({ type: "status_update", status: "busy" });
  const statusWithPresence = await hubGotStatusWithPresence;
  assert(statusWithPresence.type === "status_changed", "Status update broadcast received");
  if (statusWithPresence.type === "status_changed") {
    assert(
      statusWithPresence.statusMessage === "exploring" && !!statusWithPresence.lastActivityAt,
      "Status changed includes statusMessage + lastActivityAt fields"
    );
  }

  // ── Cleanup ───────────────────────────────────────────────────────
  console.log("\n--- Cleanup ---");
  hub.close();
  scout.close();
  broker.stop();
  assert(true, "Broker stopped cleanly");

  // ── Summary ───────────────────────────────────────────────────────
  console.log(`\n${"=".repeat(50)}`);
  console.log(`🐝 Results: ${passed} passed, ${failed} failed`);
  console.log(`${"=".repeat(50)}\n`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

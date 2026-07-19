// cluster-launcher.js — run the Phase-B backend across multiple CPU cores.
// WHY: Node is single-threaded. After the 2026-07-08 dbapi outage, the App User poll herd (lock-status /
// heartbeat / plans-me / me every few seconds) all reconnected at once and pegged ONE core at ~110% while the
// other 31 sat idle — the event loop never drained, every request timed out, clients retried → congestion
// collapse. Forking N workers that SHARE the listening socket (Node cluster, SO_REUSEPORT round-robin on Linux)
// spreads the load across cores so the herd is absorbed. No change to server.js.
// CAVEAT: auth.js keeps admin/staff sessions + the auto-generated master token IN-MEMORY per process, so the
// WEB ADMIN may need re-login and can be flaky across workers until sessions move to the shared DB. App User
// auth is DB-backed (validated in dbapi) → unaffected. Set CENTRIX_BACKEND_WORKERS to tune (default 8).
const cluster = require("cluster");
const os = require("os");

const isPrimary = cluster.isPrimary !== undefined ? cluster.isPrimary : cluster.isMaster;
if (isPrimary) {
  const cores = (os.cpus() || []).length || 2;
  const N = Math.max(1, Math.min(16, Number(process.env.CENTRIX_BACKEND_WORKERS) || Math.min(8, cores)));
  console.log(`[cluster] launching ${N} backend workers on ${cores} cores`);
  for (let i = 0; i < N; i++) cluster.fork();
  cluster.on("exit", (worker, code, signal) => {
    console.error(`[cluster] worker pid=${worker.process.pid} exited (${signal || code}) — respawning`);
    setTimeout(() => cluster.fork(), 500); // small delay so a crash-loop can't spin the CPU
  });
  // RELAY: fan a worker's {cxRelay:1,...} message out to every OTHER worker. Dùng cho các dấu in-memory phải
  // đồng bộ cả cụm — cụ thể accountInteraction (auth.js): gate export check "client có tương tác gần đây" nhưng
  // dấu tương tác chỉ nằm ở worker đã phục vụ request thường → export rơi vào worker "lạnh" bị 403
  // no-client-interaction NGẪU NHIÊN (khách lúc nạp được profile lúc không). Relay khôi phục ngữ nghĩa 1-process.
  cluster.on("message", (worker, msg) => {
    if (!msg || msg.cxRelay !== 1) return;
    for (const id in cluster.workers) {
      const w = cluster.workers[id];
      if (w && w !== worker) { try { w.send(msg); } catch { /* worker đang chết — bỏ qua */ } }
    }
  });
} else {
  require("./server.js");
}

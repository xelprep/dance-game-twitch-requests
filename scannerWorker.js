const { parentPort } = require("node:worker_threads");
const { readSongFile } = require("./scanner");

if (parentPort) {
  parentPort.on("message", (task) => {
    if (!task) return;
    const { id, filePath, pack } = task;
    try {
      const song = readSongFile(filePath, pack);
      parentPort.postMessage({ id, ok: true, song });
    } catch (err) {
      parentPort.postMessage({ id, ok: false, error: err.message, filePath });
    }
  });
}

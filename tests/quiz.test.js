const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { io } = require("socket.io-client");

const PORT = 3187;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function connectClient() {
  return new Promise((resolve, reject) => {
    const socket = io(BASE, { reconnection: false, timeout: 3000 });
    const timer = setTimeout(() => reject(new Error("Socket connection timed out")), 5000);
    socket.once("connect", () => { clearTimeout(timer); resolve(socket); });
    socket.once("connect_error", error => { clearTimeout(timer); reject(error); });
  });
}
function emitAck(socket, event, ...args) {
  return new Promise(resolve => socket.emit(event, ...args, resolve));
}
async function waitForRoom(socket, predicate, label, timeout = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (socket.lastRoom && predicate(socket.lastRoom)) return socket.lastRoom;
    await sleep(20);
  }
  throw new Error("Timed out waiting for room state: " + label);
}

test("quiz room end-to-end feature checks", { timeout: 20000 }, async t => {
  const child = spawn(process.execPath, ["server.js"], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(PORT), ANSWER_TIME_LIMIT_SECONDS: "1" },
    stdio: "ignore"
  });
  const sockets = [];
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try {
        const response = await fetch(BASE);
        if (response.ok) { ready = true; break; }
      } catch {}
      await sleep(100);
    }
    assert.equal(ready, true, "server should start");

    const host = await connectClient(); sockets.push(host);
    const p1 = await connectClient(); sockets.push(p1);
    const p2 = await connectClient(); sockets.push(p2);
    for (const socket of sockets) socket.on("room:update", room => { socket.lastRoom = room; });

    const created = await emitAck(host, "room:create", "出題者", "host-token");
    assert.equal(created.ok, true, "room creation");
    const code = created.code;
    assert.ok(code, "room code should be returned");
    assert.equal((await emitAck(p1, "room:join", { code, name: "参加者1", token: "p1-token" })).ok, true);
    assert.equal((await emitAck(p2, "room:join", { code, name: "参加者2", token: "p2-token" })).ok, true);

    assert.equal((await emitAck(host, "question:start", { text: "テスト問題1" })).ok, true);
    await waitForRoom(p1, r => r.state === "question" && r.question?.text === "テスト問題1", "question start");
    p1.emit("buzz");
    let room = await waitForRoom(host, r => r.buzzed?.name === "参加者1", "first buzz");
    assert.ok(room.answerDeadline, "30-second deadline should be broadcast");
    assert.equal((await emitAck(p1, "answer:submit", "回答A")).ok, true);
    room = await waitForRoom(p2, r => r.answerResult?.verdict === "pending", "answer submit");
    assert.equal(room.answerResult.answer, "回答A");
    host.emit("answer:correct");
    room = await waitForRoom(p1, r => r.state === "ended" && r.answerResult?.verdict === "correct", "correct judgement");

    host.emit("question:next");
    await waitForRoom(p1, r => r.state === "lobby", "next question reset");
    assert.equal((await emitAck(host, "question:start", { text: "テスト問題2" })).ok, true);
    p1.emit("buzz");
    await waitForRoom(host, r => r.buzzed?.name === "参加者1", "second question buzz");
    assert.equal((await emitAck(p1, "answer:submit", "回答B")).ok, true);
    host.emit("answer:wrong");
    room = await waitForRoom(p2, r => r.blocked?.length === 1 && !r.buzzed, "wrong answer");
    assert.equal(room.answerResult.verdict, "wrong");
    p2.emit("buzz");
    await waitForRoom(host, r => r.buzzed?.name === "参加者2", "second player buzz");
    assert.equal((await emitAck(p2, "answer:submit", "回答C")).ok, true);
    host.emit("answer:wrong");
    room = await waitForRoom(p1, r => r.state === "ended" && r.allWrong, "all players wrong");
    assert.equal((await emitAck(host, "answer:reveal", { answer: "正解", note: "補足" })).ok, true);
    room = await waitForRoom(p2, r => r.revealedAnswer === "正解", "answer reveal");
    assert.equal(room.revealedNote, "補足");

    host.emit("question:next");
    await waitForRoom(p1, r => r.state === "lobby", "reset after reveal");
    assert.equal((await emitAck(host, "question:start", { text: "時間切れテスト" })).ok, true);
    p1.emit("buzz");
    room = await waitForRoom(p1, r => r.state === "question" && r.buzzed?.name === "参加者1", "timeout buzz");
    room = await waitForRoom(p1, r => r.blocked?.length === 1 && r.answerResult?.verdict === "wrong", "automatic timeout", 4000);
    assert.match(room.answerResult.answer, /時間切れ/);
    assert.equal(room.buzzed, null);
    p2.emit("buzz");
    room = await waitForRoom(host, r => r.buzzed?.name === "参加者2", "next player can buzz after timeout");
    assert.ok(room, "another player should be able to buzz after timeout");

    console.log("All quiz feature tests passed.");
  } finally {
    for (const socket of sockets) socket.disconnect();
    child.kill();
  }
});

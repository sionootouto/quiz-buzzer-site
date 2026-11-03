const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 8e6 });
app.use(express.static(path.join(__dirname, "public")));

const rooms = new Map();
const makeCode = () => crypto.randomBytes(3).toString("hex").toUpperCase();
const clean = (s, n=40) => String(s || "").trim().slice(0,n);

function publicRoom(room) {
  return {
    code: room.code, hostId: room.hostId, players: [...room.players.values()],
    question: room.question, state: room.state,
    buzzed: room.buzzed, blocked: [...room.blocked],
    message: room.message
  };
}
function emitRoom(room) { io.to(room.code).emit("room:update", publicRoom(room)); }
function getRoom(socket) {
  const code = socket.data.roomCode;
  return code && rooms.get(code);
}
function resetQuestion(room) {
  room.question = null; room.state = "lobby"; room.buzzed = null;
  room.blocked = new Set(); room.message = "次の問題を出題できます";
}
io.on("connection", socket => {
  socket.data.roomCode = null;
  socket.on("room:create", (name, cb) => {
    let code; do { code = makeCode(); } while (rooms.has(code));
    const player = { id: socket.id, name: clean(name,24) || "参加者" };
    const room = { code, hostId: socket.id, players: new Map([[socket.id,player]]),
      question: null, state: "lobby", buzzed: null, blocked: new Set(),
      message: "ルームを作成しました。参加者を待っています" };
    rooms.set(code, room); socket.join(code); socket.data.roomCode = code;
    cb?.({ok:true, code}); emitRoom(room);
  });
  socket.on("room:join", ({code,name}, cb) => {
    code = clean(code,8).toUpperCase(); const room = rooms.get(code);
    if (!room) return cb?.({ok:false,error:"ルームが見つかりません"});
    if (room.players.size >= 30) return cb?.({ok:false,error:"参加人数の上限です"});
    const player = { id: socket.id, name: clean(name,24) || "参加者" };
    room.players.set(socket.id,player); socket.join(code); socket.data.roomCode = code;
    room.message = `${player.name} が参加しました`; cb?.({ok:true}); emitRoom(room);
  });
  socket.on("question:start", ({text,image}, cb) => {
    const room=getRoom(socket); if(!room) return;
    if (!text || !String(text).trim()) return cb?.({ok:false,error:"問題文を入力してください"});
    if (room.state === "question") return cb?.({ok:false,error:"現在の問題を終了してください"});
    room.question = { text: clean(text,1200), image: typeof image==="string" && image.startsWith("data:image/") ? image : null, setterId:socket.id, setterName:room.players.get(socket.id)?.name || "出題者" };
    room.state="question"; room.buzzed=null; room.blocked=new Set(); room.message=`${room.question.setterName} が出題中`; cb?.({ok:true}); emitRoom(room);
  });
  socket.on("buzz", () => {
    const room=getRoom(socket); if(!room || room.state!=="question" || room.buzzed || room.blocked.has(socket.id) || socket.id===room.question.setterId) return;
    room.buzzed={id:socket.id,name:room.players.get(socket.id)?.name || "参加者"};
    room.message=`${room.buzzed.name} が早押し！回答してください`; emitRoom(room);
  });
  socket.on("answer:submit", (answer, cb) => {
    const room=getRoom(socket);
    if(!room || room.state!=="question" || room.buzzed?.id!==socket.id)
      return cb?.({ok:false,error:"回答できる状態ではありません"});
    const cleanAnswer=clean(answer,300);
    if(!cleanAnswer) return cb?.({ok:false,error:"回答を入力してください"});
    room.buzzed.answer=cleanAnswer;
    room.message=room.buzzed.name + " が回答を送信しました";
    cb?.({ok:true}); emitRoom(room);
  });
  socket.on("answer:wrong", () => {
    const room=getRoom(socket); if(!room || room.state!=="question" || room.buzzed?.id!==socket.id) return;
    room.blocked.add(socket.id); room.buzzed=null;
    const eligible=[...room.players.keys()].filter(id=>id!==room.question.setterId && !room.blocked.has(id));
    if(!eligible.length){ room.state="ended"; room.message="全員不正解！問題終了"; }
    else room.message=`不正解：${room.players.get(socket.id)?.name || "参加者"} はこの問題の回答権を失いました。他の人は早押しできます`;
    emitRoom(room);
  });
  socket.on("answer:correct", () => {
    const room=getRoom(socket); if(!room || room.state!=="question" || room.buzzed?.id!==socket.id) return;
    room.state="ended"; room.message=`正解！${room.players.get(socket.id)?.name || "参加者"} が正解`; emitRoom(room);
  });
  socket.on("question:end", () => {
    const room=getRoom(socket); if(!room || room.question?.setterId!==socket.id) return;
    room.state="ended"; room.message="出題者が問題を終了しました"; emitRoom(room);
  });
  socket.on("question:next", () => {
    const room=getRoom(socket); if(!room || room.state!=="ended") return;
    resetQuestion(room); emitRoom(room);
  });
  socket.on("disconnect", () => {
    const room=getRoom(socket); if(!room) return;
    room.players.delete(socket.id);
    if(room.hostId===socket.id) room.hostId=room.players.keys().next().value || null;
    if(room.question?.setterId===socket.id && room.state==="question"){room.state="ended";room.message="出題者が退出したため問題を終了しました";}
    if(!room.players.size){rooms.delete(room.code);return;}
    emitRoom(room);
  });
});
const port=process.env.PORT || 3000;
server.listen(port,()=>console.log(`Quiz server listening on ${port}`));

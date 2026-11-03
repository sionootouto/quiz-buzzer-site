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
const makeCode = () => String(crypto.randomInt(1000,10000));
const clean = (s, n=40) => String(s || "").trim().slice(0,n);
const ANSWER_TIME_LIMIT = Math.max(1, Number(process.env.ANSWER_TIME_LIMIT_SECONDS) || 30);
function clearAnswerTimer(room) {
  if (room.answerTimer) clearTimeout(room.answerTimer);
  room.answerTimer = null;
  room.answerDeadline = null;
}
function markWrong(room, answeredPlayer, reason="") {
  if(room.answerResult) {
    room.answerResult.verdict="wrong";
    if(reason) room.answerResult.answer=reason;
  } else {
    room.answerResult={name:answeredPlayer.name,answer:reason || "（時間切れ）",verdict:"wrong"};
  }
  room.blocked.add(answeredPlayer.id);
  room.buzzed=null;
  const eligible=[...room.players.keys()].filter(id=>id!==room.question.setterId && !room.blocked.has(id));
  if(!eligible.length){
    room.state="ended"; room.allWrong=true;
    room.message="全員不正解！出題者の正解発表を待っています";
  } else {
    room.message=reason ? `${answeredPlayer.name} は時間切れ！回答権を失いました。他の人は早押しできます` : `不正解：${answeredPlayer.name} はこの問題の回答権を失いました。他の人は早押しできます`;
  }
}

function publicRoom(room) {
  return {
    code: room.code, settings:room.settings, hostId: room.hostId, players: [...room.players.values()],
    question: room.question, state: room.state,
    buzzed: room.buzzed, answerDeadline: room.answerDeadline, answerResult: room.answerResult, allWrong: room.allWrong, revealedAnswer: room.revealedAnswer, revealedNote: room.revealedNote, blocked: [...room.blocked],
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
  clearAnswerTimer(room); room.answerResult = null; room.allWrong = false; room.revealedAnswer = null; room.revealedNote = null; room.blocked = new Set(); room.message = "次の問題を出題できます";
}
io.on("connection", socket => {
  socket.data.roomCode = null;
  socket.on("room:create", (name, token, settingsOrCb, maybeCb) => {
    const settings=typeof settingsOrCb==="object"&&settingsOrCb?settingsOrCb:{};
    const cb=typeof settingsOrCb==="function"?settingsOrCb:maybeCb;
    let code;
    if(settings.codeMode==="custom"){code=clean(settings.customCode,4);if(!/^\\d{4}$/.test(code))return cb?.({ok:false,error:"ルームコードは4桁の数字にしてください"});if(rooms.has(code))return cb?.({ok:false,error:"そのルームコードは使用中です"});}
    else {do { code = makeCode(); } while (rooms.has(code));}
    const player = { id: socket.id, token: clean(token,80), name: clean(name,24) || "参加者", connected: true };
    const room = { code, settings:{answerTime:[0,10,15,30,60].includes(Number(settings.answerTime))?Number(settings.answerTime):ANSWER_TIME_LIMIT,questionMode:["rotate","single","free"].includes(settings.questionMode)?settings.questionMode:"free",scoring:!!settings.scoring,penalties:{skip:!!settings.penalties?.skip,question:settings.penalties?.question!==false,minus:!!settings.penalties?.minus}}, hostId: socket.id, players: new Map([[socket.id,player]]),
      question: null, state: "lobby", buzzed: null, answerResult: null, answerDeadline: null, answerTimer: null, allWrong: false, revealedAnswer: null, revealedNote: null, blocked: new Set(),
      message: "ルームを作成しました。参加者を待っています" };
    rooms.set(code, room); socket.join(code); socket.data.roomCode = code;
    cb?.({ok:true, code}); emitRoom(room);
  });
  socket.on("room:join", ({code,name,token}, cb) => {
    code = clean(code,8).toUpperCase(); const room = rooms.get(code);
    if (!room) return cb?.({ok:false,error:"ルームが見つかりません"});
    
    const player = { id: socket.id, token: clean(token,80), name: clean(name,24) || "参加者", connected: true };
    room.players.set(socket.id,player); socket.join(code); socket.data.roomCode = code;
    room.message = `${player.name} が参加しました`; cb?.({ok:true}); emitRoom(room);
  });
  socket.on("room:rejoin", ({code,token}, cb) => {
    code = clean(code,8).toUpperCase();
    const room = rooms.get(code);
    if (!room || !token) return cb?.({ok:false,error:"ルームを再接続できませんでした。コードを入力して参加し直してください"});
    const entry = [...room.players.entries()].find(([, player]) => player.token === token);
    if (!entry) return cb?.({ok:false,error:"再接続できる参加者情報がありません。コードを入力して参加し直してください"});
    const [oldId, player] = entry;
    room.players.delete(oldId);
    player.id = socket.id;
    player.connected = true;
    delete player.disconnectedAt;
    room.players.set(socket.id, player);
    if (room.hostId === oldId) room.hostId = socket.id;
    if (room.question?.setterId === oldId) room.question.setterId = socket.id;
    if (room.buzzed?.id === oldId) room.buzzed.id = socket.id;
    if (room.blocked.has(oldId)) { room.blocked.delete(oldId); room.blocked.add(socket.id); }
    socket.join(code);
    socket.data.roomCode = code;
    room.message = player.name + " が再接続しました";
    cb?.({ok:true});
    emitRoom(room);
  });
  socket.on("question:start", ({text,image}, cb) => {
    const room=getRoom(socket); if(!room) return;
    if (!text || !String(text).trim()) return cb?.({ok:false,error:"問題文を入力してください"});
    if (room.state === "question") return cb?.({ok:false,error:"現在の問題を終了してください"});
    room.question = { text: clean(text,1200), image: typeof image==="string" && image.startsWith("data:image/") ? image : null, setterId:socket.id, setterName:room.players.get(socket.id)?.name || "出題者" };
    clearAnswerTimer(room); room.state="question"; room.buzzed=null; room.answerResult=null; room.allWrong=false; room.revealedAnswer=null; room.revealedNote=null; room.blocked=new Set(); room.message=`${room.question.setterName} が出題中`; cb?.({ok:true}); emitRoom(room);
  });
  socket.on("buzz", () => {
    const room=getRoom(socket); if(!room || room.state!=="question" || room.buzzed || room.blocked.has(socket.id) || socket.id===room.question.setterId) return;
    room.buzzed={id:socket.id,name:room.players.get(socket.id)?.name || "参加者"};
    const answerLimit=room.settings?.answerTime??ANSWER_TIME_LIMIT;\n    room.answerDeadline=answerLimit?Date.now()+answerLimit*1000:null;
    const buzzedId=socket.id;
    room.answerTimer=setTimeout(()=>{
      if(room.state!=="question" || room.buzzed?.id!==buzzedId) return;
      room.answerTimer=null; room.answerDeadline=null;
      const timedOutPlayer=room.buzzed;
      markWrong(room,timedOutPlayer,"（時間切れ）");
      emitRoom(room);
    },answerLimit*1000);\n    if(!answerLimit){clearTimeout(room.answerTimer);room.answerTimer=null;}
    room.message=`${room.buzzed.name} が早押し！回答してください`; emitRoom(room);
  });
  socket.on("answer:submit", (answer, cb) => {
    const room=getRoom(socket);
    if(!room || room.state!=="question" || room.buzzed?.id!==socket.id)
      return cb?.({ok:false,error:"回答できる状態ではありません"});
    const cleanAnswer=clean(answer,300);
    if(!cleanAnswer) return cb?.({ok:false,error:"回答を入力してください"});
    clearAnswerTimer(room);
    room.buzzed.answer=cleanAnswer;
    room.answerResult={name:room.buzzed.name,answer:cleanAnswer,verdict:"pending"};
    room.message=room.buzzed.name + " が回答を送信しました";
    cb?.({ok:true}); emitRoom(room);
  });
  socket.on("answer:wrong", () => {
    const room=getRoom(socket); if(!room || room.state!=="question" || room.question?.setterId!==socket.id || !room.buzzed) return;
    const answeredPlayer=room.buzzed;
    clearAnswerTimer(room);
    markWrong(room,answeredPlayer);
    emitRoom(room);
  });
  socket.on("answer:reveal", ({answer,note}, cb) => {
    const room=getRoom(socket);
    if(!room || room.state!=="ended" || !room.allWrong || room.question?.setterId!==socket.id)
      return cb?.({ok:false,error:"正解を発表できる状態ではありません"});
    const cleanAnswer=clean(answer,300);
    if(!cleanAnswer) return cb?.({ok:false,error:"正解を入力してください"});
    room.revealedAnswer=cleanAnswer;
    room.revealedNote=clean(note,1000);
    room.message="正解発表！";
    cb?.({ok:true});
    emitRoom(room);
  });
  socket.on("answer:correct", () => {
    const room=getRoom(socket); if(!room || room.state!=="question" || room.question?.setterId!==socket.id || !room.buzzed) return;
    clearAnswerTimer(room);
    if(room.answerResult) room.answerResult.verdict="correct";
    room.state="ended"; room.message=`正解！${room.buzzed.name} が正解`; emitRoom(room);
  });
  socket.on("question:end", () => {
    const room=getRoom(socket); if(!room || room.question?.setterId!==socket.id) return;
    clearAnswerTimer(room); room.state="ended"; room.message="出題者が問題を終了しました"; emitRoom(room);
  });
  socket.on("question:next", () => {
    const room=getRoom(socket); if(!room || room.state!=="ended" || room.question?.setterId!==socket.id) return;
    resetQuestion(room); emitRoom(room);
  });
  socket.on("disconnect", () => {
    const room=getRoom(socket); if(!room) return;
    const player = room.players.get(socket.id);
    if(!player) return;
    player.connected = false;
    player.disconnectedAt = Date.now();
    room.message = player.name + " の再接続を待っています";
    emitRoom(room);
    setTimeout(() => {
      const current = room.players.get(socket.id);
      if (current !== player || !current.disconnectedAt) return;
      room.players.delete(socket.id);
      if(room.hostId===socket.id) room.hostId=room.players.keys().next().value || null;
      if(room.question?.setterId===socket.id && room.state==="question"){clearAnswerTimer(room); room.state="ended";room.message="出題者が退出したため問題を終了しました";}
      if(!room.players.size){rooms.delete(room.code);return;}
      emitRoom(room);
    }, 60000);
  });
});
const port=process.env.PORT || 3000;
server.listen(port,()=>console.log(`Quiz server listening on ${port}`));

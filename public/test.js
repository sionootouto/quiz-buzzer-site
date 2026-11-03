const $=id=>document.getElementById(id);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const sockets=[];
function addResult(name,status,detail=""){
 const row=document.createElement("div");row.className="test-row";
 const badge=document.createElement("span");badge.className="test-status "+(status==="成功"?"pass":status==="失敗"?"fail":"running");badge.textContent=status;
 const label=document.createElement("strong");label.textContent=name;
 const note=document.createElement("span");note.className="test-note";note.textContent=detail;
 row.append(badge,label,note);$("results").append(row);return {badge,note};
}
function connectClient(){
 return new Promise((resolve,reject)=>{
  const socket=io({reconnection:false,timeout:5000});sockets.push(socket);
  const timer=setTimeout(()=>reject(new Error("接続タイムアウト")),6000);
  socket.once("connect",()=>{clearTimeout(timer);socket.lastRoom=null;socket.on("room:update",r=>socket.lastRoom=r);resolve(socket)});
  socket.once("connect_error",e=>{clearTimeout(timer);reject(e)});
 });
}
function emitAck(socket,event,...args){return new Promise(resolve=>socket.emit(event,...args,resolve))}
async function waitRoom(socket,predicate,label,timeout=6000){
 const start=Date.now();while(Date.now()-start<timeout){if(socket.lastRoom&&predicate(socket.lastRoom))return socket.lastRoom;await sleep(30)}
 throw new Error(label+" の状態確認がタイムアウトしました");
}
async function check(name,fn){
 const item=addResult(name,"実行中");
 try{const detail=await fn();item.badge.textContent="成功";item.badge.className="test-status pass";item.note.textContent=detail||""}
 catch(e){item.badge.textContent="失敗";item.badge.className="test-status fail";item.note.textContent=e.message;throw e}
}
$("run").onclick=async()=>{
 $("run").disabled=true;$("results").innerHTML="";$("summary").textContent="";
 try{
  let host,p1,p2,code;
  await check("テスト用接続・ルーム作成",async()=>{
   host=await connectClient();p1=await connectClient();p2=await connectClient();
   const r=await emitAck(host,"room:create","テスト出題者","test-host-"+Date.now());
   if(!r?.ok)throw Error(r?.error||"ルーム作成に失敗");
   code=r.code;
   for(const [socket,name,token] of [[p1,"テスト参加者1","test-p1-"+Date.now()],[p2,"テスト参加者2","test-p2-"+Date.now()]]){
    const joined=await emitAck(socket,"room:join",{code,name,token});if(!joined?.ok)throw Error(joined?.error||"参加に失敗");
   }
   return "3人のテスト用クライアントで接続";
  });
  await check("出題・早押し・回答送信",async()=>{
   let r=await emitAck(host,"question:start",{text:"自動テスト問題1"});if(!r?.ok)throw Error(r?.error);
   p1.emit("buzz");await waitRoom(host,x=>x.buzzed?.name==="テスト参加者1","早押し");
   r=await emitAck(p1,"answer:submit","テスト回答");if(!r?.ok)throw Error(r?.error);
   const room=await waitRoom(p2,x=>x.answerResult?.verdict==="pending","回答の共有");
   if(room.answerResult.answer!=="テスト回答")throw Error("回答内容が一致しません");
   return "回答が全員に共有された";
  });
  await check("正解判定・次の問題",async()=>{
   host.emit("answer:correct");await waitRoom(p1,x=>x.state==="ended"&&x.answerResult?.verdict==="correct","正解判定");
   host.emit("question:next");await waitRoom(p1,x=>x.state==="lobby","問題リセット");
   return "正解表示と問題リセットを確認";
  });
  await check("不正解・全員不正解・正解発表",async()=>{
   await emitAck(host,"question:start",{text:"自動テスト問題2"});
   p1.emit("buzz");await waitRoom(host,x=>x.buzzed?.name==="テスト参加者1","1人目の早押し");
   await emitAck(p1,"answer:submit","誤答1");host.emit("answer:wrong");
   await waitRoom(p2,x=>x.blocked.length===1&&!x.buzzed,"不正解処理");
   p2.emit("buzz");await waitRoom(host,x=>x.buzzed?.name==="テスト参加者2","2人目の早押し");
   await emitAck(p2,"answer:submit","誤答2");host.emit("answer:wrong");
   await waitRoom(p1,x=>x.state==="ended"&&x.allWrong,"全員不正解");
   const reveal=await emitAck(host,"answer:reveal",{answer:"テスト正解",note:"テスト備考"});if(!reveal?.ok)throw Error(reveal?.error);
   const room=await waitRoom(p2,x=>x.revealedAnswer==="テスト正解","正解発表");
   if(room.revealedNote!=="テスト備考")throw Error("備考が共有されません");
   return "全員不正解から正解・備考発表まで確認";
  });
  await check("30秒制限・時間切れ処理",async()=>{
   await emitAck(host,"question:next");await waitRoom(p1,x=>x.state==="lobby","リセット");
   await emitAck(host,"question:start",{text:"時間切れテスト"});
   p1.emit("buzz");await waitRoom(p1,x=>x.buzzed?.name==="テスト参加者1","早押し");
   const room=await waitRoom(p1,x=>x.blocked.length===1&&x.answerResult?.verdict==="wrong","30秒の時間切れ",35000);
   if(!String(room.answerResult.answer).includes("時間切れ"))throw Error("時間切れ表示がありません");
   p2.emit("buzz");await waitRoom(host,x=>x.buzzed?.name==="テスト参加者2","次の人の早押し");
   return "30秒経過後に不正解となり、次の人が早押しできた";
  });
  $("summary").textContent="すべてのテストに成功しました！";
 }catch(e){$("summary").textContent="テストが途中で失敗しました。上の失敗項目を確認してください。"}
 finally{sockets.forEach(s=>s.disconnect());sockets.length=0;$("run").disabled=false}
};
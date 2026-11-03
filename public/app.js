const socket=io();
const $=id=>document.getElementById(id);
let room=null, me=null, selectedImage=null, toastTimer;
function toast(msg){$("toast").textContent=msg;$("toast").classList.add("show");clearTimeout(toastTimer);toastTimer=setTimeout(()=>$("toast").classList.remove("show"),2600)}
function name(){return $("name").value.trim()||"参加者"}
function playerToken(){let token=sessionStorage.getItem("quizPlayerToken");if(!token){token=crypto.randomUUID?crypto.randomUUID():String(Date.now())+Math.random();sessionStorage.setItem("quizPlayerToken",token)}return token}
function saveRoomSession(code){sessionStorage.setItem("quizRoomSession",JSON.stringify({code,name:name(),token:playerToken()}))}
function showGame(code){$("entry").hidden=true;$("game").hidden=false;$("roomCode").textContent=code}
function showEntry(){ $("entry").hidden=false;$("game").hidden=true;room=null;me=null}
$("create").onclick=()=>socket.emit("room:create",name(),playerToken(),r=>{if(!r.ok)return toast(r.error);me=socket.id;saveRoomSession(r.code);showGame(r.code);toast("ルームを作りました")});
$("join").onclick=()=>socket.emit("room:join",{code:$("code").value,name:name(),token:playerToken()},r=>{if(!r.ok)return toast(r.error);me=socket.id;saveRoomSession($("code").value.trim().toUpperCase());showGame($("code").value.trim().toUpperCase());toast("参加しました")});
$("copy").onclick=async()=>{try{await navigator.clipboard.writeText(room.code);toast("ルームコードをコピーしました")}catch{toast("ルームコード："+room.code)}};
$("leave").onclick=()=>{sessionStorage.removeItem("quizRoomSession");sessionStorage.removeItem("quizPlayerToken");socket.disconnect();location.reload()};
$("photo").onchange=()=>{const f=$("photo").files[0];if(!f)return;if(f.size>5*1024*1024){toast("写真は5MB以下にしてください");$("photo").value="";return}const reader=new FileReader();reader.onload=()=>{const img=new Image();img.onload=()=>{const c=document.createElement("canvas"),max=1400,scale=Math.min(1,max/Math.max(img.width,img.height));c.width=Math.round(img.width*scale);c.height=Math.round(img.height*scale);c.getContext("2d").drawImage(img,0,0,c.width,c.height);selectedImage=c.toDataURL("image/jpeg",.82);$("preview").src=selectedImage;$("preview").hidden=false};img.src=reader.result};reader.readAsDataURL(f)};
$("startQuestion").onclick=()=>socket.emit("question:start",{text:$("questionText").value.trim()||"写真を見て答えてください",image:selectedImage},r=>{if(!r.ok)toast(r.error);else{$("questionText").value="";$("photo").value="";selectedImage=null;$("preview").hidden=true}});
$("correct").onclick=()=>socket.emit("answer:correct");
$("wrong").onclick=()=>socket.emit("answer:wrong");
$("endQuestion").onclick=()=>socket.emit("question:end");
$("next").onclick=()=>socket.emit("question:next");
socket.on("room:update",r=>{room=r;me=socket.id;showGame(r.code);render()});
function render(){
$("count").textContent=room.players.length;$("stateBadge").textContent=room.state==="question"?"出題中":room.state==="ended"?"問題終了":"待機中";$("statusText").textContent=room.message||"";
$("playerList").innerHTML="";room.players.forEach(p=>{const li=document.createElement("li");li.textContent=p.name+(p.connected===false?"（再接続待ち）":"");if(p.id===me)li.classList.add("me");if(room.question&&p.id===room.question.setterId)li.classList.add("setter");if(room.buzzed&&p.id===room.buzzed.id)li.classList.add("buzzed");if(room.blocked.includes(p.id))li.classList.add("blocked");$("playerList").append(li)});
const q=$("questionArea");q.innerHTML="";
if(room.question){const text=document.createElement("div");text.className="question";text.textContent=room.question.text;q.append(text);if(room.question.image){const img=document.createElement("img");img.className="question-image";img.src=room.question.image;img.alt="出題画像";q.append(img)}
if(room.buzzed){const box=document.createElement("div");box.className="answerbox";const strong=document.createElement("strong");strong.textContent="⚡ "+room.buzzed.name+" が回答中";const p=document.createElement("p");if(room.buzzed.id===me){if(room.buzzed.answer){p.textContent="回答を送信しました。出題者の判定を待っています。"}else{p.textContent="答えを入力して送信してください。";const form=document.createElement("form");form.className="answer-form";const input=document.createElement("input");input.type="text";input.maxLength=300;input.placeholder="ここに回答を入力";input.autocomplete="off";input.setAttribute("aria-label","回答");const button=document.createElement("button");button.type="submit";button.className="primary";button.textContent="回答を送信";form.append(input,button);form.onsubmit=e=>{e.preventDefault();const answer=input.value.trim();if(!answer)return toast("回答を入力してください");button.disabled=true;socket.emit("answer:submit",answer,r=>{if(!r?.ok){button.disabled=false;toast(r?.error||"回答を送信できませんでした")}else toast("回答を送信しました")})};box.append(strong,p,form)}}else if(room.question.setterId===me){p.textContent=room.buzzed.answer?("回答："+room.buzzed.answer):"回答入力待ちです";}else{p.textContent="回答入力中です";}if(!box.contains(strong))box.append(strong,p);q.append(box)}
}else q.innerHTML='<div class="empty">まだ問題はありません。誰でも出題できます！</div>';
const setter=room.question&&room.question.setterId===me;
$("setterTools").hidden=room.state==="question"||room.state==="ended";
$("judgeTools").hidden=!(setter&&room.state==="question"&&room.buzzed);
if(setter&&room.state==="question"&&room.buzzed){$("answerForJudge").textContent=room.buzzed.answer?("届いた回答："+room.buzzed.answer):"回答者が回答を入力しています…";}
$("nextTools").hidden=room.state!=="ended";
$("startQuestion").disabled=room.state==="question";
$("buzzerArea").innerHTML="";
if(room.state==="question"&&!setter&&!room.buzzed&&!room.blocked.includes(me)){const b=document.createElement("button");b.className="primary wide";b.style.marginTop="15px";b.style.fontSize="1.25rem";b.style.padding="20px";b.textContent="⚡ 早押し！";b.onclick=()=>socket.emit("buzz");$("buzzerArea").append(b)}
}
socket.on("connect",()=>{
  const saved=sessionStorage.getItem("quizRoomSession");
  if(!saved)return;
  try{
    const session=JSON.parse(saved);
    socket.emit("room:rejoin",{code:session.code,token:session.token},r=>{
      if(!r?.ok){sessionStorage.removeItem("quizRoomSession");toast(r?.error||"再接続できませんでした")}
      else{me=socket.id;showGame(session.code);toast("ルームに再接続しました")}
    });
  }catch{sessionStorage.removeItem("quizRoomSession")}
});
socket.on("connect_error",()=>toast("サーバーに接続できません。公開URLを確認してください。"));

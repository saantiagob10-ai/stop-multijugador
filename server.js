const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 3000;
const rooms = new Map();
const letters = "ABCDEFGHIJKLMNÑOPQRSTUVWXYZ".split("");
const categories = ["Nombre","Apellido","Animal","País/Ciudad","Comida","Objeto","Canción"];

app.get("/", (_, res) => res.json({ ok: true, app: "STOP Multijugador" }));
app.get("/health", (_, res) => res.json({ ok: true }));

function clean(v) { return String(v || "").trim(); }
function norm(v) { return clean(v).toLocaleLowerCase("es"); }
function code() {
  let c;
  do c = String(Math.floor(1000 + Math.random() * 9000));
  while (rooms.has(c));
  return c;
}
function publicRoom(r) {
  return {
    code: r.code, hostId: r.hostId, phase: r.phase, round: r.round,
    letter: r.letter, endsAt: r.endsAt,
    players: [...r.players.values()].map(p => ({id:p.id,name:p.name,total:p.total}))
  };
}
function emitRoom(r) { io.to(r.code).emit("room:update", publicRoom(r)); }

io.on("connection", socket => {
  socket.on("room:create", ({name}={}, cb=()=>{}) => {
    name = clean(name);
    if (!name) return cb({ok:false,error:"Escribe tu nombre"});
    const c = code();
    const r = {code:c, hostId:socket.id, phase:"lobby", round:0, letter:null,
      endsAt:null, timer:null, players:new Map(), answers:new Map()};
    r.players.set(socket.id,{id:socket.id,name,total:0});
    rooms.set(c,r); socket.join(c); socket.data.roomCode=c;
    emitRoom(r); cb({ok:true,code:c});
  });

  socket.on("room:join", ({code:c,name}={}, cb=()=>{}) => {
    c = clean(c); name = clean(name); const r=rooms.get(c);
    if (!r) return cb({ok:false,error:"Sala no encontrada"});
    if (r.players.size >= 10) return cb({ok:false,error:"Sala llena"});
    if (r.phase !== "lobby") return cb({ok:false,error:"La ronda ya empezó"});
    if (!name) return cb({ok:false,error:"Escribe tu nombre"});
    r.players.set(socket.id,{id:socket.id,name,total:0});
    socket.join(c); socket.data.roomCode=c; emitRoom(r); cb({ok:true,code:c});
  });

  socket.on("round:start", (_, cb=()=>{}) => {
    const r=rooms.get(socket.data.roomCode);
    if (!r || r.hostId!==socket.id) return cb({ok:false,error:"Solo el anfitrión puede iniciar"});
    if (r.players.size < 2) return cb({ok:false,error:"Se necesitan al menos 2 jugadores"});
    if (r.timer) clearTimeout(r.timer);
    r.round++; r.phase="playing"; r.answers=new Map();
    r.letter=letters[Math.floor(Math.random()*letters.length)];
    r.endsAt=Date.now()+60000;
    r.timer=setTimeout(()=>finish(r,"time"),60000);
    io.to(r.code).emit("round:start",{round:r.round,letter:r.letter,endsAt:r.endsAt,categories});
    emitRoom(r); cb({ok:true});
  });

  socket.on("answers:submit", ({answers}={}, cb=()=>{}) => {
    const r=rooms.get(socket.data.roomCode);
    if (!r || r.phase!=="playing") return cb({ok:false,error:"No hay ronda activa"});
    const safe={}; for (const cat of categories) safe[cat]=clean(answers?.[cat]);
    r.answers.set(socket.id,safe); cb({ok:true});
  });

  socket.on("round:stop", ({answers}={}, cb=()=>{}) => {
    const r=rooms.get(socket.data.roomCode);
    if (!r || r.phase!=="playing") return cb({ok:false,error:"No hay ronda activa"});
    const safe={}; for (const cat of categories) safe[cat]=clean(answers?.[cat]);
    r.answers.set(socket.id,safe); finish(r,"stop",socket.id); cb({ok:true});
  });

  socket.on("disconnect", () => {
    const r=rooms.get(socket.data.roomCode); if (!r) return;
    r.players.delete(socket.id); r.answers.delete(socket.id);
    if (!r.players.size) { if(r.timer) clearTimeout(r.timer); rooms.delete(r.code); return; }
    if (r.hostId===socket.id) r.hostId=[...r.players.keys()][0];
    emitRoom(r);
  });
});

function finish(r, reason, stoppedBy=null) {
  if (r.phase!=="playing") return;
  if (r.timer) clearTimeout(r.timer); r.timer=null; r.phase="results"; r.endsAt=null;
  const rows=[...r.players.values()].map(p=>({id:p.id,name:p.name,answers:r.answers.get(p.id)||{},points:{},roundTotal:0,total:p.total}));
  for (const cat of categories) {
    const counts=new Map();
    for (const row of rows) {
      const a=norm(row.answers[cat]);
      const valid=a && a[0]?.toLocaleUpperCase("es")===r.letter.toLocaleUpperCase("es");
      if (valid) counts.set(a,(counts.get(a)||0)+1);
    }
    for (const row of rows) {
      const a=norm(row.answers[cat]);
      const valid=a && a[0]?.toLocaleUpperCase("es")===r.letter.toLocaleUpperCase("es");
      const pts=!valid?0:(counts.get(a)>1?50:100);
      row.points[cat]=pts; row.roundTotal+=pts;
    }
  }
  for (const row of rows) {
    const p=r.players.get(row.id); p.total += row.roundTotal; row.total=p.total;
  }
  io.to(r.code).emit("round:results",{round:r.round,letter:r.letter,reason,stoppedBy,categories,rows});
  emitRoom(r);
}

server.listen(PORT, "0.0.0.0", () => console.log(`STOP server listening on ${PORT}`));

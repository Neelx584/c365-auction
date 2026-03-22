import { useState, useRef, useEffect, useCallback } from "react";
import * as XLSX from "xlsx";

/* ── Firebase (loaded via CDN in useEffect) ─────────────────────────────── */
let fbApp=null, fbDb=null, fbRef=null, fbSet=null, fbOnValue=null, fbOff=null;
async function loadFirebase() {
  if(fbDb) return fbDb;
  const [appMod, dbMod] = await Promise.all([
    import("https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js"),
    import("https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js"),
  ]);
  fbRef      = dbMod.ref;
  fbSet      = dbMod.set;
  fbOnValue  = dbMod.onValue;
  fbOff      = dbMod.off;
  return { initApp: appMod.initializeApp, getDb: dbMod.getDatabase };
}

const ROLES = ["BAT", "BOWL", "AR", "WK"];
const ROLE_COLOR = { BAT: "#38bdf8", BOWL: "#f87171", AR: "#4ade80", WK: "#c084fc" };
const ROLE_BG    = { BAT: "#0c1e2e", BOWL: "#2a1212", AR: "#0d2618", WK: "#1e0f2e" };
const DEFAULT_INCS = [0.25, 0.5, 1, 2];
const TEAM_COLORS = ["#b09dff","#00f0ff","#00ff88","#ffe040","#ff5577","#ff8c00","#40c4ff","#ff40aa","#a0ff40","#c084fc","#38bdf8"];

const uid = () => Math.random().toString(36).slice(2, 9);
const crFmt = v => (v != null && v !== "") ? `₹${Number(v).toFixed(2)} Cr` : "—";

/* ── Role derived from set-name prefix ── */


function parseSheet(sheet, sheetName) {
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
  return rows.filter(r => {
    const first = r["Name"] || r["name"] || r["PLAYER"] || r["Player"] || Object.values(r)[0];
    return first && String(first).trim() !== "";
  }).map(r => {
    const name = String(r["Name"]||r["name"]||r["PLAYER"]||r["Player"]||Object.values(r)[0]||"Unknown").trim();
    const rawRole = (r["Role"]||r["role"]||r["ROLE"]||"BAT").toString().toUpperCase().trim();
    const role = ROLES.includes(rawRole) ? rawRole : "BAT";
    const basePrice = parseFloat(r["Base Price"]||r["BasePrice"]||r["base_price"]||r["Price"]||0.20)||0.20;
    const overseas = ["yes","true","1","overseas"].includes((r["Overseas"]||r["overseas"]||r["OVERSEAS"]||"").toString().toLowerCase());
    return { id: uid(), name, role, basePrice, overseas, set: sheetName };
  });
}


export default function App() {
  const [screen, setScreen]   = useState("login");
  const [teams, setTeams]     = useState([]);
  const [sets, setSets]       = useState([]);
  const [auction, setAuction] = useState(null);
  const [role, setRole]       = useState(null); // "host" | teamId
  const [roleLabel, setRoleLabel] = useState("");
  const [roomCode, setRoomCode]   = useState("");
  const [fbConfig, setFbConfig]   = useState(null);
  const [syncStatus, setSyncStatus] = useState("local"); // local | connecting | live | error
  const fbUnsub = useRef(null);
  const [saves, setSaves] = useState(() => {
    try { return JSON.parse(localStorage.getItem("c365_saves")||"[]"); } catch { return []; }
  });

  const saveAuction = (label) => {
    const entry = { id: uid(), label: label||("Save "+new Date().toLocaleDateString("en-GB")), savedAt: Date.now(), auction, teams, sets };
    const updated = [entry, ...saves].slice(0, 20); // keep latest 20
    setSaves(updated);
    localStorage.setItem("c365_saves", JSON.stringify(updated));
    return entry.label;
  };

  const deleteSave = (id) => {
    const updated = saves.filter(s=>s.id!==id);
    setSaves(updated);
    localStorage.setItem("c365_saves", JSON.stringify(updated));
  };

  const resumeSave = (entry) => {
    setTeams(entry.teams||[]);
    setSets(entry.sets||[]);
    setAuction({...entry.auction, timerRunning:false});
    setRole("host"); setRoleLabel("Host");
    setScreen("auction");
  };


  const startAuction = async (hostPin, timerSecs, cfg, code) => {
    const queue = sets.filter(s=>!s.isAccelerated).flatMap(s=>s.players.map(p=>({...p,set:s.name,increments:s.increments,setTimer:s.timerSecs})));
    const initialState = { queue, sets, current:null, currentBid:0, currentBidder:null, bidHistory:[], sold:[], unsold:[], accelPool:[], status:"idle", teams:teams.map(t=>({...t,players:[]})), currentIncrements:DEFAULT_INCS, hostPin, defaultTimer:timerSecs, timerLeft:timerSecs, timerRunning:false };
    if(cfg && code) {
      try {
        setSyncStatus("connecting");
        const { initApp, getDb } = await loadFirebase();
        if(!fbApp) fbApp = initApp(cfg, "c365-auction-" + Math.random());
        fbDb = getDb(fbApp);
        const path = fbRef(fbDb, `rooms/${code}/auction`);
        await fbSet(path, initialState);
        setFbConfig(cfg); setRoomCode(code);
        subscribeToRoom(code);
        setSyncStatus("live");
      } catch(e) {
        console.error("Firebase error:", e);
        setSyncStatus("error");
        setAuction(initialState);
      }
    } else {
      setAuction(initialState);
      setSyncStatus("local");
    }
    setScreen("auction");
  };

  const subscribeToRoom = (code) => {
    if(!fbDb) return;
    const path = fbRef(fbDb, `rooms/${code}/auction`);
    if(fbUnsub.current) fbOff(fbUnsub.current);
    fbOnValue(path, snap => {
      const val = snap.val();
      if(val) setAuction(val);
    });
    fbUnsub.current = path;
  };

  const joinRoom = async (cfg, code) => {
    try {
      setSyncStatus("connecting");
      const { initApp, getDb } = await loadFirebase();
      if(!fbApp) fbApp = initApp(cfg, "c365-auction-" + Math.random());
      fbDb = getDb(fbApp);
      setFbConfig(cfg); setRoomCode(code);
      subscribeToRoom(code);
      setSyncStatus("live");
    } catch(e) {
      console.error("Firebase join error:", e);
      setSyncStatus("error");
    }
  };

  // Wrapped setAuction that also writes to Firebase
  const setAuctionSync = useCallback((updater) => {
    if(fbDb && roomCode) {
      setAuction(prev => {
        const next = typeof updater === "function" ? updater(prev) : updater;
        fbSet(fbRef(fbDb, `rooms/${roomCode}/auction`), next).catch(console.error);
        return next;
      });
    } else {
      setAuction(updater);
    }
  }, [roomCode]);

  return (
    <div style={{fontFamily:"'Inter',sans-serif",minHeight:"100vh",background:"#050508",color:"#e2e8f0"}}>
      <style>{CSS}</style>
      <GlowCanvas />
      <TopBar screen={screen} setScreen={setScreen} hasAuction={!!auction} role={role} roleLabel={roleLabel} syncStatus={syncStatus} />
      {screen==="login"   && <LoginScreen teams={teams} auction={auction} syncStatus={syncStatus} saves={saves} onDeleteSave={deleteSave} onResumeSave={resumeSave} onLogin={(r,lbl,cfg,code)=>{setRole(r);setRoleLabel(lbl);if(cfg&&code&&r!=="host"){joinRoom(cfg,code);}setScreen(r==="host"?"setup":"auction");}} />}
      {screen==="setup"   && role==="host" && <SetupScreen teams={teams} setTeams={setTeams} sets={sets} setSets={setSets} onStart={startAuction} syncStatus={syncStatus} />}
      {screen==="auction" && auction && <AuctionScreen auction={auction} setAuction={setAuctionSync} setScreen={setScreen} role={role} syncStatus={syncStatus} onSave={saveAuction} />}
      {screen==="results" && auction && <ResultsScreen auction={auction} onSave={saveAuction} />}
    </div>
  );
}

/* ── Animated background glow canvas ── */
function GlowCanvas() {
  const canvasRef = useRef();
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    let frame = 0;
    let animId;
    const resize = () => { canvas.width = window.innerWidth; canvas.height = window.innerHeight; };
    resize();
    window.addEventListener("resize", resize);

    const orbs = [
      { x:0.15, y:0.2,  r:320, hue:260, speed:0.0007 },
      { x:0.85, y:0.15, r:280, hue:180, speed:0.001  },
      { x:0.5,  y:0.75, r:350, hue:300, speed:0.0005 },
      { x:0.75, y:0.6,  r:200, hue:200, speed:0.0012 },
    ];

    const draw = () => {
      frame++;
      ctx.clearRect(0,0,canvas.width,canvas.height);
      orbs.forEach((o,i) => {
        const px = (o.x + Math.sin(frame*o.speed + i)*0.06) * canvas.width;
        const py = (o.y + Math.cos(frame*o.speed*1.3 + i)*0.04) * canvas.height;
        const hue = (o.hue + frame*0.05) % 360;
        const grad = ctx.createRadialGradient(px,py,0,px,py,o.r);
        grad.addColorStop(0, `hsla(${hue},100%,65%,0.12)`);
        grad.addColorStop(0.4, `hsla(${hue+40},100%,60%,0.055)`);
        grad.addColorStop(1, "transparent");
        ctx.fillStyle = grad;
        ctx.fillRect(0,0,canvas.width,canvas.height);
      });
      animId = requestAnimationFrame(draw);
    };
    draw();
    return () => { cancelAnimationFrame(animId); window.removeEventListener("resize",resize); };
  }, []);
  return <canvas ref={canvasRef} style={{position:"fixed",inset:0,pointerEvents:"none",zIndex:0}} />;
}

/* ── TOP BAR ── */
function TopBar({ screen, setScreen, hasAuction, role, roleLabel, syncStatus }) {
  const [showHelp, setShowHelp] = useState(false);
  return (
    <div className="topbar">
      <div className="logo-wrap">
        <img src="data:image/jpeg;base64,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" className="logo-img" alt="C365" />
        <span className="logo-sub">AUCTION ROOM</span>
      </div>
      <div className="topbar-nav">
        {role==="host" && <button className={`tnav ${screen==="setup"?"tnav-on":""}`} onClick={()=>setScreen("setup")}>Setup</button>}
        <button className={`tnav ${screen==="auction"?"tnav-on":""}`} disabled={!hasAuction} onClick={()=>setScreen("auction")}>Live Auction</button>
        <button className={`tnav ${screen==="results"?"tnav-on":""}`} disabled={!hasAuction} onClick={()=>setScreen("results")}>Squads</button>
      </div>
      {role && <div className={`role-badge ${role==="host"?"role-host":"role-team"}`}>{role==="host"?"🎙 HOST":roleLabel}</div>}
      {syncStatus && syncStatus!=="local" && (
        <div className={`sync-badge sync-${syncStatus}`}>
          {syncStatus==="live"?"🟢 LIVE":syncStatus==="connecting"?"⏳":syncStatus==="error"?"🔴 ERR":""}
        </div>
      )}
      <button className="help-btn" onClick={()=>setShowHelp(true)} title="Help">?</button>
      {showHelp && <HelpModal role={role} onClose={()=>setShowHelp(false)} />}
    </div>
  );
}


/* ── HELP MODAL ── */
function HelpModal({ role, onClose }) {
  const [tab, setTab] = useState(role==="host" ? "host" : "player");

  const hostSteps = [
    {
      icon: "⚙️",
      title: "Step 1 — Setup",
      items: [
        "Go to the Setup screen (only visible to you as host).",
        "Add each franchise under Franchises — set their Budget, Max Squad size, Min Wicketkeepers, and Max Overseas players.",
        "Add each player's Discord username to their team so they can log in.",
        "Upload your player spreadsheet (.xlsx). Each sheet tab becomes a set (e.g. Marquee, Accelerators).",
        "Inside each set, set the 4 bid increments and a per-set timer if you want it different from the default.",
      ]
    },
    {
      icon: "🔥",
      title: "Step 2 — Live Sync (optional but recommended)",
      items: [
        "Click 🔥 Enable Live Sync in Host Settings.",
        "Paste your Firebase API Key and Project ID.",
        "A Room Code is auto-generated — share it, your API Key, and Project ID with all players via Discord DM.",
        "Once Firebase is configured, Begin Auction writes the state to the cloud and shows 🟢 LIVE in the top bar.",
      ]
    },
    {
      icon: "🎙",
      title: "Step 3 — Running the Auction",
      items: [
        "Set a Host PIN and a default bid timer, then click Begin Auction.",
        "In the Live Auction screen, click 🎲 Draw Next Player to randomly pick a player from the current set.",
        "Players bid using the quick-increment buttons or by typing a custom amount. Only bids above the current price are accepted.",
        "Budget, squad size, WK, and overseas limits are all enforced automatically.",
        "Click ✅ SOLD to confirm the sale, or ✕ Unsold to pass.",
        "Timer controls: Pause/Resume, +15s, and Reset are visible only to you.",
      ]
    },
    {
      icon: "⚡",
      title: "Step 4 — Accelerated Round",
      items: [
        "Once the main queue is empty, click ⚡ Open Accelerated Round.",
        "Unsold players appear on the left — click → to move them into the pool on the right.",
        "Draw from the Accelerated Pool to re-auction them, one at a time.",
        "You can remove a player from the pool (sends them back to Unsold) at any time.",
      ]
    },
    {
      icon: "🏆",
      title: "Step 5 — Finishing",
      items: [
        "Click End Auction at any time — a confirmation modal will show remaining players before confirming.",
        "After ending, click View Final Squads to see all teams and their players.",
      ]
    },
  ];

  const playerSteps = [
    {
      icon: "🔐",
      title: "Joining the Auction",
      items: [
        "Open the auction URL shared by your host.",
        "Click Join with Discord on the login screen.",
        "Enter your Discord username exactly as it appears in Discord (no # number).",
        "If the host has set up live sync, also enter the Room Code, Firebase Project ID, and API Key they shared.",
        "You'll be matched to your team automatically.",
      ]
    },
    {
      icon: "👀",
      title: "Watching the Auction",
      items: [
        "The left panel shows all franchises with their budget, squad count, WK count, and overseas slots.",
        "The center shows the current player being auctioned — their set, role, base price, and the live bid.",
        "The right panel shows the live bid log and recently sold players.",
        "You'll see a 🟢 LIVE badge in the top bar when you're synced to the host's auction in real time.",
      ]
    },
    {
      icon: "💸",
      title: "Placing Bids",
      items: [
        "When it's your turn to bid, your team name and remaining budget are shown above the bidding controls.",
        "Use the quick-increment buttons (+0.25, +0.5, +1, +2 Cr) to raise the bid fast.",
        "Or type a custom amount in the box and press Enter or click Place Bid.",
        "Your bid must be higher than the current bid. You'll get an alert if you can't afford it, your squad is full, or you've hit your overseas limit.",
        "The timer resets every time someone bids. If it hits zero with no bids, the player is Unsold.",
        "If you're the leading bidder when the host clicks SOLD, the player joins your squad.",
      ]
    },
    {
      icon: "🏟",
      title: "Your Squad",
      items: [
        "Click Squads in the top bar at any time to see all teams and their current rosters.",
        "Your squad is colour-coded by role: BAT, BOWL, AR, WK.",
        "Overseas players are marked with ✈️. WK and overseas counts are shown against your limits.",
      ]
    },
  ];

  const steps = tab === "host" ? hostSteps : playerSteps;

  return (
    <div className="help-overlay" onClick={onClose}>
      <div className="help-modal" onClick={e=>e.stopPropagation()}>
        <button className="help-close" onClick={onClose}>✕</button>
        <div className="help-header">
          <div className="help-title">How to use C365 Auction Room</div>
          <div className="help-tabs">
            <button className={`help-tab ${tab==="host"?"help-tab-on":""}`} onClick={()=>setTab("host")}>🎙 Host Guide</button>
            <button className={`help-tab ${tab==="player"?"help-tab-on":""}`} onClick={()=>setTab("player")}>🏟 Player Guide</button>
          </div>
        </div>
        <div className="help-body">
          {steps.map((section, si) => (
            <div key={si} className="help-section">
              <div className="help-section-title">
                <span className="help-section-icon">{section.icon}</span>
                {section.title}
              </div>
              <ul className="help-list">
                {section.items.map((item, ii) => (
                  <li key={ii} className="help-item">{item}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}


/* ── LOGIN / ROLE SELECT ── */
function LoginScreen({ teams, auction, syncStatus, saves, onDeleteSave, onResumeSave, onLogin }) {
  const [mode, setMode] = useState("pick"); // pick | hostpin | discord
  const [pin, setPin] = useState("");
  const [discordName, setDiscordName] = useState("");
  const [joinRoomCode, setJoinRoomCode] = useState("");
  const [joinApiKey, setJoinApiKey] = useState("");
  const [joinProjectId, setJoinProjectId] = useState("");
  const [err, setErr] = useState("");

  const tryHost = () => {
    if (!auction) { onLogin("host","Host"); return; }
    if (pin === auction.hostPin) { onLogin("host","Host"); }
    else { setErr("Incorrect PIN"); setPin(""); }
  };

  const tryDiscord = () => {
    const name = discordName.trim().toLowerCase();
    if(!name) { setErr("Enter your Discord username"); return; }
    const matched = teams.find(t=>(t.discordUsers||[]).includes(name));
    const fbCfg = joinApiKey && joinProjectId ? { apiKey:joinApiKey, authDomain:`${joinProjectId}.firebaseapp.com`, databaseURL:`https://${joinProjectId}-default-rtdb.firebaseio.com`, projectId:joinProjectId, storageBucket:`${joinProjectId}.appspot.com`, messagingSenderId:"000000000000", appId:"1:000000000000:web:000000" } : null;
    if(matched){
      onLogin(matched.id, matched.name, fbCfg, joinRoomCode||null);
      return;
    }
    // If no teams loaded yet but they have room code, try to join by room only
    if(joinRoomCode && fbCfg) {
      onLogin("viewer_"+name, name, fbCfg, joinRoomCode);
      return;
    }
    setErr("Username not found — check with your host, or enter the Room Code to sync live");
  };

  return (
    <div className="page center-page">
      <div className="login-card">
        <div className="login-brand">
          <img src="data:image/jpeg;base64,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" className="login-brand-img" alt="C365" />
          <div className="login-brand-text">
            <span className="login-brand-sub">AUCTION ROOM</span>
          </div>
        </div>
        <div className="login-divider"/>
        <p className="login-sub">Select your role to enter</p>

        {mode==="pick" && (
          <div className="login-options">
            <button className="login-opt host-opt" onClick={()=>{ if(!auction){ onLogin("host","Host"); } else { setMode("hostpin"); } }}>
              <span className="opt-icon">🎙</span>
              <div className="opt-text">
                <span className="opt-label">Host</span>
                <span className="opt-desc">Manage the auction · requires PIN</span>
              </div>
            </button>
            <button className="login-opt discord-opt" onClick={()=>setMode("discord")}>
              <span className="opt-icon discord-icon">
                <svg viewBox="0 0 24 24" width="22" height="22" fill="#5865F2"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057c.002.022.015.043.034.056a19.926 19.926 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03z"/></svg>
              </span>
              <div className="opt-text">
                <span className="opt-label">Join with Discord</span>
                <span className="opt-desc">Enter your Discord username to join your team</span>
              </div>
            </button>
          </div>
        )}


        {mode==="pick" && saves && saves.length>0 && (
          <div className="saves-section">
            <div className="saves-title">💾 Saved Sessions</div>
            {saves.map(s=>(
              <div key={s.id} className="save-row">
                <div className="save-info">
                  <span className="save-name">{s.label}</span>
                  <span className="save-meta">{s.teams?.length||0} teams · {s.auction?.sold?.length||0} sold · {s.auction?.queue?.length||0} remaining · {new Date(s.savedAt).toLocaleDateString("en-GB")}</span>
                </div>
                <div className="save-row-btns">
                  <button className="btn-save-resume" onClick={()=>onResumeSave(s)}>Resume →</button>
                  <button className="btn-save-delete" onClick={()=>onDeleteSave(s.id)} title="Delete">✕</button>
                </div>
              </div>
            ))}
          </div>
        )}

        {mode==="hostpin" && (
          <div className="pin-wrap">
            <p className="pin-label">Enter Host PIN</p>
            <input className="inp pin-inp" type="password" value={pin} onChange={e=>{setPin(e.target.value);setErr("");}} onKeyDown={e=>e.key==="Enter"&&tryHost()} placeholder="••••" autoFocus />
            {err && <div className="pin-err">{err}</div>}
            <div className="pin-btns">
              <button className="btn-ghost-sm" onClick={()=>{setMode("pick");setErr("");}}>← Back</button>
              <button className="btn-add" onClick={tryHost}>Enter</button>
            </div>
          </div>
        )}

        {mode==="discord" && (
          <div className="pin-wrap">
            <div className="discord-header">
              <svg viewBox="0 0 24 24" width="28" height="28" fill="#5865F2"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057c.002.022.015.043.034.056a19.926 19.926 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03z"/></svg>
              <span className="discord-header-text">Join with Discord</span>
            </div>
            <Field label="Your Discord Username">
              <input className="inp" value={discordName} onChange={e=>{setDiscordName(e.target.value);setErr("");}} placeholder="e.g. neel123" autoFocus />
            </Field>
            <Field label="Room Code (from host)">
              <input className="inp" value={joinRoomCode} onChange={e=>setJoinRoomCode(e.target.value.toUpperCase())} placeholder="e.g. AB3XZ" />
            </Field>
            <Field label="Firebase Project ID (from host)">
              <input className="inp" value={joinProjectId} onChange={e=>setJoinProjectId(e.target.value)} placeholder="my-auction-app" />
            </Field>
            <Field label="Firebase API Key (from host)">
              <input className="inp" value={joinApiKey} onChange={e=>setJoinApiKey(e.target.value)} placeholder="AIzaSy..." />
            </Field>
            {err && <div className="pin-err">{err}</div>}
            <div className="pin-btns">
              <button className="btn-ghost-sm" onClick={()=>{setMode("pick");setErr("");}}>← Back</button>
              <button className="btn-add discord-btn" onClick={tryDiscord}>Join →</button>
            </div>
            <p className="join-hint">💡 Ask the host to share the Room Code, Project ID, and API Key before the auction starts.</p>
          </div>
        )}
      </div>
    </div>
  );
}

/* ── SETUP ── */
function SetupScreen({ teams, setTeams, sets, setSets, onStart, syncStatus }) {
  const total = sets.reduce((a,s)=>a+s.players.length,0);
  const [hostPin, setHostPin] = useState("1234");
  const [timerSecs, setTimerSecs] = useState("60");
  const [showFirebase, setShowFirebase] = useState(false);
  const [fbApiKey, setFbApiKey]         = useState("");
  const [fbProjectId, setFbProjectId]   = useState("");
  const [roomCode, setRoomCodeLocal]    = useState(() => Math.random().toString(36).slice(2,7).toUpperCase());
  const fbCfg = fbApiKey && fbProjectId ? { apiKey:fbApiKey, authDomain:`${fbProjectId}.firebaseapp.com`, databaseURL:`https://${fbProjectId}-default-rtdb.firebaseio.com`, projectId:fbProjectId, storageBucket:`${fbProjectId}.appspot.com`, messagingSenderId:"000000000000", appId:"1:000000000000:web:000000" } : null;
  return (
    <div className="page">
      <div className="page-hero">
        <h1 className="hero-title">Auction Setup</h1>
        <p className="hero-sub">Configure franchises and player sets before the auction begins</p>
      </div>
      <div className="setup-grid">
        <TeamsPanel teams={teams} setTeams={setTeams} />
        <PlayersPanel sets={sets} setSets={setSets} />
      </div>
      <div className="host-settings-bar">
        <div className="hs-title">⚙️ Host Settings</div>
        <div className="hs-fields">
          <Field label="Host PIN (for re-entry)">
            <input className="inp" type="password" value={hostPin} onChange={e=>setHostPin(e.target.value)} placeholder="Set a PIN" />
          </Field>
          <Field label="Bid Timer (seconds)">
            <input className="inp" type="number" min="10" max="300" value={timerSecs} onChange={e=>setTimerSecs(e.target.value)} placeholder="60" />
          </Field>
          <Field label="Timer off = 0">
            <select className="inp" value={timerSecs==="0"?"0":timerSecs} onChange={e=>setTimerSecs(e.target.value)}>
              <option value="0">No Timer</option>
              <option value="30">30s</option>
              <option value="45">45s</option>
              <option value="60">60s</option>
              <option value="90">90s</option>
              <option value="120">2 min</option>
            </select>
          </Field>
        </div>
        <div className="hs-firebase-toggle">
          <button className="tbtn" onClick={()=>setShowFirebase(v=>!v)}>
            {showFirebase ? "▲ Hide" : "🔥 Enable Live Sync (Firebase)"} {syncStatus==="live"&&"✅"}
          </button>
          {syncStatus==="live" && <span className="sync-live-badge">🟢 LIVE</span>}
          {syncStatus==="connecting" && <span className="sync-live-badge sync-connecting">⏳ Connecting…</span>}
          {syncStatus==="error" && <span className="sync-live-badge sync-error">🔴 Error</span>}
        </div>
        {showFirebase && (
          <div className="fb-config-panel">
            <div className="fb-info">
              <strong>How to set up:</strong> Go to <a href="https://console.firebase.google.com" target="_blank" rel="noreferrer" className="fb-link">console.firebase.google.com</a> → New project → Realtime Database → Start in test mode → Project Settings → Your apps → Web app → copy API key and Project ID.
            </div>
            <div className="form-row3">
              <Field label="Firebase API Key">
                <input className="inp" value={fbApiKey} onChange={e=>setFbApiKey(e.target.value)} placeholder="AIzaSy..." />
              </Field>
              <Field label="Project ID">
                <input className="inp" value={fbProjectId} onChange={e=>setFbProjectId(e.target.value)} placeholder="my-auction-app" />
              </Field>
              <Field label="Room Code (share this)">
                <div className="room-code-wrap">
                  <input className="inp room-code-inp" value={roomCode} onChange={e=>setRoomCodeLocal(e.target.value.toUpperCase().slice(0,8))} placeholder="AUTO" />
                  <button className="tbtn" onClick={()=>setRoomCodeLocal(Math.random().toString(36).slice(2,7).toUpperCase())}>🔄</button>
                </div>
              </Field>
            </div>
            {fbCfg && <div className="fb-ready">✅ Firebase configured · Room code: <strong>{roomCode}</strong> — share this with your friends</div>}
            {!fbCfg && fbApiKey && <div className="fb-warn">⚠️ Enter both API Key and Project ID to enable sync</div>}
          </div>
        )}
      </div>
      <div className="start-bar">
        <div className="start-info">
          <span className="info-pill">{teams.length} teams</span>
          <span className="info-pill">{total} players · {sets.length} sets</span>
          {sets.filter(s=>s.isAccelerated).map(s=>(
            <span key={s.name} className="info-pill accel-pill">⚡ {s.name}</span>
          ))}
        </div>
        <button className="btn-start" disabled={sets.filter(s=>!s.isAccelerated).length===0||teams.length<2} onClick={()=>onStart(hostPin||"1234", parseInt(timerSecs)||0, fbCfg, roomCode)}>
          <span>Begin Auction</span>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 8h10M9 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
        </button>
      </div>
    </div>
  );
}

function TeamsPanel({ teams, setTeams }) {
  const [form, setForm] = useState({ name:"", budget:"100", maxPlayers:"15", minWK:"1", maxOverseas:"4", discordUsers:"", color:"" });
  const [editId, setEditId] = useState(null);
  const nextColor = () => TEAM_COLORS[teams.length % TEAM_COLORS.length];
  const save = () => {
    if(!form.name.trim()) return;
    const discordList = form.discordUsers.split(',').map(s=>s.trim().toLowerCase()).filter(Boolean);
    const color = form.color || nextColor();
    const t = { id:editId||uid(), name:form.name.trim(), budget:+form.budget||100, maxPlayers:+form.maxPlayers||15, minWK:+form.minWK||1, maxOverseas:+form.maxOverseas||4, discordUsers:discordList, color, spent:0, players:[] };
    setTeams(ts=>editId?ts.map(x=>x.id===editId?t:x):[...ts,t]);
    setForm({ name:"", budget:"100", maxPlayers:"15", minWK:"1", maxOverseas:"4", discordUsers:"", color:"" }); setEditId(null);
  };
  return (
    <div className="panel">
      <div className="panel-head"><span className="step-chip">01</span>Franchises</div>
      <div className="form-stack">
        <Field label="Team Name"><input className="inp" value={form.name} onChange={e=>setForm(f=>({...f,name:e.target.value}))} onKeyDown={e=>e.key==="Enter"&&save()} placeholder="e.g. Mumbai Mavericks" /></Field>
        <div className="form-row4">
          <Field label="Budget (Cr)"><input className="inp" type="number" value={form.budget} onChange={e=>setForm(f=>({...f,budget:e.target.value}))} /></Field>
          <Field label="Max Squad"><input className="inp" type="number" value={form.maxPlayers} onChange={e=>setForm(f=>({...f,maxPlayers:e.target.value}))} /></Field>
          <Field label="Min WK"><input className="inp" type="number" min="0" value={form.minWK} onChange={e=>setForm(f=>({...f,minWK:e.target.value}))} /></Field>
          <Field label="Max OVS"><input className="inp" type="number" min="0" value={form.maxOverseas} onChange={e=>setForm(f=>({...f,maxOverseas:e.target.value}))} /></Field>
        </div>
        <Field label="Discord Usernames (comma-separated)">
          <input className="inp" value={form.discordUsers} onChange={e=>setForm(f=>({...f,discordUsers:e.target.value}))} placeholder="e.g. neel123, rahul_c365" />
        </Field>
        <div className="color-picker-row">
          <span className="color-picker-label">Team Colour</span>
          <div className="color-swatches">
            {TEAM_COLORS.map(c=>(
              <button key={c} className={`color-swatch ${(form.color||nextColor())===c?"swatch-active":""}`}
                style={{background:c, boxShadow:(form.color||nextColor())===c?`0 0 0 2px #000, 0 0 0 4px ${c}`:"none"}}
                onClick={()=>setForm(f=>({...f,color:c}))} type="button" />
            ))}
            <input type="color" className="color-custom-inp" value={form.color||nextColor()}
              onChange={e=>setForm(f=>({...f,color:e.target.value}))} title="Custom colour" />
          </div>
        </div>
        <div className="btn-row">
          <button className="btn-add" onClick={save}>{editId?"Save Changes":"+ Add Team"}</button>
          {editId&&<button className="btn-ghost-sm" onClick={()=>{setForm({name:"",budget:"100",maxPlayers:"15",minWK:"1",maxOverseas:"4",discordUsers:""});setEditId(null);}}>Cancel</button>}
        </div>
      </div>
      <div className="team-list">
        {teams.map(t=>(
          <div key={t.id} className="team-row">
            <div className="team-row-name">
              <span className="team-color-dot" style={{background:t.color||TEAM_COLORS[0]}}/>
              {t.name}
            </div>
            <div className="team-row-meta">
              <span className="meta-chip">{crFmt(t.budget)}</span>
              <span className="meta-chip">{t.maxPlayers} max</span>
              <span className="meta-chip wk-chip">Min {t.minWK} WK</span>
              <span className="meta-chip ovs-chip">Max {t.maxOverseas} OVS</span>
              {t.discordUsers&&t.discordUsers.length>0&&<span className="meta-chip discord-chip">💬 {t.discordUsers.length}</span>}
            </div>
            <div className="team-row-actions">
              <button className="icon-btn" onClick={()=>{setForm({name:t.name,budget:String(t.budget),maxPlayers:String(t.maxPlayers),minWK:String(t.minWK),maxOverseas:String(t.maxOverseas??4),discordUsers:(t.discordUsers||[]).join(', '),color:t.color||""});setEditId(t.id);}}>✏️</button>
              <button className="icon-btn" onClick={()=>setTeams(ts=>ts.filter(x=>x.id!==t.id))}>🗑️</button>
            </div>
          </div>
        ))}
        {teams.length===0&&<div className="empty-hint">No franchises added yet</div>}
      </div>
    </div>
  );
}

function PlayersPanel({ sets, setSets }) {
  const fileRef = useRef();
  const handleFile = e => {
    const file = e.target.files[0]; if(!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      const wb = XLSX.read(ev.target.result,{type:"array"});
      setSets(wb.SheetNames.map(name=>({ name, players:parseSheet(wb.Sheets[name],name), increments:[...DEFAULT_INCS], isAccelerated:false, timerSecs:null })).filter(s=>s.players.length>0));
    };
    reader.readAsArrayBuffer(file); e.target.value="";
  };
  const removeSet = name => setSets(ss=>ss.filter(s=>s.name!==name));
  const removePlayer = (sn,pid) => setSets(ss=>ss.map(s=>s.name===sn?{...s,players:s.players.filter(p=>p.id!==pid)}:s));
  const toggleAccel = name => setSets(ss=>ss.map(s=>s.name===name?{...s,isAccelerated:!s.isAccelerated}:s));
  const updateInc = (sn,i,v) => { const n=parseFloat(v); if(!isNaN(n)&&n>0) setSets(ss=>ss.map(s=>s.name===sn?{...s,increments:s.increments.map((x,j)=>j===i?n:x)}:s)); };
  const updateTimer = (sn,v) => setSets(ss=>ss.map(s=>s.name===sn?{...s,timerSecs:v==="default"?null:parseInt(v)||0}:s));
  return (
    <div className="panel">
      <div className="panel-head"><span className="step-chip">02</span>Player Sets</div>
      <div className="upload-zone" onClick={()=>fileRef.current.click()}>
        <div className="upload-icon">📂</div>
        <div className="upload-main">Upload Spreadsheet</div>
        <div className="upload-sub">Each sheet becomes a set · auctioned in tab order<br/><code>Name</code> · <code>Role</code> (BAT/BOWL/AR/WK) · <code>Base Price</code> · <code>Overseas</code></div>
        <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" style={{display:"none"}} onChange={handleFile}/>
      </div>
      {sets.length>0&&(
        <div className="sets-list">
          {sets.map((s,si)=>(
            <details key={s.name} className={`set-block ${s.isAccelerated?"set-block-accel":""}`} open={si===0}>
              <summary className="set-summary">
                <span className="set-order">#{si+1}</span>
                <span className="set-name">{s.name}</span>
                {s.isAccelerated&&<span className="accel-badge">⚡ ACCEL</span>}
                <span className="set-count">{s.players.length}</span>
                <button className={`toggle-accel-btn ${s.isAccelerated?"toggle-accel-on":""}`} onClick={e=>{e.preventDefault();toggleAccel(s.name);}}>⚡</button>
                <button className="icon-btn danger" onClick={e=>{e.preventDefault();removeSet(s.name);}}>✕</button>
              </summary>
              <div className="inc-editor">
                <div className="inc-label">Bid Increments (Cr)</div>
                <div className="inc-row">
                  {s.increments.map((v,i)=>(
                    <div key={i} className="inc-field">
                      <span className="inc-tag">+{i+1}</span>
                      <input className="inp inc-inp" type="number" step="0.05" min="0.05" value={v} onChange={e=>updateInc(s.name,i,e.target.value)}/>
                    </div>
                  ))}
                </div>
              </div>
              <div className="inc-row" style={{marginTop:".4rem",alignItems:"center"}}>
                <span className="inc-tag" style={{whiteSpace:"nowrap"}}>⏱ Timer</span>
                <select className="inp inc-timer-sel" value={s.timerSecs===null?"default":String(s.timerSecs)} onChange={e=>updateTimer(s.name,e.target.value)}>
                  <option value="default">Use default</option>
                  <option value="0">No timer</option>
                  <option value="20">20s</option>
                  <option value="30">30s</option>
                  <option value="45">45s</option>
                  <option value="60">60s</option>
                  <option value="90">90s</option>
                  <option value="120">2 min</option>
                </select>
              </div>
              <div className="set-players">
                {s.players.map(p=>(
                  <div key={p.id} className="set-player-row">
                    <span className="role-pip" style={{background:ROLE_COLOR[p.role]}}/>
                    <span className="sp-name">{p.name}</span>
                    <span className="sp-role" style={{color:ROLE_COLOR[p.role]}}>{p.role}</span>
                    {p.overseas&&<span className="ovs-pip">OVS</span>}
                    <span className="sp-price">{crFmt(p.basePrice)}</span>
                    <button className="icon-btn danger small" onClick={()=>removePlayer(s.name,p.id)}>✕</button>
                  </div>
                ))}
              </div>
            </details>
          ))}
        </div>
      )}
      {sets.length===0&&<div className="empty-hint">Upload a spreadsheet to populate sets</div>}
    </div>
  );
}

/* ── AUCTION ── */
function AuctionScreen({ auction:a, setAuction, setScreen, role, syncStatus, onSave }) {
  const bidLogRef = useRef();
  const [selTeamId, setSelTeamId] = useState(a.teams[0]?.id||"");
  const [showEndConfirm, setShowEndConfirm] = useState(false);
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [saveLabel, setSaveLabel] = useState("");
  const [saveMsg, setSaveMsg] = useState("");


  useEffect(()=>{ if(bidLogRef.current) bidLogRef.current.scrollTop=bidLogRef.current.scrollHeight; },[a.bidHistory]);

  const isHost = role==="host";
  const myTeam = role!=="host" ? a.teams.find(t=>t.id===role) : null;

  // ── Interactive state ──
  const [confetti, setConfetti] = useState([]);
  const [soldFlash, setSoldFlash] = useState(false);
  const [bidFlash, setBidFlash] = useState(false);
  const [reactions, setReactions] = useState([]);
  const [showLeaderboard, setShowLeaderboard] = useState(false);
  const [lastBidCount, setLastBidCount] = useState(0);
  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState("");
  const [rightTab, setRightTab] = useState("log"); // log | chat
  const chatRef = useRef(null);
  const audioCtx = useRef(null);

  const getAudio = () => {
    if(!audioCtx.current) audioCtx.current = new (window.AudioContext||window.webkitAudioContext)();
    return audioCtx.current;
  };

  const playTone = (freq, dur, type="sine", vol=0.18) => {
    try {
      const ctx = getAudio();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.type = type; osc.frequency.value = freq;
      gain.gain.setValueAtTime(vol, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime+dur);
      osc.start(); osc.stop(ctx.currentTime+dur);
    } catch(e){}
  };

  const playBid = () => {
    // Punchy bid buzz — ascending ding
    playTone(400,0.05,"square",0.15);
    setTimeout(()=>playTone(600,0.07,"square",0.18),50);
    setTimeout(()=>playTone(800,0.1,"sine",0.15),110);
  };
  const playSold = () => {
    // Gavel: sharp crack + triumphant fanfare
    playTone(180,0.05,"sawtooth",0.35); // crack
    setTimeout(()=>playTone(120,0.08,"sawtooth",0.3),40);
    setTimeout(()=>{ // fanfare
      [[523,0],[659,120],[784,240],[1047,360],[784,480],[1047,580],[1319,700]].forEach(([f,t])=>
        setTimeout(()=>playTone(f,0.22,"sine",0.22),t)
      );
    },100);
  };
  const playUnsold = () => {
    // Descending disappointed trombone
    playTone(350,0.12,"sawtooth",0.2);
    setTimeout(()=>playTone(280,0.12,"sawtooth",0.18),120);
    setTimeout(()=>playTone(200,0.25,"sawtooth",0.15),240);
  };
  const playDraw = () => {
    // Dramatic reveal drumroll + sting
    [1,2,3,4,5,6,7,8].forEach(i=>setTimeout(()=>playTone(200+i*20,0.04,"square",0.08),i*40));
    setTimeout(()=>{
      playTone(440,0.1,"triangle",0.2);
      setTimeout(()=>playTone(554,0.1,"triangle",0.2),100);
      setTimeout(()=>playTone(659,0.2,"triangle",0.25),200);
    },380);
  };
  const playTimer = () => {
    // Urgent tick
    playTone(1200,0.04,"square",0.12);
  };
  const playTimerEnd = () => {
    // Alarm burst
    [0,60,120,180].forEach(t=>setTimeout(()=>playTone(1400,0.05,"square",0.2),t));
  };

  // Flash on new bid
  useEffect(()=>{
    if(a.bidHistory.length>lastBidCount && a.bidHistory.length>0){
      setLastBidCount(a.bidHistory.length);
      setBidFlash(true);
      setTimeout(()=>setBidFlash(false),400);
      playBid();
    }
  },[a.bidHistory.length]);

  // Timer tick + alarm
  useEffect(()=>{
    if(a.timerLeft<=5 && a.timerLeft>0 && a.timerRunning) playTimer();
    if(a.timerLeft===5 && a.timerRunning) addCommentary("timer_low");
    if(a.timerLeft===0 && !a.timerRunning) playTimerEnd();
  },[a.timerLeft]);

  // Chat scroll
  useEffect(()=>{ if(chatRef.current) chatRef.current.scrollTop=chatRef.current.scrollHeight; },[chatMessages]);

  // System chat message on new bid
  useEffect(()=>{
    if(a.bidHistory.length>0){
      const last=a.bidHistory[a.bidHistory.length-1];
      if(a.bidHistory.length!==lastBidCount){
        setChatMessages(prev=>[...prev,{id:uid(),type:"bid",text:`${last.team} bids ${crFmt(last.amount)}`,ts:Date.now()}].slice(-100));
      }
    }
  },[a.bidHistory.length]);

  const sendChat = () => {
    const txt=chatInput.trim(); if(!txt) return;
    const name = role==="host"?"🎙 Host":(myTeam?.name||"Viewer");
    setChatMessages(prev=>[...prev,{id:uid(),type:"user",name,text:txt,ts:Date.now()}].slice(-100));
    setChatInput("");
  };

  const fireConfetti = () => {
    const colors=["#b09dff","#00f0ff","#00ff88","#ffe040","#ff40aa","#ff5577","#ffffff","#ffd700","#ff8c00"];
    const pieces = Array.from({length:150},(_,i)=>({
      id:i,
      x: i<50 ? Math.random()*40 : i<100 ? Math.random()*40+60 : Math.random()*100, // burst from sides + top
      delay: Math.random()*0.6,
      color: colors[Math.floor(Math.random()*colors.length)],
      size: Math.random()*10+5,
      rot: Math.random()*360,
      duration: 1.8+Math.random()*1.4,
      shape: Math.random()>0.4?"square":"circle",
    }));
    setConfetti(pieces);
    setTimeout(()=>setConfetti([]),4500);
  };

  const addReaction = (emoji) => {
    const r = {id:uid(), emoji, x:Math.random()*80+10};
    setReactions(prev=>[...prev,r]);
    setTimeout(()=>setReactions(prev=>prev.filter(x=>x.id!==r.id)),2500);
  };

  const REACTION_EMOJIS = ["🔥","💸","👑","🚀","😱","💎","🤑","⚡","🏏","👏"];

  // ── Commentary engine ──────────────────────────────────────────────────────
  const DEFAULT_COMMENTARY = {
    draw: [
      "👀 Step right up! {name} enters the room — pockets ready, everyone?",
      "🎺 Ladies and gentlemen, {name} has arrived. Bidding wallets at the ready!",
      "🌟 Oh this is a big one — {name} up for grabs. Who wants it?",
      "🏏 {name} walks in. The silence is deafening. Someone bid something!",
      "😤 {name} on the block. Base price is {base}. Don't be shy.",
      "🎯 {name} — highly rated, highly priced. Or at least, it will be soon.",
      "🔮 The stars have aligned. {name} is next. What are they worth to you?",
      "🎪 Roll up, roll up! {name} is here and ready to be won!",
    ],
    bid: [
      "💸 {team} throws {amount} into the ring. Bold move!",
      "👊 {team} says {amount}. Anyone dare go higher?",
      "🔥 Oh! {team} with {amount} — that escalated quickly.",
      "📈 {amount} from {team}! The price is going UP.",
      "😤 {team} means business — {amount} on the table!",
      "💰 {team} opens their wallet wide — {amount}!",
      "🤑 {amount}?! {team} really wants this one.",
      "⚡ Lightning fast — {team} counters with {amount}!",
    ],
    bidwar: [
      "🥊 {team1} vs {team2} — this is getting personal!",
      "😱 {team1} and {team2} going at it! Someone blink first!",
      "🔥 WAR! {team1} vs {team2} — forget the player, this is about pride now.",
      "🍿 Grab the popcorn — {team1} and {team2} are NOT backing down.",
      "💥 {team1} vs {team2}! The auction room is on FIRE.",
    ],
    sold_cheap: [
      "😅 {name} goes to {team} for just {price}... bargain of the century!",
      "🤯 {price} for {name}?! {team} found the deal of the auction.",
      "😬 {team} snapping up {name} for {price}. Quiet but deadly.",
      "🏴‍☠️ {team} just STOLE {name} for {price}. Someone's fuming.",
    ],
    sold_expensive: [
      "💸 {name} SOLD to {team} for {price}! The accountant is crying.",
      "🤑 {price}! {team} breaks the bank for {name}. Worth it? We'll see.",
      "😤 {team} spent {price} on {name}. That better be worth every rupee!",
      "🏆 {price} for {name} — {team} is NOT here to mess around.",
      "🚀 {name} to {team} for {price}! Houston, we have a blockbuster!",
    ],
    sold_normal: [
      "🔨 SOLD! {name} joins {team} for {price}. Next!",
      "✅ {team} bags {name} for {price}. Nice pick-up.",
      "👏 Done deal — {name} to {team} at {price}.",
      "📋 {team} adds {name} to the roster. {price} well spent? Probably.",
    ],
    unsold: [
      "😢 No takers for {name}. The people have spoken.",
      "😔 {name} walks back... no one wanted to spend. Fair enough.",
      "🚪 {name} exits stage left. Unsold. Moving on.",
      "💀 Brutal. {name} goes unsold. The auction has no mercy.",
      "🤷 Nobody? Really? {name} deserved better.",
    ],
    timer_low: [
      "⏰ FIVE SECONDS! Anyone?! ANYONE?!",
      "🚨 Time is running out — this is your last chance!",
      "😬 The clock is ticking... who's going to break?",
      "⏳ Last call! Speak now or forever hold your peace!",
    ],
    opening: [
      "🎙 Welcome to the C365 Auction Room! Let the madness begin.",
      "🏏 The auction is LIVE! Budgets will be broken, friendships tested.",
      "🎉 Let's get this show on the road — may the best team win!",
    ],
  };

  const [commentaryBank, setCommentaryBank] = useState(() => {
    try { return JSON.parse(localStorage.getItem("c365_commentary")||"null") || DEFAULT_COMMENTARY; }
    catch { return DEFAULT_COMMENTARY; }
  });
  const [showCommentaryEditor, setShowCommentaryEditor] = useState(false);
  const [editCategory, setEditCategory] = useState("draw");
  const [editLines, setEditLines] = useState("");

  const saveCommentaryEdits = () => {
    const lines = editLines.split("\n").map(l=>l.trim()).filter(Boolean);
    const updated = {...commentaryBank, [editCategory]: lines};
    setCommentaryBank(updated);
    localStorage.setItem("c365_commentary", JSON.stringify(updated));
  };

  const resetCommentary = () => {
    setCommentaryBank(DEFAULT_COMMENTARY);
    localStorage.removeItem("c365_commentary");
    setEditLines(DEFAULT_COMMENTARY[editCategory].join("\n"));
  };

  const pick = (arr) => arr[Math.floor(Math.random()*arr.length)]||"";

  const commentary = (type, vars={}) => {
    const lines = commentaryBank[type] || DEFAULT_COMMENTARY[type] || [];
    let line = pick(lines);
    Object.entries(vars).forEach(([k,v])=>{ line=line.replace(new RegExp(`{${k}}`,"g"),v); });
    return line;
  };

  const addCommentary = (type, vars={}) => {
    const text = commentary(type, vars);
    if(!text) return;
    setChatMessages(prev=>[...prev,{id:uid(),type:"commentary",text,ts:Date.now()}].slice(-100));
  };

  // Timer
  useEffect(()=>{
    if(!a.timerRunning||a.timerLeft<=0) return;
    const id=setInterval(()=>{
      setAuction(prev=>{
        if(!prev.timerRunning) return prev;
        if(prev.timerLeft<=1){
          // auto mark unsold when timer hits 0
          const ret=prev.status==="bidding_accel"?"accel_manage":"idle";
          if(prev.currentBidder){
            // sold to current bidder
            return {...prev,timerRunning:false,timerLeft:0,status:ret,current:null,
              sold:[...prev.sold,{...prev.current,soldTo:prev.currentBidder.id,soldFor:prev.currentBid}],
              teams:prev.teams.map(t=>t.id===prev.currentBidder.id?{...t,spent:t.spent+prev.currentBid,players:[...t.players,{...prev.current,soldFor:prev.currentBid}]}:t)};
          }
          return {...prev,timerRunning:false,timerLeft:0,status:ret,current:null,unsold:[...prev.unsold,prev.current]};
        }
        return {...prev,timerLeft:prev.timerLeft-1};
      });
    },1000);
    return ()=>clearInterval(id);
  },[a.timerRunning, a.timerLeft]);

  const upd = fn => setAuction(prev=>fn(prev));

  const pickNext = () => upd(prev=>{
    if(prev.queue.length===0) return {...prev,status:"accel_manage"};
    const [next,...rest]=prev.queue;
    const t=next.setTimer!==null&&next.setTimer!==undefined?next.setTimer:(prev.defaultTimer||0);
    return {...prev,current:next,queue:rest,currentBid:next.basePrice,currentBidder:null,bidHistory:[],status:"bidding",currentIncrements:next.increments||DEFAULT_INCS,timerLeft:t,timerRunning:t>0};
  });
  playDraw();
  setTimeout(()=>{
    setAuction(prev=>{
      const p=prev.current;
      if(p) addCommentary("draw",{name:p.name,base:crFmt(p.basePrice)});
      if(prev.sold.length===0 && prev.unsold.length===0) addCommentary("opening");
      return prev;
    });
  },400);

  const pickNextAccel = () => upd(prev=>{
    if(prev.accelPool.length===0) return {...prev,status:"accel_manage"};
    const [next,...rest]=prev.accelPool;
    const sc=prev.sets.find(s=>s.name===next.set);
    const t=prev.defaultTimer||0;
    return {...prev,current:next,accelPool:rest,currentBid:next.basePrice,currentBidder:null,bidHistory:[],status:"bidding_accel",currentIncrements:sc?.increments||DEFAULT_INCS,timerLeft:t,timerRunning:t>0};
  });

  const bid = amt => {
    const val=parseFloat(amt); if(!val||val<=a.currentBid) return;
    const team=a.teams.find(t=>t.id===selTeamId); if(!team) return;
    if(val>team.budget-team.spent){alert(`${team.name} only has ${crFmt(team.budget-team.spent)} remaining!`);return;}
    if(team.players.length>=team.maxPlayers){alert(`${team.name} squad is full!`);return;}
    if(cur?.overseas){
      const ovsCount=team.players.filter(p=>p.overseas).length;
      const limit=team.maxOverseas??4;
      if(ovsCount>=limit){alert(`${team.name} has reached their overseas limit (${limit})!`);return;}
    }
    upd(prev=>({...prev,currentBid:val,currentBidder:team,bidHistory:[...prev.bidHistory,{team:team.name,amount:val}],timerLeft:prev.defaultTimer||0,timerRunning:(prev.defaultTimer||0)>0}));
    const hist = a.bidHistory;
    // Bid war: same two teams alternating last 4 bids
    if(hist.length>=3){
      const last4=[...hist.slice(-3),{team:team.name}];
      const teams4=last4.map(b=>b.team);
      if(new Set(teams4).size===2){
        const [t1,t2]=[...new Set(teams4)];
        addCommentary("bidwar",{team1:t1,team2:t2});
      } else if(hist.length%3===0){
        addCommentary("bid",{team:team.name,amount:crFmt(val)});
      }
    } else {
      addCommentary("bid",{team:team.name,amount:crFmt(val)});
    }
    setCustomBid("");
  };

  const quickBid = inc => {
    if(!isHost) setSelTeamId(role);
    bid(parseFloat((a.currentBid+inc).toFixed(2)));
  };
  const markSold = () => {
    if(!a.currentBidder) return;
    const ret=a.status==="bidding_accel"?"accel_manage":"idle";
    upd(prev=>({...prev,status:ret,current:null,timerRunning:false,sold:[...prev.sold,{...prev.current,soldTo:prev.currentBidder.id,soldFor:prev.currentBid}],teams:prev.teams.map(t=>t.id===prev.currentBidder.id?{...t,spent:t.spent+prev.currentBid,players:[...t.players,{...prev.current,soldFor:prev.currentBid}]}:t)}));
    setSoldFlash(true); setTimeout(()=>setSoldFlash(false),1200);
    fireConfetti(); playSold();
    const soldPlayer=a.current; const soldPrice=a.currentBid; const soldTeam=a.currentBidder;
    if(soldPlayer && soldTeam){
      const ratio=soldPrice/soldPlayer.basePrice;
      const type=ratio>=3?"sold_expensive":ratio<=1.2?"sold_cheap":"sold_normal";
      addCommentary(type,{name:soldPlayer.name,team:soldTeam.name,price:crFmt(soldPrice)});
    }
  };
  const markUnsold = () => {
    const ret=a.status==="bidding_accel"?"accel_manage":"idle";
    upd(prev=>({...prev,status:ret,current:null,timerRunning:false,unsold:[...prev.unsold,prev.current]}));
    playUnsold();
    if(a.current) addCommentary("unsold",{name:a.current.name});
  };
  const addToAccelPool = pid => upd(prev=>{
    const player=prev.unsold.find(p=>p.id===pid); if(!player) return prev;
    return {...prev,unsold:prev.unsold.filter(p=>p.id!==pid),accelPool:[...prev.accelPool,{...player,set:"Accelerated"}]};
  });
  const removeFromAccelPool = pid => upd(prev=>{
    const player=prev.accelPool.find(p=>p.id===pid); if(!player) return prev;
    return {...prev,accelPool:prev.accelPool.filter(p=>p.id!==pid),unsold:[...prev.unsold,player]};
  });
  const endAuction = () => { upd(prev=>({...prev,status:"done"})); setShowEndConfirm(false); };

  const isBidding=a.status==="bidding"||a.status==="bidding_accel";
  const isAccelPhase=a.status==="accel_manage"||a.status==="bidding_accel";
  const cur=a.current;
  const done=a.sold.length+a.unsold.length+a.accelPool.length;
  const total=done+a.queue.length+(cur?1:0);
  const pct=total>0?(done/total)*100:0;
  const curSet=cur?.set||(isAccelPhase?"Accelerated":a.queue[0]?.set||"");

  if(a.status==="done") return (
    <div className="page center-page">
      <div className="done-card">
        <div className="done-glow"/>
        <div style={{fontSize:"3rem",position:"relative",zIndex:1}}>🏆</div>
        <h2 className="done-title">Auction Complete!</h2>
        <p className="done-sub">{a.sold.length} sold · {a.unsold.length} unsold</p>
        <button className="btn-start" onClick={()=>setScreen("results")} style={{position:"relative",zIndex:1}}>View Final Squads →</button>
      </div>
    </div>
  );

  return (
    <div className={`auction-root ${soldFlash?"sold-flash-bg":""}`}>
      {/* CONFETTI */}
      {confetti.length>0&&(
        <div className="confetti-layer">
          {confetti.map((p)=>(
            <div key={p.id} className="confetti-piece" style={{
              left:p.x+"%", top:"0%",
              width:p.size+"px", height:p.size+"px",
              background:p.color,
              borderRadius:p.shape==="circle"?"50%":"3px",
              animation:`confetti-fall ${p.duration}s ease-in ${p.delay}s forwards`,
              transform:`rotate(${p.rot}deg)`,
            }}/>
          ))}
        </div>
      )}
      {/* REACTIONS OVERLAY */}
      <div className="reactions-layer">
        {reactions.map(r=>(
          <div key={r.id} className="reaction-float" style={{left:r.x+"%"}}>
            {r.emoji}
          </div>
        ))}
      </div>
      {/* SOLD FLASH SPECTACLE */}
      {soldFlash&&(
        <div className="sold-flash-overlay">
          <div className="sold-spotlight"/>
          <div className="sold-flash-content">
            <div className="sold-flash-gavel">🔨</div>
            <div className="sold-flash-text">SOLD!</div>
            <div className="sold-flash-detail">
              {a.sold.length>0&&<><strong>{a.sold[a.sold.length-1]?.name}</strong><br/>
              <span style={{color:"#ffe040"}}>{crFmt(a.sold[a.sold.length-1]?.soldFor)}</span> → {a.teams.find(t=>t.id===a.sold[a.sold.length-1]?.soldTo)?.name}</>}
            </div>
          </div>
        </div>
      )}
      {/* LEFT */}
      <div className="side-panel">
        <div className="side-title">FRANCHISES</div>
        {a.teams.map(t=>{
          const wkCount=t.players.filter(p=>p.role==="WK").length;
          const wkOk=wkCount>=t.minWK;
          const ovsCount=t.players.filter(p=>p.overseas).length;
          const ovsLimit=t.maxOverseas??4;
          const ovsOk=ovsCount<=ovsLimit;
          const budPct=Math.min((t.spent/t.budget)*100,100);
          const isLead=a.currentBidder?.id===t.id;
          const tc = t.color || TEAM_COLORS[a.teams.indexOf(t) % TEAM_COLORS.length];
          return (
            <div key={t.id} className={`fcard ${isLead?"fcard-leading":""}`}
              style={{borderColor: isLead ? tc : undefined,
                      boxShadow: isLead ? `0 0 18px ${tc}44, inset 0 0 20px ${tc}08` : undefined}}>
              <div className="fcard-color-bar" style={{background: tc}}/>
              <div className="fcard-top">
                <span className="fcard-name" style={{color: tc}}>{t.name}</span>
                {isLead&&<span className="leading-tag" style={{background:tc,color:"#000"}}>LEADING</span>}
              </div>
              <div className="fcard-stats">
                <span>{t.players.length}/{t.maxPlayers}</span>
                <span style={{color:wkOk?"#4ade80":"#f87171"}}>WK {wkCount}/{t.minWK}</span>
                <span style={{color:ovsOk?"#94a3b8":"#f87171"}}>✈️ {ovsCount}/{ovsLimit}</span>
                <span className="budget-remain" style={{color:tc}}>{crFmt(t.budget-t.spent)}</span>
              </div>
              <div className="budget-track"><div className="budget-fill" style={{width:`${budPct}%`, background:tc, boxShadow:`0 0 8px ${tc}88`}}/></div>
            </div>
          );
        })}
        <div className="progress-block">
          <button className="leaderboard-toggle" onClick={()=>setShowLeaderboard(v=>!v)}>
            🏆 Leaderboard
          </button>
          {showLeaderboard&&(
            <div className="modal-overlay" onClick={()=>setShowLeaderboard(false)}>
              <div className="lb-modal" onClick={e=>e.stopPropagation()}>
                <div className="lb-modal-glow"/>
                <button className="help-close" onClick={()=>setShowLeaderboard(false)}>✕</button>
                <div className="lb-modal-title">🏆 Spend Leaderboard</div>
                <div className="lb-modal-sub">{a.sold.length} players sold · {crFmt(a.teams.reduce((s,t)=>s+t.spent,0))} total spent</div>
                {[...a.teams].sort((x,y)=>y.spent-x.spent).map((t,i)=>{
                  const spentPct=t.budget>0?(t.spent/t.budget)*100:0;
                  const leftPct=t.budget>0?((t.budget-t.spent)/t.budget)*100:0;
                  return (
                    <div key={t.id} className="lb-modal-row">
                      <div className="lb-modal-info">
                        <div className="lb-modal-name-row">
                          <span className="lb-modal-name">{t.name}</span>
                          <span className="lb-modal-rank">#{i+1}</span>
                        </div>
                        <div className="lb-modal-bar-wrap">
                          <div className="lb-modal-bar lb-bar-spent" style={{width:spentPct+"%", background:t.color||TEAM_COLORS[i%TEAM_COLORS.length], boxShadow:`0 0 6px ${t.color||TEAM_COLORS[i%TEAM_COLORS.length]}66`}}/>
                          <div className="lb-modal-bar lb-bar-left" style={{width:leftPct+"%",position:"absolute",right:0,top:0}}/>
                        </div>
                        <div className="lb-modal-legend">
                          <span className="lb-legend-spent">Spent: {crFmt(t.spent)}</span>
                          <span className="lb-legend-left">Remaining: {crFmt(t.budget-t.spent)}</span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          <div className="prog-label">Progress · {a.sold.length}/{total-a.unsold.length}</div>
          <div className="prog-track"><div className="prog-fill" style={{width:`${pct}%`}}/></div>
          {curSet&&<div className="prog-set">Set: <strong>{curSet}</strong></div>}
          <div className="prog-set">{a.queue.length} remaining · {a.unsold.length} unsold</div>
        </div>
      </div>

      {/* CENTER */}
      <div className="auction-center">
        {a.status==="idle"&&(
          <div className="idle-wrap">
            {curSet&&<div className="set-label-big">{curSet}</div>}
            <div className="idle-count">{a.queue.length} players in pool</div>
            {isHost && <button className="btn-draw" onClick={pickNext} disabled={a.queue.length===0}>🎲 Draw Next Player</button>}
            {isHost && a.queue.length===0 && <button className="btn-accel-start" onClick={()=>upd(p=>({...p,status:"accel_manage"}))}>⚡ Open Accelerated Round</button>}
            {isHost && <button className="btn-end-subtle" onClick={()=>setShowEndConfirm(true)}>End Auction</button>}
            {isHost && <button className="btn-save-session" onClick={()=>{setSaveLabel("");setSaveMsg("");setShowSaveModal(true);}}>💾 Save Progress</button>}
            {!isHost && <div className="waiting-msg">⏳ Waiting for host to draw next player…</div>}
          </div>
        )}

        {a.status==="accel_manage"&&(
          <div className="accel-wrap">
            <div className="accel-header">
              <div className="accel-glow-badge">⚡ ACCELERATED ROUND</div>
              <p className="accel-sub">Stage unsold players then draw manually</p>
            </div>
            <div className="accel-columns">
              <div className="accel-col">
                <div className="accel-col-title">UNSOLD ({a.unsold.length})</div>
                <div className="accel-list">
                  {a.unsold.length===0&&<div className="empty-hint">No unsold players</div>}
                  {a.unsold.map(p=>(
                    <div key={p.id} className="accel-player-row">
                      <span className="role-pip" style={{background:ROLE_COLOR[p.role]}}/>
                      <span className="accel-pname">{p.name}</span>
                      <span className="accel-prole" style={{color:ROLE_COLOR[p.role]}}>{p.role}</span>
                      {isHost && <button className="btn-add-accel" onClick={()=>addToAccelPool(p.id)}>→</button>}
                    </div>
                  ))}
                </div>
              </div>
              <div className="accel-divider">⚡</div>
              <div className="accel-col">
                <div className="accel-col-title">POOL ({a.accelPool.length})</div>
                <div className="accel-list">
                  {a.accelPool.length===0&&<div className="empty-hint">Add players here</div>}
                  {a.accelPool.map(p=>(
                    <div key={p.id} className="accel-player-row accel-pool-row">
                      <span className="role-pip" style={{background:ROLE_COLOR[p.role]}}/>
                      <span className="accel-pname">{p.name}</span>
                      <span className="accel-prole" style={{color:ROLE_COLOR[p.role]}}>{p.role}</span>
                      {isHost && <button className="btn-remove-accel" onClick={()=>removeFromAccelPool(p.id)}>✕</button>}
                    </div>
                  ))}
                </div>
              </div>
            </div>
            <div className="accel-actions">
              {isHost && <button className="btn-draw" onClick={pickNextAccel} disabled={a.accelPool.length===0}>🎲 Draw from Pool</button>}
              {isHost && <button className="btn-end-subtle" onClick={()=>setShowEndConfirm(true)}>End Auction</button>}
              {isHost && <button className="btn-save-session" onClick={()=>{setSaveLabel("");setSaveMsg("");setShowSaveModal(true);}}>💾 Save Progress</button>}
              {!isHost && <div className="waiting-msg">⏳ Waiting for host…</div>}
            </div>
          </div>
        )}

        {isBidding&&cur&&(
          <div className="stage-wrap">
            <div className="player-card player-card-enter">
              <div className="player-card-glow" style={{background:`radial-gradient(circle at 50% 0%, ${ROLE_COLOR[cur.role]}18, transparent 70%)`}}/>
              <div className="pc-set">{isAccelPhase?"⚡ ACCELERATED":cur.set}</div>
              <div className="pc-name">{cur.name}</div>
              <div className="pc-tags">
                <span className="role-tag" style={{background:ROLE_BG[cur.role],color:ROLE_COLOR[cur.role],border:`1px solid ${ROLE_COLOR[cur.role]}55`,boxShadow:`0 0 8px ${ROLE_COLOR[cur.role]}33`}}>{cur.role}</span>
                {cur.overseas&&<span className="ovs-tag">✈️ Overseas</span>}
              </div>
              <div className="pc-base">Base: {crFmt(cur.basePrice)}</div>
            </div>

            <div className={`bid-board ${bidFlash?"bid-board-flash":""}`}>
              <div className="bid-board-glow"/>
              <div className="bb-label">CURRENT BID</div>
              <div className="bb-amount">{crFmt(a.currentBid)}</div>
              <div className="bb-leader">
                {a.currentBidder?<>by <strong>{a.currentBidder.name}</strong></>:<span style={{color:"#334155"}}>No bids yet — base price</span>}
              </div>
            </div>

            <div className="controls-card">
              {/* Timer display */}
              {a.defaultTimer>0 && (
                <div className="timer-row">
                  <div className={`timer-circle ${a.timerLeft<=10?"timer-warn":""} ${a.timerLeft<=5?"timer-crit":""}`}>
                    <span className="timer-num">{a.timerLeft}</span>
                    <span className="timer-lbl">sec</span>
                  </div>
                  {isHost && (
                    <div className="timer-btns">
                      <button className="tbtn" onClick={()=>upd(p=>({...p,timerRunning:!p.timerRunning}))}>{a.timerRunning?"⏸":"▶"}</button>
                      <button className="tbtn" onClick={()=>upd(p=>({...p,timerLeft:p.timerLeft+15}))}>+15s</button>
                      <button className="tbtn" onClick={()=>upd(p=>({...p,timerLeft:p.defaultTimer,timerRunning:true}))}>↺</button>
                    </div>
                  )}
                </div>
              )}
              {/* Bidding — host sees team selector; team sees only their own button */}
              {isHost ? (
                <select className="team-sel" value={selTeamId} onChange={e=>setSelTeamId(e.target.value)}>
                  {a.teams.map(t=><option key={t.id} value={t.id}>{t.name} — {crFmt(t.budget-t.spent)} left</option>)}
                </select>
              ) : (
                <div className="my-team-label">
                  <span className="mtl-name">{myTeam?.name}</span>
                  <span className="mtl-budget">{crFmt(myTeam ? myTeam.budget-myTeam.spent : 0)} left</span>
                </div>
              )}
              <div className="quick-grid">
                {(a.currentIncrements||DEFAULT_INCS).map((inc,i)=>(
                  <button key={i} className="qbtn" onClick={()=>{ if(isHost){ quickBid(inc); } else { setSelTeamId(role); bid(parseFloat((a.currentBid+inc).toFixed(2))); } }} disabled={!isHost && role!==selTeamId && false}>
                    +{inc} Cr
                  </button>
                ))}
              </div>

              {isHost && (
                <div className="verdict-row">
                  <button className="btn-sold" onClick={markSold} disabled={!a.currentBidder}>✅ SOLD!</button>
                  <button className="btn-unsold" onClick={markUnsold}>✕ Unsold</button>
                </div>
              )}
              {isHost && <button className="btn-end-subtle" onClick={()=>setShowEndConfirm(true)}>End Auction Early</button>}
              {isHost && <button className="btn-end-subtle commentary-edit-btn" onClick={()=>{setEditCategory("draw");setEditLines(commentaryBank["draw"].join("\n"));setShowCommentaryEditor(true);}}>📢 Edit Commentary</button>}
              {/* Reactions */}
              <div className="reaction-bar">
                {REACTION_EMOJIS.map(e=>(
                  <button key={e} className="reaction-btn" onClick={()=>addReaction(e)}>{e}</button>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* RIGHT — tabbed log + chat */}
      <div className="side-panel right-panel">
        <div className="right-tabs">
          <button className={`right-tab ${rightTab==="log"?"right-tab-on":""}`} onClick={()=>setRightTab("log")}>📋 Log</button>
          <button className={`right-tab ${rightTab==="chat"?"right-tab-on":""}`} onClick={()=>setRightTab("chat")}>
            💬 Chat {chatMessages.filter(m=>m.type==="user").length>0&&<span className="chat-badge">{chatMessages.filter(m=>m.type==="user").length}</span>}
          </button>
        </div>

        {rightTab==="log"&&(<>
          <div className="side-title">BID LOG</div>
          <div className="bid-log" ref={bidLogRef}>
            {a.bidHistory.length===0&&<div className="log-empty">Waiting for bids…</div>}
            {a.bidHistory.map((b,i)=>(
              <div key={i} className={`log-row ${i===a.bidHistory.length-1?"log-latest":""}`}>
                <span>{b.team}</span><span>{crFmt(b.amount)}</span>
              </div>
            ))}
          </div>
          <div className="side-title" style={{marginTop:"1rem"}}>SOLD ({a.sold.length})</div>
          <div className="sold-log">
            {a.sold.slice().reverse().slice(0,14).map(p=>{
              const t=a.teams.find(x=>x.id===p.soldTo);
              return (
                <div key={p.id} className="sold-row">
                  <span className="role-pip" style={{background:ROLE_COLOR[p.role]}}/>
                  <span className="sold-name">{p.name}</span>
                  <span className="sold-price">{crFmt(p.soldFor)}</span>
                  <span className="sold-team">{t?.name}</span>
                </div>
              );
            })}
          </div>
        </>)}

        {rightTab==="chat"&&(
          <div className="chat-panel">
            <div className="chat-messages" ref={chatRef}>
              {chatMessages.length===0&&<div className="log-empty">No messages yet…</div>}
              {chatMessages.map(m=>(
                <div key={m.id} className={`chat-msg ${m.type==="bid"?"chat-bid":m.type==="commentary"?"chat-commentary":"chat-user"}`}>
                  {m.type==="user"&&<span className="chat-name">{m.name}</span>}
                  <span className="chat-text">{m.text}</span>
                </div>
              ))}
            </div>
            <div className="chat-input-row">
              <input
                className="inp chat-inp"
                value={chatInput}
                onChange={e=>setChatInput(e.target.value)}
                onKeyDown={e=>e.key==="Enter"&&sendChat()}
                placeholder="Say something…"
              />
              <button className="chat-send-btn" onClick={sendChat}>→</button>
            </div>
          </div>
        )}
      </div>

            {showSaveModal&&(
        <div className="modal-overlay" onClick={()=>setShowSaveModal(false)}>
          <div className="modal-box" onClick={e=>e.stopPropagation()}>
            <div className="modal-glow"/>
            <div className="modal-icon">💾</div>
            <div className="modal-title">Save Progress</div>
            <div className="modal-body" style={{width:"100%"}}>
              <p style={{color:"var(--muted)",marginBottom:".5rem"}}>Name this save so you can resume it later.</p>
              <input
                className="inp"
                value={saveLabel}
                onChange={e=>setSaveLabel(e.target.value)}
                onKeyDown={e=>{ if(e.key==="Enter"){ const k=onSave(saveLabel); setSaveMsg("Saved: "+k); setTimeout(()=>setShowSaveModal(false),1200); }}}
                placeholder={"e.g. Day 1 — "+new Date().toLocaleDateString("en-GB")}
                autoFocus
              />
              {saveMsg&&<div className="save-confirm-msg">{saveMsg}</div>}
            </div>
            <div className="modal-btns">
              <button className="btn-modal-cancel" onClick={()=>setShowSaveModal(false)}>Cancel</button>
              <button className="btn-modal-confirm save-confirm-btn" onClick={()=>{ const k=onSave(saveLabel); setSaveMsg("Saved: "+k); setTimeout(()=>setShowSaveModal(false),1200); }}>Save</button>
            </div>
          </div>
        </div>
      )}
      {showCommentaryEditor&&(
        <div className="modal-overlay" onClick={()=>setShowCommentaryEditor(false)}>
          <div className="commentary-modal" onClick={e=>e.stopPropagation()}>
            <button className="help-close" onClick={()=>setShowCommentaryEditor(false)}>✕</button>
            <div className="commentary-modal-title">📢 Commentary Editor</div>
            <p className="commentary-modal-sub">Customise the auto-commentary lines. Use <code>{name}</code>, <code>{team}</code>, <code>{price}</code>, <code>{amount}</code>, <code>{base}</code>, <code>{team1}</code>, <code>{team2}</code> as placeholders.</p>
            <div className="commentary-cats">
              {Object.keys(DEFAULT_COMMENTARY).map(cat=>(
                <button key={cat} className={`commentary-cat-btn ${editCategory===cat?"commentary-cat-on":""}`}
                  onClick={()=>{setEditCategory(cat);setEditLines(commentaryBank[cat].join("\n"));}}>
                  {cat.replace("_"," ")}
                </button>
              ))}
            </div>
            <div className="commentary-edit-area">
              <div className="commentary-edit-label">One line per comment · They are picked randomly</div>
              <textarea className="commentary-textarea" value={editLines} onChange={e=>setEditLines(e.target.value)} rows={10} spellCheck={false}/>
            </div>
            <div className="commentary-modal-btns">
              <button className="btn-ghost-sm" onClick={resetCommentary}>↺ Reset to defaults</button>
              <button className="btn-add" onClick={()=>{saveCommentaryEdits();setShowCommentaryEditor(false);}}>Save</button>
            </div>
          </div>
        </div>
      )}
      {showEndConfirm&&(
        <div className="modal-overlay" onClick={()=>setShowEndConfirm(false)}>
          <div className="modal-box" onClick={e=>e.stopPropagation()}>
            <div className="modal-glow"/>
            <div className="modal-icon">⚠️</div>
            <div className="modal-title">End Auction?</div>
            <div className="modal-body">
              {a.queue.length>0&&<p><strong>{a.queue.length}</strong> players still in queue</p>}
              {a.accelPool.length>0&&<p><strong>{a.accelPool.length}</strong> in accelerated pool</p>}
              {a.unsold.length>0&&<p><strong>{a.unsold.length}</strong> unsold players</p>}
              <p style={{marginTop:".5rem",color:"#475569"}}>All remaining players will be marked unsold.</p>
            </div>
            <div className="modal-btns">
              <button className="btn-modal-cancel" onClick={()=>setShowEndConfirm(false)}>Cancel</button>
              <button className="btn-modal-confirm" onClick={endAuction}>End Auction</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── RESULTS ── */
function ResultsScreen({ auction:a, onSave }) {
  const [saveLabel, setSaveLabel] = useState("");
  const [saveMsg, setSaveMsg] = useState("");
  return (
    <div className="page">
      <div className="page-hero">
        <h1 className="hero-title">Final Squads</h1>
        <p className="hero-sub">{a.sold.length} players sold · {a.unsold.length} unsold</p>
      </div>
      <div className="squads-grid">
        {a.teams.map(t=>{
          const wkCount=t.players.filter(p=>p.role==="WK").length;
          const wkOk=wkCount>=t.minWK;
          const ovsCount=t.players.filter(p=>p.overseas).length;
          const ovsLimit=t.maxOverseas??4;
          const ovsOk=ovsCount<=ovsLimit;
          return (
            <div key={t.id} className="squad-card">
              <div className="squad-card-glow"/>
              <div className="sq-head">
                <div className="sq-name" style={{color: t.color||"#c0a0ff"}}>{t.name}</div>
                <div className="sq-metas">
                  <span style={{color:"#fbbf24"}}>{crFmt(t.spent)} spent</span>
                  <span style={{color:"#4ade80"}}>{crFmt(t.budget-t.spent)} left</span>
                  <span style={{color:wkOk?"#4ade80":"#f87171"}}>WK {wkCount}/{t.minWK}</span>
                  <span style={{color:ovsOk?"#94a3b8":"#f87171"}}>✈️ {ovsCount}/{ovsLimit}</span>
                </div>
              </div>
              <div className="sq-players">
                {ROLES.map(role=>{
                  const rps=t.players.filter(p=>p.role===role); if(!rps.length) return null;
                  return (
                    <div key={role} className="sq-role-group">
                      <div className="sq-role-label" style={{color:ROLE_COLOR[role]}}>{role}</div>
                      {rps.map(p=>(
                        <div key={p.id} className="sq-player-row">
                          <span className="sq-player-name">{p.name}</span>
                          {p.overseas&&<span className="ovs-pip">OVS</span>}
                          <span className="sq-player-price">{crFmt(p.soldFor)}</span>
                        </div>
                      ))}
                    </div>
                  );
                })}
                {t.players.length===0&&<div className="empty-hint">No players acquired</div>}
              </div>
            </div>
          );
        })}
      </div>
      {onSave && (
        <div className="results-save-bar">
          <span className="results-save-label">💾 Save this auction</span>
          <input className="inp results-save-inp" value={saveLabel} onChange={e=>setSaveLabel(e.target.value)} onKeyDown={e=>{ if(e.key==="Enter"){ const k=onSave(saveLabel); setSaveMsg("✅ "+k); setSaveLabel(""); }}} placeholder={"e.g. Final Results — "+new Date().toLocaleDateString("en-GB")} />
          <button className="btn-add" onClick={()=>{ const k=onSave(saveLabel||("Results "+new Date().toLocaleDateString("en-GB"))); setSaveMsg("✅ "+k); setSaveLabel(""); }}>Save</button>
          {saveMsg&&<span className="save-confirm-msg">{saveMsg}</span>}
        </div>
      )}
      {a.unsold.length>0&&(
        <div>
          <div className="results-sub-title">Unsold Players ({a.unsold.length})</div>
          <div className="unsold-grid">
            {a.unsold.map(p=>(
              <div key={p.id} className="unsold-chip">
                <span className="role-pip" style={{background:ROLE_COLOR[p.role]}}/>
                <span>{p.name}</span>
                <span style={{color:ROLE_COLOR[p.role],fontSize:".68rem"}}>{p.role}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}


function Field({ label, children }) {
  return <div className="field"><label className="field-label">{label}</label>{children}</div>;
}

/* ── CSS ── */
const CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Syne:wght@600;700;800&display=swap');
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  :root{
    --bg:#03030a;
    --surface:#09091a;
    --surface2:#0d0e1e;
    --border:#1e2040;
    --border-glow:#4a4c8a;
    --text:#f0f2ff;
    --muted:#6068a0;
    --iris:#b09dff;
    --cyan:#00f0ff;
    --violet:#d580ff;
    --green:#00ff88;
    --gold:#ffe040;
    --red:#ff5577;
    --accel:#ffaa00;
    --pink:#ff40aa;
    --teal:#00ffd0;
  }
  body{background:var(--bg);color:var(--text);font-family:'Inter',sans-serif}

  /* ── topbar ── */
  .topbar{
    display:flex;align-items:center;gap:1rem;padding:.7rem 1.75rem;
    background:rgba(5,5,8,0.85);
    border-bottom:1px solid var(--border-glow);
    position:sticky;top:0;z-index:50;
    backdrop-filter:blur(20px);
    -webkit-backdrop-filter:blur(20px);
  }
  .topbar::after{
    content:'';position:absolute;bottom:0;left:0;right:0;height:1px;
    background:linear-gradient(90deg,transparent,#b09dff99,#00f0ff88,#00ff8866,transparent);box-shadow:0 0 18px #b09dff22;
  }
  .logo-img{height:36px;width:auto;border-radius:6px;object-fit:contain}
  .logo-wrap{display:flex;align-items:center;gap:.75rem}
  .logo-text{
    font-family:'Syne',sans-serif;font-size:1.35rem;font-weight:800;letter-spacing:1px;
    background:linear-gradient(135deg,#d080ff,#00e8ff,#00ff88);
    -webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;
  }
  .logo-sub{font-size:.6rem;font-weight:600;color:var(--muted);letter-spacing:3px;text-transform:uppercase;align-self:flex-end;padding-bottom:2px}
  .topbar-nav{display:flex;gap:.35rem;margin-left:auto}
  .tnav{
    background:transparent;border:1px solid var(--border);color:var(--muted);
    padding:.35rem 1rem;border-radius:7px;cursor:pointer;
    font-size:.8rem;font-family:'Inter',sans-serif;font-weight:500;
    transition:all .2s;
  }
  .tnav:hover:not(:disabled){border-color:var(--iris);color:var(--iris);box-shadow:0 0 14px #b09dff44}
  .tnav-on{
    background:linear-gradient(135deg,#6b40ff,#c040ff);
    border-color:transparent!important;color:#fff!important;
    box-shadow:0 0 20px #a040ff66;
  }
  .tnav:disabled{opacity:.25;cursor:not-allowed}

  /* ── page ── */
  .page{max-width:1120px;margin:0 auto;padding:1.75rem 2rem;display:flex;flex-direction:column;gap:1.5rem;position:relative;z-index:1}
  .center-page{align-items:center;justify-content:center;min-height:80vh}
  .page-hero{margin-bottom:-.25rem}
  .hero-title{
    font-family:'Syne',sans-serif;font-size:2rem;font-weight:800;
    background:linear-gradient(135deg,#ffffff 0%,#c890ff 40%,#00f0ff 100%);
    -webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;
  }
  .hero-sub{color:var(--muted);font-size:.875rem;margin-top:.3rem}

  /* ── setup grid ── */
  .setup-grid{display:grid;grid-template-columns:1fr 1fr;gap:1.5rem;align-items:start}
  @media(max-width:700px){.setup-grid{grid-template-columns:1fr}}

  /* ── panel ── */
  .panel{
    background:var(--surface);
    border:1px solid var(--border-glow);
    border-radius:16px;padding:1.5rem;
    display:flex;flex-direction:column;gap:1.1rem;
    position:relative;overflow:hidden;
  }
  .panel::before{
    content:'';position:absolute;top:0;left:0;right:0;height:1px;
    background:linear-gradient(90deg,transparent,#b09dff66,#00f0ff55,transparent);
  }
  .panel-head{display:flex;align-items:center;gap:.65rem;font-family:'Syne',sans-serif;font-size:.95rem;font-weight:700;color:var(--text);padding-bottom:.75rem;border-bottom:1px solid var(--border)}
  .step-chip{
    background:linear-gradient(135deg,#7c5bff,#c040ff);
    color:#fff;font-size:.62rem;font-weight:700;
    padding:2px 9px;border-radius:20px;
    font-family:'Inter',sans-serif;letter-spacing:1px;
    box-shadow:0 0 14px #9d6aff88;
  }

  /* ── form ── */
  .form-stack{display:flex;flex-direction:column;gap:.75rem}
  .form-row3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:.5rem;align-items:end}
  .form-row4{display:grid;grid-template-columns:repeat(4,1fr);gap:.6rem;align-items:end}
  .field{display:flex;flex-direction:column;gap:.25rem}
  .field-label{font-size:.68rem;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.8px;min-height:2.2em;display:flex;align-items:flex-end;padding-bottom:.1rem}
  .inp{
    background:var(--surface2);border:1px solid var(--border);
    color:var(--text);padding:.52rem .75rem;border-radius:9px;
    font-size:.875rem;font-family:'Inter',sans-serif;
    outline:none;transition:border-color .2s,box-shadow .2s;width:100%;
  }
  .inp:focus{border-color:var(--iris);box-shadow:0 0 0 3px #b09dff22;border-color:#b09dff}

  /* ── buttons ── */
  .btn-row{display:flex;gap:.5rem;align-items:center}
  .btn-add{
    background:linear-gradient(135deg,#7c5bff,#c040ff);
    color:#fff;border:none;padding:.5rem 1.1rem;border-radius:9px;
    font-weight:600;font-size:.85rem;cursor:pointer;
    font-family:'Inter',sans-serif;transition:opacity .2s,box-shadow .2s;
    box-shadow:0 0 18px #9d6aff55;
  }
  .btn-add:hover{opacity:.9;box-shadow:0 0 28px #c040ff77}
  .btn-ghost-sm{
    background:transparent;color:var(--muted);border:1px solid var(--border);
    padding:.5rem .9rem;border-radius:9px;font-size:.82rem;cursor:pointer;
    font-family:'Inter',sans-serif;transition:all .2s;
  }
  .btn-ghost-sm:hover{border-color:var(--muted);color:var(--text)}
  .icon-btn{background:none;border:none;cursor:pointer;font-size:.85rem;opacity:.4;padding:.2rem .3rem;transition:opacity .15s}
  .icon-btn:hover{opacity:1}
  .icon-btn.danger:hover{color:var(--red);opacity:1}
  .icon-btn.small{font-size:.68rem}

  /* ── teams ── */
  .team-list{display:flex;flex-direction:column;gap:.4rem}
  .team-row{
    background:var(--surface2);border:1px solid var(--border);
    border-radius:10px;padding:.6rem .9rem;
    display:flex;align-items:center;gap:.6rem;flex-wrap:nowrap;
    transition:border-color .2s;min-width:0;
  }
  .team-row:hover{border-color:var(--border-glow)}
  .team-row-name{font-weight:600;font-size:.85rem;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .team-row-meta{display:flex;gap:.3rem;flex-wrap:nowrap;align-items:center;flex-shrink:0;overflow:hidden}
  .meta-chip{background:var(--border);color:var(--muted);font-size:.65rem;padding:2px 7px;border-radius:10px;font-weight:500;white-space:nowrap;flex-shrink:0}
  .wk-chip{background:#1a1206;color:var(--gold);border:1px solid #f59e0b33}
  .ovs-chip{background:#0c1e2e;color:#38bdf8;border:1px solid #38bdf833}
  .team-row-actions{display:flex;gap:.15rem;flex-shrink:0}

  /* ── upload ── */
  .upload-zone{
    border:2px dashed var(--border-glow);border-radius:14px;padding:1.5rem;
    text-align:center;cursor:pointer;transition:all .2s;
    background:var(--surface2);
  }
  .upload-zone:hover{border-color:var(--iris);box-shadow:0 0 24px #b09dff33;border-color:#b09dff}
  .upload-icon{font-size:1.75rem;margin-bottom:.4rem}
  .upload-main{font-weight:600;font-size:.9rem;margin-bottom:.3rem}
  .upload-sub{font-size:.73rem;color:var(--muted);line-height:1.65}
  .upload-sub code{background:var(--border);padding:1px 6px;border-radius:4px;font-family:monospace;font-size:.68rem;color:var(--cyan);display:inline-block;margin:0 1px}

  /* ── sets ── */
  .sets-list{display:flex;flex-direction:column;gap:.5rem}
  .set-block{background:var(--surface2);border:1px solid var(--border);border-radius:11px;overflow:hidden;transition:border-color .2s}
  .set-block-accel{border-color:#f59e0b44;background:#0e0a00}
  .set-summary{display:flex;align-items:center;gap:.5rem;padding:.6rem .85rem;cursor:pointer;user-select:none;list-style:none}
  .set-summary::-webkit-details-marker{display:none}
  .set-order{background:linear-gradient(135deg,#7c5bff,#c040ff);color:#fff;font-size:.62rem;font-weight:700;padding:1px 7px;border-radius:10px;flex-shrink:0}
  .set-name{font-weight:600;font-size:.88rem;flex:1}
  .accel-badge{background:#1a1000;color:var(--accel);font-size:.62rem;font-weight:700;padding:1px 7px;border-radius:10px;border:1px solid #f59e0b33}
  .set-count{font-size:.72rem;color:var(--muted);flex-shrink:0}
  .toggle-accel-btn{background:transparent;border:1px solid var(--border);color:var(--muted);padding:2px 7px;border-radius:6px;cursor:pointer;font-size:.75rem;transition:all .15s;flex-shrink:0}
  .toggle-accel-btn:hover{border-color:var(--accel);color:var(--accel)}
  .toggle-accel-on{background:#1a1000;border-color:var(--accel)!important;color:var(--accel)!important}
  .inc-editor{padding:.5rem .85rem .3rem;border-top:1px solid var(--border)}
  .inc-label{font-size:.62rem;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.8px;margin-bottom:.35rem}
  .inc-row{display:flex;gap:.5rem;flex-wrap:wrap;align-items:center}
  .inc-field{display:flex;align-items:center;gap:.25rem}
  .inc-tag{font-size:.62rem;color:var(--muted)}
  .inc-inp{width:62px!important;padding:.28rem .4rem!important;font-size:.76rem!important}
  .set-players{padding:.4rem .9rem .8rem;display:flex;flex-direction:column;gap:.3rem}
  .set-player-row{display:flex;align-items:center;gap:.5rem;font-size:.8rem;padding:.25rem 0;border-top:1px solid var(--border)}
  .role-pip{width:6px;height:6px;border-radius:50%;flex-shrink:0}
  .sp-name{flex:1;font-weight:500}
  .sp-role{font-size:.67rem;font-weight:700}
  .ovs-pip{background:#0c1e2e;color:#38bdf8;font-size:.62rem;font-weight:700;padding:1px 6px;border-radius:10px;border:1px solid #1e3a5f}
  .sp-price{color:var(--gold);font-size:.74rem;font-weight:600;margin-left:auto}

  /* ── start bar ── */
  .start-bar{
    display:flex;align-items:center;gap:1rem;padding:1rem 1.25rem;
    background:var(--surface);border:1px solid var(--border-glow);border-radius:14px;
    position:relative;overflow:hidden;
  }
  .start-bar::before{
    content:'';position:absolute;top:0;left:0;right:0;height:1px;
    background:linear-gradient(90deg,transparent,#b09dff55,#00f0ff44,#00ff8844,transparent);box-shadow:0 0 16px #b09dff11;
  }
  .start-info{display:flex;gap:.4rem;flex-wrap:wrap;flex:1;align-items:center}
  .info-pill{background:var(--surface2);border:1px solid var(--border);color:var(--muted);font-size:.75rem;padding:.22rem .7rem;border-radius:20px}
  .accel-pill{background:#1a1000;border-color:#f59e0b33;color:var(--accel)}
  .btn-start{
    background:linear-gradient(135deg,#6b40ff,#c040ff,#00c8e0);
    color:#fff;border:none;padding:.65rem 1.6rem;border-radius:10px;
    font-weight:700;font-size:.9rem;cursor:pointer;
    font-family:'Inter',sans-serif;
    display:flex;align-items:center;gap:.5rem;white-space:nowrap;
    box-shadow:0 0 24px #a040ff66,0 0 48px #00f0ff33;
    transition:all .2s;
  }
  .btn-start:hover:not(:disabled){box-shadow:0 0 36px #c040ff88,0 0 64px #00f0ff55;transform:translateY(-1px)}
  .btn-start:disabled{opacity:.25;cursor:not-allowed;box-shadow:none;transform:none}

  /* ── auction root ── */
  .auction-root{display:grid;grid-template-columns:240px 1fr 240px;min-height:calc(100vh - 52px);position:relative;z-index:1}
  .side-panel{
    background:rgba(9,9,26,0.97);border-right:1px solid var(--border-glow);
    padding:1rem;display:flex;flex-direction:column;gap:.5rem;overflow-y:auto;min-width:0;
  }
  .right-panel{border-right:none;border-left:1px solid var(--border-glow)}
  .side-title{
    font-size:.6rem;font-weight:700;letter-spacing:2px;color:var(--muted);
    text-transform:uppercase;padding-bottom:.4rem;border-bottom:1px solid var(--border);flex-shrink:0;
  }

  /* franchise cards */
  .fcard{
    background:var(--surface2);border:1px solid var(--border);
    border-radius:10px;padding:.7rem;transition:all .2s;flex-shrink:0;
  }
  .fcard-leading{
    border-color:#00ff8888;background:#041a10;
    box-shadow:0 0 20px #00ff8833;
  }
  .fcard-top{display:flex;align-items:center;justify-content:space-between;margin-bottom:.3rem;gap:.4rem;min-width:0}
  .fcard-name{font-weight:600;font-size:.79rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0}
  .leading-tag{
    background:#041a10;color:#00ff88;font-size:.55rem;font-weight:700;
    padding:1px 7px;border-radius:10px;letter-spacing:1px;white-space:nowrap;flex-shrink:0;
    border:1px solid #00ff8866;box-shadow:0 0 12px #00ff8855;
  }
  .fcard-stats{display:grid;grid-template-columns:repeat(4,1fr);font-size:.68rem;color:var(--muted);margin-bottom:.35rem;gap:.25rem;text-align:center}
  .budget-remain{color:#ffe040;font-weight:600;text-shadow:0 0 8px #ffe04066}
  .budget-track{height:3px;background:var(--border);border-radius:2px;margin-top:.25rem}
  .budget-fill{height:100%;background:linear-gradient(90deg,#b09dff,#00f0ff);border-radius:2px;transition:width .4s;box-shadow:0 0 10px #b09dff88}
  .progress-block{margin-top:auto;padding:.75rem 0 0;border-top:1px solid var(--border);flex-shrink:0}
  .prog-label{font-size:.68rem;color:var(--muted);margin-bottom:.3rem}
  .prog-track{height:4px;background:var(--border);border-radius:3px;margin-bottom:.35rem}
  .prog-fill{height:100%;background:linear-gradient(90deg,#d580ff,#b09dff,#00f0ff);border-radius:3px;transition:width .4s;box-shadow:0 0 12px #b09dff66}
  .prog-set{font-size:.72rem;color:var(--muted);margin-top:.2rem}
  .prog-set strong{color:var(--text)}

  /* ── auction center ── */
  .auction-center{
    display:flex;align-items:center;justify-content:center;padding:2rem 1.5rem;
    background:var(--bg);overflow-y:auto;
  }

  /* idle */
  .idle-wrap{text-align:center;display:flex;flex-direction:column;align-items:center;gap:1rem}
  .set-label-big{
    background:var(--surface);border:1px solid var(--border-glow);
    color:var(--cyan);font-size:.65rem;font-weight:700;letter-spacing:3px;
    padding:.3rem 1.1rem;border-radius:20px;text-transform:uppercase;
    box-shadow:0 0 18px #00f0ff33;text-shadow:0 0 10px #00f0ff88;
  }
  .idle-count{font-size:.9rem;color:var(--muted)}
  .btn-draw{
    background:linear-gradient(135deg,#6b40ff,#c040ff);
    color:#fff;border:none;padding:.9rem 2.25rem;border-radius:12px;
    font-family:'Syne',sans-serif;font-size:1.15rem;font-weight:700;
    letter-spacing:.5px;cursor:pointer;
    box-shadow:0 0 28px #a040ff77;
    transition:all .2s;
  }
  .btn-draw:hover:not(:disabled){box-shadow:0 0 48px #c040ffaa,0 0 80px #c040ff33;transform:translateY(-2px) scale(1.02)}
  .btn-draw:disabled{opacity:.3;cursor:not-allowed;transform:none;box-shadow:none}
  .btn-accel-start{
    background:#0e0a00;color:var(--accel);
    border:1px solid #f59e0b55;padding:.6rem 1.5rem;border-radius:10px;
    font-weight:600;font-size:.85rem;cursor:pointer;font-family:'Inter',sans-serif;
    box-shadow:0 0 14px #f59e0b11;transition:all .2s;
  }
  .btn-accel-start:hover{box-shadow:0 0 20px #f59e0b33;border-color:var(--accel)}
  .btn-end-subtle{
    background:transparent;color:var(--muted);border:1px solid var(--border);
    padding:.4rem 1rem;border-radius:8px;font-size:.75rem;cursor:pointer;
    font-family:'Inter',sans-serif;transition:all .15s;
  }
  .btn-end-subtle:hover{border-color:var(--red);color:var(--red)}

  /* accel manage */
  .accel-wrap{display:flex;flex-direction:column;align-items:center;gap:1.25rem;width:100%;max-width:660px}
  .accel-header{text-align:center}
  .accel-glow-badge{
    display:inline-block;
    background:linear-gradient(135deg,#1a1000,#0e0a00);
    color:var(--accel);border:1px solid #f59e0b55;
    font-size:.72rem;font-weight:700;padding:.3rem 1.1rem;border-radius:20px;
    letter-spacing:2px;box-shadow:0 0 20px #ffaa0044;
  }
  .accel-sub{color:var(--muted);font-size:.8rem;margin-top:.4rem}
  .accel-columns{display:grid;grid-template-columns:1fr 32px 1fr;gap:.75rem;width:100%;align-items:start}
  .accel-col{background:var(--surface);border:1px solid var(--border-glow);border-radius:12px;overflow:hidden}
  .accel-col-title{font-size:.6rem;font-weight:700;letter-spacing:1.5px;color:var(--muted);text-transform:uppercase;padding:.55rem .8rem;border-bottom:1px solid var(--border);background:var(--surface2)}
  .accel-list{padding:.4rem .5rem;display:flex;flex-direction:column;gap:.25rem;max-height:260px;overflow-y:auto}
  .accel-divider{display:flex;align-items:center;justify-content:center;color:var(--accel);font-size:1.25rem;padding-top:2.5rem;text-shadow:0 0 12px var(--accel)}
  .accel-player-row{display:flex;align-items:center;gap:.4rem;font-size:.8rem;padding:.3rem .3rem;border-radius:7px;transition:background .1s}
  .accel-player-row:hover{background:var(--surface2)}
  .accel-pool-row{background:#0e0a00 !important}
  .accel-pname{flex:1;font-weight:500}
  .accel-prole{font-size:.66rem;font-weight:700}
  .btn-add-accel{
    background:linear-gradient(135deg,#7c5bff,#c040ff);color:#fff;border:none;
    padding:2px 8px;border-radius:5px;cursor:pointer;font-size:.73rem;font-weight:700;
    transition:opacity .15s;flex-shrink:0;box-shadow:0 0 12px #a040ff66;
  }
  .btn-add-accel:hover{opacity:.8}
  .btn-remove-accel{
    background:#1a0808;color:var(--red);border:1px solid #f8717133;
    padding:2px 7px;border-radius:5px;cursor:pointer;font-size:.73rem;font-weight:700;
    transition:opacity .15s;flex-shrink:0;
  }
  .btn-remove-accel:hover{opacity:.8}
  .accel-actions{display:flex;flex-direction:column;align-items:center;gap:.6rem}

  /* bidding stage */
  .stage-wrap{display:flex;flex-direction:column;gap:.85rem;width:100%;max-width:440px}

  @keyframes card-enter{from{opacity:0;transform:translateY(18px) scale(.96)}to{opacity:1;transform:translateY(0) scale(1)}}
  .player-card-enter{animation:card-enter .35s cubic-bezier(.17,.67,.41,1.2) forwards}
  .player-card{
    background:var(--surface);border:1px solid var(--border-glow);
    border-radius:16px;padding:1.25rem 1.5rem;text-align:center;
    position:relative;overflow:hidden;
  }
  .player-card-glow{position:absolute;inset:0;pointer-events:none}
  .player-card::before{
    content:'';position:absolute;top:0;left:0;right:0;height:1px;
    background:linear-gradient(90deg,transparent,#b09dff66,#00f0ff55,transparent);
  }
  .pc-set{font-size:.6rem;font-weight:700;letter-spacing:2.5px;color:var(--muted);text-transform:uppercase;margin-bottom:.3rem;position:relative}
  .pc-name{
    font-family:'Syne',sans-serif;font-size:1.85rem;font-weight:800;
    letter-spacing:.5px;line-height:1.1;margin-bottom:.45rem;
    position:relative;
    background:linear-gradient(135deg,#ffffff,#d0b8ff,#80e8ff);
    -webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;
  }
  .pc-tags{display:flex;justify-content:center;gap:.4rem;margin-bottom:.4rem;position:relative}
  .role-tag{font-size:.68rem;font-weight:700;padding:3px 12px;border-radius:20px}
  .ovs-tag{background:#0c1e2e;color:#38bdf8;font-size:.68rem;padding:3px 10px;border-radius:20px;border:1px solid #1e3a5f;box-shadow:0 0 8px #38bdf811}
  .pc-base{font-size:.76rem;color:var(--muted);position:relative}

  .bid-board{
    background:var(--surface);border:1px solid #6b40ff88;
    border-radius:14px;padding:1rem;text-align:center;position:relative;overflow:hidden;
  }
  .bid-board-glow{
    position:absolute;inset:0;
    background:radial-gradient(ellipse at 50% 0%,#7c40ff28,transparent 70%);
    pointer-events:none;
  }
  .bid-board::before{
    content:'';position:absolute;top:0;left:0;right:0;height:1px;
    background:linear-gradient(90deg,transparent,#b09dff99,#00f0ff77,transparent);
    box-shadow:0 0 14px #b09dff66;
  }
  .bb-label{font-size:.6rem;font-weight:700;letter-spacing:2.5px;color:var(--muted);text-transform:uppercase;margin-bottom:.1rem;position:relative}
  .bb-amount{
    font-family:'Syne',sans-serif;font-size:2.4rem;font-weight:800;line-height:1.1;position:relative;
    background:linear-gradient(135deg,#ffe040,#ffaa00,#fff176);
    -webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;
    filter:drop-shadow(0 0 16px #ffe04077);
  }
  .bb-leader{font-size:.82rem;color:var(--muted);margin-top:.2rem;position:relative}
  .bb-leader strong{color:var(--text)}

  .controls-card{
    background:var(--surface);border:1px solid var(--border-glow);
    border-radius:14px;padding:1.1rem;display:flex;flex-direction:column;gap:.7rem;
  }
  .team-sel{
    width:100%;background:var(--surface2);border:1px solid var(--border);
    color:var(--text);padding:.5rem .75rem;border-radius:9px;
    font-size:.84rem;font-family:'Inter',sans-serif;outline:none;
    transition:border-color .2s,box-shadow .2s;
  }
  .team-sel:focus{border-color:#b09dff;box-shadow:0 0 0 3px #b09dff22}
  .quick-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:.4rem}
  .qbtn{
    background:var(--surface2);border:1px solid var(--border);
    color:var(--muted);padding:.5rem .25rem;border-radius:8px;
    font-size:.76rem;font-weight:600;cursor:pointer;
    font-family:'Inter',sans-serif;transition:all .2s;text-align:center;
  }
  .qbtn:hover{border-color:var(--iris);color:var(--iris);box-shadow:0 0 14px #b09dff55;background:#1a1530}

  .verdict-row{display:grid;grid-template-columns:1fr 1fr;gap:.6rem}
  .btn-sold{
    background:linear-gradient(135deg,#04200f,#062a14);color:var(--green);
    border:1px solid #00ff8866;padding:.7rem .5rem;border-radius:10px;
    font-weight:700;font-size:.88rem;cursor:pointer;font-family:'Inter',sans-serif;
    box-shadow:0 0 16px #00ff8833;transition:all .2s;
  }
  .btn-sold:hover:not(:disabled){background:linear-gradient(135deg,#063018,#083820);border-color:var(--green);box-shadow:0 0 28px #00ff8866}
  .btn-sold:disabled{opacity:.25;cursor:not-allowed;box-shadow:none}
  .btn-unsold{
    background:linear-gradient(135deg,#1e0510,#280810);color:var(--red);
    border:1px solid #ff557766;padding:.7rem .5rem;border-radius:10px;
    font-weight:700;font-size:.88rem;cursor:pointer;font-family:'Inter',sans-serif;
    box-shadow:0 0 12px #ff557722;transition:all .2s;
  }
  .btn-unsold:hover{background:linear-gradient(135deg,#2a0618,#340a14);border-color:var(--red);box-shadow:0 0 22px #ff557755}

  /* logs */
  .bid-log{max-height:155px;overflow-y:auto;display:flex;flex-direction:column;gap:.25rem}
  .log-empty{font-size:.73rem;color:var(--muted);font-style:italic}
  .log-row{display:flex;justify-content:space-between;font-size:.74rem;padding:.2rem 0;border-bottom:1px solid var(--border);color:var(--muted)}
  .log-latest{color:#00ff88;font-weight:600;text-shadow:0 0 10px #00ff8877}
  .sold-log{display:flex;flex-direction:column;gap:.28rem;overflow-y:auto}
  .sold-row{display:flex;align-items:center;gap:.4rem;font-size:.74rem;padding:.22rem 0;border-bottom:1px solid var(--border)}
  .sold-name{flex:1;font-weight:500}
  .sold-price{color:#ffe040;font-weight:600;white-space:nowrap;text-shadow:0 0 8px #ffe04055}
  .sold-team{color:var(--muted);font-size:.65rem;white-space:nowrap}

  /* modal */
  .modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.75);display:flex;align-items:center;justify-content:center;z-index:100;backdrop-filter:blur(6px)}
  .modal-box{
    background:var(--surface);border:1px solid var(--border-glow);
    border-radius:18px;padding:2rem;max-width:380px;width:92%;
    display:flex;flex-direction:column;align-items:center;gap:.85rem;text-align:center;
    position:relative;overflow:hidden;
    box-shadow:0 0 60px #0005;
  }
  .modal-glow{
    position:absolute;top:-40px;left:50%;transform:translateX(-50%);
    width:200px;height:200px;border-radius:50%;
    background:radial-gradient(circle,#6366f122,transparent 70%);
    pointer-events:none;
  }
  .modal-icon{font-size:2.5rem;position:relative}
  .modal-title{font-family:'Syne',sans-serif;font-size:1.35rem;font-weight:800;position:relative}
  .modal-body{font-size:.83rem;color:var(--muted);line-height:1.8;width:100%;position:relative}
  .modal-body p{margin-bottom:.1rem}
  .modal-body strong{color:var(--text)}
  .modal-btns{display:grid;grid-template-columns:1fr 1fr;gap:.6rem;width:100%;position:relative}
  .btn-modal-cancel{background:transparent;color:var(--text);border:1px solid var(--border);padding:.65rem;border-radius:9px;font-weight:600;cursor:pointer;font-family:'Inter',sans-serif;font-size:.85rem;transition:all .15s}
  .btn-modal-cancel:hover{border-color:var(--muted)}
  .btn-modal-confirm{background:#120808;color:var(--red);border:1px solid #f8717144;padding:.65rem;border-radius:9px;font-weight:700;cursor:pointer;font-family:'Inter',sans-serif;font-size:.85rem;transition:all .2s}
  .btn-modal-confirm:hover{background:#1e0808;border-color:var(--red);box-shadow:0 0 16px #f8717122}

  /* done */
  .done-card{
    background:var(--surface);border:1px solid var(--border-glow);
    border-radius:20px;padding:2.5rem;text-align:center;
    display:flex;flex-direction:column;align-items:center;gap:1rem;max-width:380px;
    position:relative;overflow:hidden;
  }
  .done-glow{
    position:absolute;top:-60px;left:50%;transform:translateX(-50%);
    width:300px;height:300px;border-radius:50%;
    background:radial-gradient(circle,#9940ff38,#00e8ff22,transparent 70%);
    animation:pulse 3s ease-in-out infinite;
    pointer-events:none;
  }
  @keyframes pulse{0%,100%{opacity:.5;transform:translateX(-50%) scale(1)}50%{opacity:1;transform:translateX(-50%) scale(1.1)}}
  .done-title{
    font-family:'Syne',sans-serif;font-size:2rem;font-weight:800;position:relative;
    background:linear-gradient(135deg,#d080ff,#00e8ff,#00ff88);
    -webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;
  }
  .done-sub{color:var(--muted);position:relative}

  /* results */
  .squads-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(270px,1fr));gap:1.25rem}
  .squad-card{background:var(--surface);border:1px solid var(--border-glow);border-radius:14px;overflow:hidden;position:relative;transition:border-color .2s}
  .squad-card:hover{border-color:#818cf833}
  .squad-card-glow{position:absolute;top:0;left:0;right:0;height:1px;background:linear-gradient(90deg,transparent,#818cf833,#22d3ee22,transparent)}
  .sq-head{padding:1rem 1.1rem;background:var(--surface2);border-bottom:1px solid var(--border)}
  .sq-name{
    font-family:'Syne',sans-serif;font-size:1rem;font-weight:700;margin-bottom:.3rem;
    background:linear-gradient(135deg,#ffffff,#c0a0ff,#80e0ff);
    -webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;
  }
  .sq-metas{display:flex;gap:.5rem;font-size:.74rem;font-weight:600;flex-wrap:wrap;align-items:center;margin-top:.3rem}
  .sq-players{padding:.85rem 1.1rem;display:flex;flex-direction:column;gap:.6rem}
  .sq-role-label{font-size:.6rem;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:.25rem}
  .sq-player-row{display:flex;align-items:center;gap:.4rem;font-size:.79rem;padding:.12rem 0}
  .sq-player-name{flex:1}
  .sq-player-price{color:var(--gold);font-weight:600;font-size:.74rem}
  .results-sub-title{font-family:'Syne',sans-serif;font-size:1.1rem;font-weight:700;color:var(--muted);margin-bottom:.5rem}
  .unsold-grid{display:flex;flex-wrap:wrap;gap:.4rem}
  .unsold-chip{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:.3rem .65rem;display:flex;align-items:center;gap:.4rem;font-size:.78rem}

  .empty-hint{color:var(--muted);font-size:.78rem;font-style:italic;text-align:center;padding:.5rem 0}

  /* ── login ── */
  .login-card{
    background:var(--surface);border:1px solid var(--border-glow);border-radius:20px;
    padding:2.5rem 2rem;display:flex;flex-direction:column;align-items:center;gap:1.5rem;
    width:100%;max-width:460px;position:relative;overflow:hidden;
  }
  .login-card::before{content:'';position:absolute;top:0;left:0;right:0;height:1px;background:linear-gradient(90deg,transparent,#b09dff66,#00f0ff55,transparent)}
  .login-card::after{
    content:'';position:absolute;inset:0;pointer-events:none;
    background:radial-gradient(ellipse at 50% 0%,#8840ff0a,transparent 65%);
  }
  .login-brand{display:flex;align-items:center;gap:1rem;position:relative;z-index:1}
  .login-brand-img{height:52px;width:auto;border-radius:8px;object-fit:contain;filter:drop-shadow(0 0 12px #b09dff44)}
  .login-brand-text{display:flex;flex-direction:column;gap:1px}
  .login-brand-name{
    font-family:'Syne',sans-serif;font-size:2rem;font-weight:800;line-height:1;
    color:#ffffff;
    letter-spacing:2px;
  }
  .login-brand-sub{
    font-size:.58rem;font-weight:700;letter-spacing:4px;text-transform:uppercase;
    color:var(--muted);
  }
  .login-divider{width:100%;height:1px;background:linear-gradient(90deg,transparent,var(--border-glow),transparent);position:relative;z-index:1}
  .login-sub{color:var(--muted);font-size:.85rem;letter-spacing:.3px;position:relative;z-index:1}
  .login-options{display:flex;flex-direction:column;gap:.6rem;width:100%}
  .login-opt{background:var(--surface2);border:1px solid var(--border-glow);border-radius:12px;padding:.85rem 1.1rem;cursor:pointer;display:flex;align-items:center;gap:.85rem;transition:all .2s;width:100%;text-align:left}
  .login-opt:hover{transform:translateY(-1px)}
  .host-opt:hover{border-color:#b09dff;box-shadow:0 0 20px #b09dff22}
  .team-opt:hover{border-color:#00f0ff;box-shadow:0 0 20px #00f0ff22}
  .opt-icon{font-size:1.4rem;flex-shrink:0}
  .opt-label{font-weight:700;font-size:.95rem;color:var(--text);flex:1}
  .opt-desc{font-size:.72rem;color:var(--muted)}
  .pin-wrap{display:flex;flex-direction:column;gap:.75rem;width:100%;align-items:center}
  .pin-label{font-size:.8rem;color:var(--muted);align-self:flex-start}
  .pin-inp{text-align:center;font-size:1.4rem;letter-spacing:.5rem;width:100%}
  .pin-err{color:var(--red);font-size:.8rem;text-shadow:0 0 8px #ff557744}
  .pin-btns{display:flex;gap:.6rem;width:100%}
  .pin-btns .btn-add{flex:1}

  /* ── role badge ── */
  .role-badge{font-size:.7rem;font-weight:700;padding:.25rem .75rem;border-radius:20px;letter-spacing:1px;white-space:nowrap}
  .role-host{background:linear-gradient(135deg,#7c5bff,#c040ff);color:#fff;box-shadow:0 0 12px #a040ff55}
  .role-team{background:#0c1e2e;color:#00f0ff;border:1px solid #00f0ff44;box-shadow:0 0 10px #00f0ff22}

  /* ── host settings bar ── */
  .host-settings-bar{background:var(--surface);border:1px solid var(--border-glow);border-radius:14px;padding:1.1rem 1.25rem;display:flex;flex-direction:column;gap:.75rem;position:relative;overflow:hidden}
  .host-settings-bar::before{content:'';position:absolute;top:0;left:0;right:0;height:1px;background:linear-gradient(90deg,transparent,#ffaa0055,#ffe04033,transparent)}
  .hs-title{font-size:.78rem;font-weight:700;color:var(--accel);letter-spacing:1px}
  .hs-fields{display:grid;grid-template-columns:repeat(3,1fr);gap:.75rem;align-items:end}

  /* ── timer ── */
  .timer-row{display:flex;align-items:center;gap:.85rem;background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:.6rem .85rem}
  .timer-circle{display:flex;flex-direction:column;align-items:center;justify-content:center;width:52px;height:52px;border-radius:50%;border:2px solid #b09dff55;background:var(--surface);flex-shrink:0;transition:border-color .3s,box-shadow .3s}
  .timer-warn{border-color:#ffaa0088;box-shadow:0 0 12px #ffaa0044}
  .timer-crit{border-color:#ff557799;box-shadow:0 0 16px #ff557766;animation:pulse-red .5s ease-in-out infinite alternate}
  @keyframes pulse-red{from{box-shadow:0 0 10px #ff557744}to{box-shadow:0 0 24px #ff5577aa}}
  .timer-num{font-family:'Syne',sans-serif;font-size:1.1rem;font-weight:800;line-height:1;color:var(--text)}
  .timer-lbl{font-size:.52rem;color:var(--muted);letter-spacing:1px}
  .timer-btns{display:flex;gap:.4rem;flex:1;flex-wrap:wrap}
  .tbtn{background:var(--surface);border:1px solid var(--border-glow);color:var(--text);padding:.3rem .6rem;border-radius:7px;cursor:pointer;font-size:.78rem;font-weight:600;font-family:'Inter',sans-serif;transition:all .15s;white-space:nowrap}
  .tbtn:hover{border-color:var(--iris);color:var(--iris);box-shadow:0 0 8px #b09dff33}

  /* ── my-team label (team view) ── */
  .my-team-label{display:flex;align-items:center;justify-content:space-between;background:var(--surface2);border:1px solid #00f0ff33;border-radius:9px;padding:.5rem .85rem}
  .mtl-name{font-weight:700;font-size:.9rem;color:#00f0ff}
  .mtl-budget{font-size:.8rem;color:#ffe040;font-weight:600}

  /* ── waiting msg ── */
  .waiting-msg{text-align:center;color:var(--muted);font-size:.82rem;padding:.6rem;font-style:italic}


  /* ── firebase config panel ── */
  .hs-firebase-toggle{display:flex;align-items:center;gap:.75rem;flex-wrap:wrap}
  .sync-live-badge{font-size:.72rem;font-weight:700;padding:.2rem .6rem;border-radius:10px;letter-spacing:1px}
  .sync-live-badge{background:#041a10;color:#00ff88;border:1px solid #00ff8844}
  .sync-connecting{background:#1a1000;color:var(--accel);border-color:#ffaa0044}
  .sync-error{background:#1a0808;color:var(--red);border-color:#ff557744}
  .fb-config-panel{background:var(--surface2);border:1px solid var(--border);border-radius:12px;padding:1rem;display:flex;flex-direction:column;gap:.85rem}
  .fb-info{font-size:.75rem;color:var(--muted);line-height:1.6;padding:.5rem .75rem;background:var(--border);border-radius:8px}
  .fb-link{color:var(--cyan);text-decoration:none;font-weight:600}
  .fb-link:hover{text-decoration:underline}
  .fb-ready{font-size:.78rem;color:#00ff88;background:#041a10;border:1px solid #00ff8833;padding:.45rem .75rem;border-radius:8px}
  .fb-warn{font-size:.78rem;color:var(--accel);background:#1a1000;border:1px solid #ffaa0033;padding:.45rem .75rem;border-radius:8px}
  .room-code-wrap{display:flex;gap:.4rem;align-items:center}
  .room-code-inp{font-family:'Syne',sans-serif!important;font-size:1rem!important;font-weight:700!important;letter-spacing:3px!important;text-transform:uppercase}

  /* ── sync badge in topbar ── */
  .sync-badge{font-size:.65rem;font-weight:700;padding:.2rem .55rem;border-radius:10px}
  .sync-live{background:#041a10;color:#00ff88;border:1px solid #00ff8833;box-shadow:0 0 8px #00ff8822}
  .sync-connecting{background:#1a1000;color:var(--accel)}
  .sync-error{background:#1a0808;color:var(--red)}

  /* ── join hint ── */
  .join-hint{font-size:.72rem;color:var(--muted);text-align:center;line-height:1.5;padding:.25rem}

  /* ── per-set timer selector ── */
  .inc-timer-sel{width:auto!important;padding:.28rem .5rem!important;font-size:.76rem!important;flex:1;min-width:100px}

  /* ── discord chip ── */
  .discord-chip{background:#1a1a3e;color:#5865F2;border:1px solid #5865F233}

  /* ── discord login ── */
  .discord-opt{border-color:#5865F233!important}
  .discord-opt:hover{border-color:#5865F2!important;box-shadow:0 0 20px #5865F233!important}
  .discord-icon{display:flex;align-items:center;justify-content:center}
  .opt-text{display:flex;flex-direction:column;gap:.1rem;flex:1}
  .discord-header{display:flex;align-items:center;gap:.6rem;margin-bottom:.25rem}
  .discord-header-text{font-family:'Syne',sans-serif;font-size:1rem;font-weight:700;color:#5865F2}
  .discord-btn{background:linear-gradient(135deg,#4752C4,#5865F2)!important;box-shadow:0 0 16px #5865F244!important}
  .discord-btn:hover{box-shadow:0 0 24px #5865F266!important}

  /* ── login opt text layout ── */
  .login-opt{display:flex;align-items:center;gap:.85rem}
  .login-opt .opt-label{font-weight:700;font-size:.95rem;color:var(--text)}
  .login-opt .opt-desc{font-size:.72rem;color:var(--muted)}

  /* ── help button ── */
  .help-btn{
    width:28px;height:28px;border-radius:50%;
    background:var(--surface2);border:1px solid var(--border-glow);
    color:var(--iris);font-weight:700;font-size:.9rem;
    cursor:pointer;display:flex;align-items:center;justify-content:center;
    transition:all .2s;flex-shrink:0;font-family:'Syne',sans-serif;
    box-shadow:0 0 8px #b09dff22;
  }
  .help-btn:hover{background:var(--iris);color:#fff;box-shadow:0 0 14px #b09dff55;border-color:var(--iris)}

  /* ── help modal overlay ── */
  .help-overlay{
    position:fixed;inset:0;background:rgba(0,0,0,.8);
    display:flex;align-items:center;justify-content:center;
    z-index:200;backdrop-filter:blur(8px);padding:1rem;
  }
  .help-modal{
    background:var(--surface);border:1px solid var(--border-glow);border-radius:20px;
    width:100%;max-width:620px;max-height:88vh;
    display:flex;flex-direction:column;overflow:hidden;
    position:relative;box-shadow:0 0 60px #b09dff11;
  }
  .help-modal::before{
    content:'';position:absolute;top:0;left:0;right:0;height:1px;
    background:linear-gradient(90deg,transparent,#b09dff66,#00f0ff55,transparent);
  }
  .help-close{
    position:absolute;top:.85rem;right:.85rem;
    background:var(--surface2);border:1px solid var(--border);
    color:var(--muted);width:28px;height:28px;border-radius:50%;
    cursor:pointer;font-size:.8rem;display:flex;align-items:center;justify-content:center;
    transition:all .15s;z-index:10;
  }
  .help-close:hover{color:var(--red);border-color:var(--red)}

  /* ── help header ── */
  .help-header{
    padding:1.5rem 1.5rem 0;display:flex;flex-direction:column;gap:.85rem;flex-shrink:0;
  }
  .help-title{
    font-family:'Syne',sans-serif;font-size:1.2rem;font-weight:800;
    background:linear-gradient(135deg,#fff,#c890ff,#00f0ff);
    -webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;
    padding-right:2rem;
  }
  .help-tabs{display:flex;gap:.4rem;padding-bottom:1rem;border-bottom:1px solid var(--border)}
  .help-tab{
    background:transparent;border:1px solid var(--border);color:var(--muted);
    padding:.4rem 1rem;border-radius:8px;cursor:pointer;
    font-size:.82rem;font-family:'Inter',sans-serif;font-weight:600;transition:all .2s;
  }
  .help-tab:hover{border-color:var(--border-glow);color:var(--text)}
  .help-tab-on{
    background:linear-gradient(135deg,#7c5bff,#c040ff);
    border-color:transparent!important;color:#fff!important;
    box-shadow:0 0 14px #a040ff44;
  }

  /* ── help body ── */
  .help-body{
    padding:1.25rem 1.5rem 1.5rem;overflow-y:auto;display:flex;flex-direction:column;gap:1.25rem;
  }
  .help-section{display:flex;flex-direction:column;gap:.6rem}
  .help-section-title{
    display:flex;align-items:center;gap:.5rem;
    font-family:'Syne',sans-serif;font-size:.92rem;font-weight:700;color:var(--text);
  }
  .help-section-icon{font-size:1.1rem;flex-shrink:0}
  .help-list{
    list-style:none;display:flex;flex-direction:column;gap:.4rem;
    padding-left:.25rem;
  }
  .help-item{
    font-size:.82rem;color:var(--muted);line-height:1.55;
    padding-left:1.1rem;position:relative;
  }
  .help-item::before{
    content:'›';position:absolute;left:0;color:var(--iris);font-weight:700;
  }

  /* ── save progress button ── */
  .btn-save-session{background:transparent;color:#00ff88;border:1px solid #00ff8844;padding:.4rem 1.1rem;border-radius:8px;font-size:.78rem;font-weight:600;cursor:pointer;font-family:'Inter',sans-serif;transition:all .15s;box-shadow:0 0 8px #00ff8811}
  .btn-save-session:hover{border-color:#00ff88;box-shadow:0 0 16px #00ff8833;background:#041a10}
  .save-confirm-btn{background:#062a14!important;color:#00ff88!important;border-color:#00ff8844!important}
  .save-confirm-btn:hover{background:#083a1a!important;border-color:#00ff88!important}
  .save-confirm-msg{font-size:.78rem;color:#00ff88;font-weight:600;text-shadow:0 0 8px #00ff8855}

  /* ── saves on login ── */
  .saves-section{width:100%;display:flex;flex-direction:column;gap:.45rem}
  .saves-title{font-size:.68rem;font-weight:700;color:var(--muted);letter-spacing:1.5px;text-transform:uppercase;padding:.5rem 0 .2rem;border-top:1px solid var(--border)}
  .save-row{background:var(--surface2);border:1px solid var(--border-glow);border-radius:10px;padding:.6rem .85rem;display:flex;align-items:center;gap:.6rem;transition:border-color .2s}
  .save-row:hover{border-color:var(--iris)}
  .save-info{display:flex;flex-direction:column;gap:.12rem;flex:1;min-width:0}
  .save-name{font-weight:600;font-size:.85rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .save-meta{font-size:.68rem;color:var(--muted)}
  .save-row-btns{display:flex;gap:.35rem;flex-shrink:0}
  .btn-save-resume{background:linear-gradient(135deg,#7c5bff,#c040ff);color:#fff;border:none;padding:.35rem .8rem;border-radius:7px;font-weight:600;font-size:.78rem;cursor:pointer;font-family:'Inter',sans-serif;white-space:nowrap;transition:opacity .15s;box-shadow:0 0 10px #9d6aff33}
  .btn-save-resume:hover{opacity:.85}
  .btn-save-delete{background:transparent;border:1px solid var(--border);color:var(--muted);padding:.35rem .5rem;border-radius:7px;cursor:pointer;font-size:.72rem;transition:all .15s}
  .btn-save-delete:hover{border-color:var(--red);color:var(--red)}

  /* ── results save bar ── */
  .results-save-bar{background:var(--surface);border:1px solid var(--border-glow);border-radius:12px;padding:.85rem 1rem;display:flex;align-items:center;gap:.6rem;flex-wrap:wrap;position:relative;overflow:hidden}
  .results-save-bar::before{content:'';position:absolute;top:0;left:0;right:0;height:1px;background:linear-gradient(90deg,transparent,#00ff8844,#b09dff33,transparent)}
  .results-save-label{font-size:.8rem;font-weight:600;color:#00ff88;white-space:nowrap}
  .results-save-inp{flex:1;min-width:160px}

  /* ── confetti (150 pieces, big) ── */
  .confetti-layer{position:fixed;inset:0;pointer-events:none;z-index:999;overflow:hidden}
  .confetti-piece{position:absolute}
  @keyframes confetti-fall{
    0%{transform:translateY(-5vh) rotate(0deg) scale(1);opacity:1}
    80%{opacity:1}
    100%{transform:translateY(110vh) rotate(900deg) scale(.5);opacity:0}
  }

  /* ── SOLD spectacle ── */
  .sold-flash-overlay{
    position:fixed;inset:0;display:flex;align-items:center;justify-content:center;
    z-index:998;pointer-events:none;background:rgba(0,0,0,0);
    animation:sold-overlay-fade 2.5s ease-in-out forwards;
  }
  @keyframes sold-overlay-fade{0%{background:rgba(0,20,0,.6)}60%{background:rgba(0,20,0,.4)}100%{background:rgba(0,0,0,0)}}
  .sold-spotlight{
    position:absolute;inset:0;
    background:radial-gradient(ellipse 60% 50% at 50% 40%,rgba(0,255,136,.18),transparent 70%);
    animation:spotlight-pulse 2.5s ease-out forwards;
  }
  @keyframes spotlight-pulse{0%{opacity:0}20%{opacity:1}80%{opacity:1}100%{opacity:0}}
  .sold-flash-content{
    display:flex;flex-direction:column;align-items:center;gap:.5rem;
    animation:sold-pop 0.45s cubic-bezier(.17,.67,.41,1.4) forwards;
    position:relative;
  }
  .sold-flash-gavel{font-size:4rem;animation:gavel-swing .3s ease-out 0.1s both;filter:drop-shadow(0 0 20px #ffe04088)}
  @keyframes gavel-swing{0%{transform:rotate(-40deg) scale(1.2)}100%{transform:rotate(0deg) scale(1)}}
  .sold-flash-text{
    font-family:'Syne',sans-serif;font-size:5rem;font-weight:800;line-height:1;
    background:linear-gradient(135deg,#ffe040,#00ff88,#b09dff,#00f0ff);
    -webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;
    filter:drop-shadow(0 0 40px #ffe04066);
  }
  .sold-flash-detail{
    text-align:center;font-size:1.1rem;color:#e2e8f0;
    background:rgba(0,0,0,.5);padding:.4rem 1rem;border-radius:10px;
    border:1px solid rgba(255,224,64,.3);
    animation:sold-detail-enter .3s ease-out .3s both;
  }
  @keyframes sold-detail-enter{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
  @keyframes sold-pop{from{transform:scale(0.2) translateY(30px);opacity:0}to{transform:scale(1) translateY(0);opacity:1}}
  .sold-flash-bg{animation:flash-bg .6s ease-out}
  @keyframes flash-bg{0%{background:#0a2a1a}40%{background:#071a10}100%{background:var(--bg)}}

  /* ── reactions ── */
  .reactions-layer{position:fixed;bottom:60px;left:0;right:0;pointer-events:none;z-index:997;overflow:hidden;height:50vh}
  .reaction-float{
    position:absolute;bottom:0;font-size:2.5rem;
    animation:reaction-rise 2.8s ease-out forwards;
    filter:drop-shadow(0 0 12px rgba(255,255,255,.4));
  }
  @keyframes reaction-rise{
    0%{transform:translateY(0) scale(.8);opacity:0}
    10%{opacity:1;transform:translateY(-10px) scale(1.2)}
    70%{opacity:1}
    100%{transform:translateY(-45vh) scale(1.6);opacity:0}
  }
  .reaction-bar{display:flex;gap:.3rem;flex-wrap:wrap;padding:.4rem 0 0;border-top:1px solid var(--border)}
  .reaction-btn{
    background:var(--surface2);border:1px solid var(--border);
    font-size:1.2rem;padding:.22rem .38rem;border-radius:8px;cursor:pointer;
    transition:transform .12s,border-color .15s,box-shadow .15s;line-height:1;
  }
  .reaction-btn:hover{transform:scale(1.3);border-color:var(--border-glow);box-shadow:0 0 10px #ffffff22}
  .reaction-btn:active{transform:scale(.85)}

  /* ── leaderboard toggle ── */
  .leaderboard-toggle{
    background:linear-gradient(135deg,#1a1206,#0e0a00);
    border:1px solid #ffe04044;color:#ffe040;
    padding:.35rem .7rem;border-radius:8px;cursor:pointer;
    font-size:.73rem;font-weight:700;font-family:'Inter',sans-serif;
    transition:all .2s;width:100%;margin-bottom:.35rem;
    box-shadow:0 0 8px #ffe04011;
  }
  .leaderboard-toggle:hover{border-color:#ffe040;box-shadow:0 0 16px #ffe04033}

  /* ── leaderboard modal ── */
  .lb-modal{
    background:var(--surface);border:1px solid var(--border-glow);border-radius:20px;
    padding:1.75rem 1.5rem 1.5rem;width:100%;max-width:480px;
    display:flex;flex-direction:column;gap:1rem;position:relative;overflow:hidden;
    box-shadow:0 0 60px #ffe04011;
  }
  .lb-modal::before{content:'';position:absolute;top:0;left:0;right:0;height:1px;background:linear-gradient(90deg,transparent,#ffe04077,#b09dff55,transparent)}
  .lb-modal-glow{position:absolute;top:-60px;left:50%;transform:translateX(-50%);width:300px;height:200px;border-radius:50%;background:radial-gradient(#ffe04015,transparent 70%);pointer-events:none}
  .lb-modal-title{font-family:'Syne',sans-serif;font-size:1.35rem;font-weight:800;color:var(--text)}
  .lb-modal-sub{font-size:.78rem;color:var(--muted)}
  .lb-modal-row{display:flex;align-items:center;gap:.75rem;padding:.65rem .6rem;border-radius:10px;background:var(--surface2);border:1px solid var(--border)}
  .lb-modal-info{flex:1;min-width:0;display:flex;flex-direction:column;gap:.35rem}
  .lb-modal-name-row{display:flex;align-items:center;justify-content:space-between}
  .lb-modal-name{font-weight:600;font-size:.88rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .lb-modal-rank{font-size:.7rem;color:var(--muted);font-weight:600;flex-shrink:0}
  .lb-modal-bar-wrap{height:6px;background:var(--border);border-radius:3px;overflow:hidden;position:relative}
  .lb-modal-bar{height:100%;border-radius:3px;transition:width .6s ease}
  .lb-bar-spent{background:linear-gradient(90deg,#b09dff,#c040ff);box-shadow:0 0 6px #c040ff44}
  .lb-bar-left{background:linear-gradient(90deg,#00ff8855,#00ff8822)}
  .lb-modal-legend{display:flex;justify-content:space-between;font-size:.7rem}
  .lb-legend-spent{color:#b09dff;font-weight:600}
  .lb-legend-left{color:#00ff88;font-weight:600}

  /* ── bid flash ── */
  .bid-board-flash{border-color:#c040ff !important;box-shadow:0 0 40px #c040ff66,0 0 80px #c040ff22 !important}

  /* ── right panel tabs ── */
  .right-tabs{display:flex;gap:.3rem;margin-bottom:.5rem;flex-shrink:0}
  .right-tab{flex:1;background:transparent;border:1px solid var(--border);color:var(--muted);padding:.3rem .4rem;border-radius:7px;cursor:pointer;font-size:.72rem;font-weight:600;font-family:'Inter',sans-serif;transition:all .15s;text-align:center}
  .right-tab:hover{border-color:var(--border-glow);color:var(--text)}
  .right-tab-on{background:linear-gradient(135deg,#7c5bff,#c040ff);border-color:transparent!important;color:#fff!important;box-shadow:0 0 10px #a040ff44}
  .chat-badge{background:#ff40aa;color:#fff;font-size:.6rem;padding:0 4px;border-radius:8px;margin-left:.3rem;font-weight:700}

  /* ── chat panel ── */
  .chat-panel{display:flex;flex-direction:column;flex:1;min-height:0;gap:.5rem}
  .chat-messages{flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:.3rem;max-height:340px}
  .chat-msg{padding:.3rem .45rem;border-radius:8px;font-size:.76rem;line-height:1.4}
  .chat-bid{background:#0a1020;color:var(--muted);border-left:2px solid var(--iris);padding-left:.5rem}
  .chat-user{background:var(--surface2);border:1px solid var(--border)}
  .chat-name{font-weight:700;color:var(--iris);margin-right:.4rem;font-size:.7rem;display:block}
  .chat-text{color:var(--text)}
  .chat-input-row{display:flex;gap:.35rem;flex-shrink:0}
  .chat-inp{flex:1;font-size:.8rem!important;padding:.4rem .6rem!important}
  .chat-send-btn{background:linear-gradient(135deg,#7c5bff,#c040ff);color:#fff;border:none;padding:.4rem .7rem;border-radius:8px;cursor:pointer;font-weight:700;font-size:.9rem;transition:opacity .15s;flex-shrink:0}
  .chat-send-btn:hover{opacity:.85}

  /* ── commentary chat messages ── */
  .chat-commentary{
    background:linear-gradient(135deg,#1a0a2e,#0e0a1a);
    border:1px solid #b09dff33;border-left:3px solid #b09dff;
    color:#d0c0ff;font-style:italic;
    animation:commentary-appear .3s ease-out;
  }
  @keyframes commentary-appear{from{opacity:0;transform:translateX(-6px)}to{opacity:1;transform:none}}

  /* ── commentary edit button ── */
  .commentary-edit-btn{color:var(--violet)!important;border-color:#d580ff33!important}
  .commentary-edit-btn:hover{border-color:var(--violet)!important;color:var(--violet)!important}

  /* ── commentary editor modal ── */
  .commentary-modal{
    background:var(--surface);border:1px solid var(--border-glow);border-radius:18px;
    padding:1.75rem 1.5rem 1.5rem;width:100%;max-width:560px;max-height:88vh;
    display:flex;flex-direction:column;gap:.85rem;overflow:hidden;position:relative;
  }
  .commentary-modal::before{content:'';position:absolute;top:0;left:0;right:0;height:1px;background:linear-gradient(90deg,transparent,#d580ff66,#b09dff55,transparent)}
  .commentary-modal-title{font-family:'Syne',sans-serif;font-size:1.2rem;font-weight:800;color:var(--text);padding-right:2rem}
  .commentary-modal-sub{font-size:.75rem;color:var(--muted);line-height:1.5}
  .commentary-modal-sub code{background:var(--border);padding:1px 5px;border-radius:4px;color:var(--cyan);font-size:.7rem}
  .commentary-cats{display:flex;gap:.35rem;flex-wrap:wrap}
  .commentary-cat-btn{background:var(--surface2);border:1px solid var(--border);color:var(--muted);padding:.28rem .7rem;border-radius:20px;cursor:pointer;font-size:.72rem;font-weight:600;font-family:'Inter',sans-serif;transition:all .15s;text-transform:capitalize}
  .commentary-cat-btn:hover{border-color:var(--iris);color:var(--iris)}
  .commentary-cat-on{background:linear-gradient(135deg,#7c5bff,#c040ff);border-color:transparent!important;color:#fff!important;box-shadow:0 0 8px #a040ff44}
  .commentary-edit-area{display:flex;flex-direction:column;gap:.35rem;flex:1;min-height:0}
  .commentary-edit-label{font-size:.68rem;color:var(--muted);letter-spacing:.5px}
  .commentary-textarea{
    background:var(--surface2);border:1px solid var(--border);color:var(--text);
    padding:.65rem .75rem;border-radius:10px;font-size:.82rem;font-family:'Inter',sans-serif;
    outline:none;resize:none;flex:1;min-height:200px;line-height:1.6;
    transition:border-color .2s;
  }
  .commentary-textarea:focus{border-color:var(--iris)}
  .commentary-modal-btns{display:flex;justify-content:space-between;align-items:center;gap:.6rem;padding-top:.25rem;border-top:1px solid var(--border)}


  /* ── team colour picker ── */
  .color-picker-row{display:flex;flex-direction:column;gap:.4rem}
  .color-picker-label{font-size:.72rem;font-weight:600;color:var(--muted);letter-spacing:.5px;text-transform:uppercase}
  .color-swatches{display:flex;gap:.4rem;flex-wrap:wrap;align-items:center}
  .color-swatch{width:22px;height:22px;border-radius:50%;border:2px solid transparent;cursor:pointer;transition:transform .15s,box-shadow .15s;flex-shrink:0;padding:0}
  .color-swatch:hover{transform:scale(1.2)}
  .swatch-active{transform:scale(1.15)}
  .color-custom-inp{width:28px;height:28px;border-radius:50%;border:2px solid var(--border);cursor:pointer;padding:0;background:none;overflow:hidden;flex-shrink:0}
  .color-custom-inp::-webkit-color-swatch-wrapper{padding:0}
  .color-custom-inp::-webkit-color-swatch{border:none;border-radius:50%}

  /* ── team colour dot in setup list ── */
  .team-color-dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:.45rem;flex-shrink:0;vertical-align:middle}

  /* ── fcard colour bar ── */
  .fcard-color-bar{height:3px;border-radius:0 0 0 0;margin:-0px -0px 6px;border-radius:4px 4px 0 0;opacity:.9}
  ::-webkit-scrollbar{width:4px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:var(--border-glow);border-radius:2px}
`;

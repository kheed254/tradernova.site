<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>TraderNova</title>
    <script src="https://unpkg.com/react@18/umd/react.development.js"></script>
    <script src="https://unpkg.com/react-dom@18/umd/react-dom.development.js"></script>
    <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
  </head>
  <body style="margin:0;padding:0;background:#080f1e;">
    <div id="root"></div>
    <script type="text/babel">
      const { useState, useEffect, useRef, useCallback } = React;

      const PUBLIC_WS_URL = "wss://api.derivws.com/trading/v1/options/ws/public";
      const AUTH_URL      = "https://auth.deriv.com/oauth2/auth";
      const TOKEN_URL     = "https://auth.deriv.com/oauth2/token";
      const API_BASE      = "https://api.derivws.com/trading/v1/options";
      const OAUTH_CLIENT_ID    = "YOUR_CLIENT_ID";
      const OAUTH_REDIRECT_URI = window.location.origin + window.location.pathname;

      function useWebSocket(url, { onMessage, onOpen, onClose, onError } = {}) {
        const wsRef  = useRef(null);
        const cbsRef = useRef({ onMessage, onOpen, onClose, onError });
        useEffect(() => { cbsRef.current = { onMessage, onOpen, onClose, onError }; });

        const connect = useCallback((wsUrl) => {
          if (wsRef.current) wsRef.current.close();
          const ws = new WebSocket(wsUrl || url);
          wsRef.current = ws;
          ws.onopen    = (e) => cbsRef.current.onOpen?.(e);
          ws.onclose   = (e) => cbsRef.current.onClose?.(e);
          ws.onerror   = (e) => cbsRef.current.onError?.(e);
          ws.onmessage = (e) => { try { cbsRef.current.onMessage?.(JSON.parse(e.data)); } catch {} };
          return ws;
        }, [url]);

        const send = useCallback((data) => {
          if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify(data));
          }
        }, []);

        const disconnect = useCallback(() => {
          wsRef.current?.close();
          wsRef.current = null;
        }, []);

        useEffect(() => () => wsRef.current?.close(), []);
        return { connect, send, disconnect, ws: wsRef };
      }

      function fmt(n, d = 5) {
        if (n == null) return "—";
        return Number(n).toFixed(d);
      }

      function fmtMoney(n) {
        if (n == null) return "—";
        return Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      }

      function getOAuthCode() {
        const p = new URLSearchParams(window.location.search);
        return p.get("code");
      }

      function redirectToOAuth() {
        const params = new URLSearchParams({
          response_type: "code",
          client_id:     OAUTH_CLIENT_ID,
          redirect_uri:  OAUTH_REDIRECT_URI,
          scope:         "read trade",
        });
        window.location.href = `${AUTH_URL}?${params}`;
      }

      async function exchangeCode(code) {
        const res = await fetch(TOKEN_URL, {
          method:  "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body:    new URLSearchParams({
            grant_type:   "authorization_code",
            code,
            redirect_uri: OAUTH_REDIRECT_URI,
            client_id:    OAUTH_CLIENT_ID,
          }),
        });
        if (!res.ok) throw new Error("Token exchange failed");
        return res.json();
      }

      async function fetchOTP(accountId, accessToken) {
        const res = await fetch(`${API_BASE}/accounts/${accountId}/otp`, {
          method:  "POST",
          headers: {
            "Content-Type":  "application/json",
            "Authorization": `Bearer ${accessToken}`,
          },
        });
        if (!res.ok) throw new Error("OTP fetch failed");
        return res.json();
      }

      function Sparkline({ ticks = [], color = "#22d3ee" }) {
        if (ticks.length < 2) return <div style={{ height: 32 }} />;
        const min = Math.min(...ticks);
        const max = Math.max(...ticks);
        const range = max - min || 1;
        const w = 120, h = 32;
        const pts = ticks.map((v, i) => {
          const x = (i / (ticks.length - 1)) * w;
          const y = h - ((v - min) / range) * h;
          return `${x},${y}`;
        }).join(" ");
        return (
          <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ display: "block" }}>
            <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" />
          </svg>
        );
      }

      function DBTraders() {
        const [authState, setAuthState] = useState("idle");
        const [authError, setAuthError] = useState(null);
        const [account, setAccount]     = useState(null);
        const [symbols, setSymbols]     = useState([]);
        const [selectedSymbol, setSelectedSymbol] = useState(null);
        const [contracts, setContracts] = useState([]);
        const [selectedContract, setSelectedContract] = useState(null);
        const [ticks, setTicks]         = useState({});
        const [pubStatus, setPubStatus] = useState("disconnected");
        const [stake, setStake]         = useState("10");
        const [duration, setDuration]   = useState("5");
        const [durationUnit, setDurationUnit] = useState("t");
        const [proposal, setProposal]   = useState(null);
        const [proposalLoading, setProposalLoading] = useState(false);
        const [buyResult, setBuyResult] = useState(null);
        const [buyLoading, setBuyLoading] = useState(false);
        const [balance, setBalance]     = useState(null);
        const [portfolio, setPortfolio] = useState([]);
        const [tab, setTab]             = useState("market");
        const [toast, setToast]         = useState(null);
        const proposalIdRef = useRef(null);

        const pubWs = useWebSocket(PUBLIC_WS_URL, {
          onOpen: () => {
            setPubStatus("connected");
            pubWs.send({ active_symbols: "brief", product_type: "basic" });
          },
          onClose: () => setPubStatus("disconnected"),
          onError: () => setPubStatus("error"),
          onMessage: (msg) => {
            if (msg.msg_type === "active_symbols") {
              const syms = (msg.active_symbols || []).filter(s => s.is_trading_suspended === 0);
              setSymbols(syms);
              if (!selectedSymbol && syms.length) setSelectedSymbol(syms[0].symbol);
            }
            if (msg.msg_type === "contracts_for" || msg.msg_type === "contracts_list") {
              const list = msg.contracts_for?.available || msg.contracts_list || [];
              setContracts(list);
              if (!selectedContract && list.length) setSelectedContract(list[0]);
            }
            if (msg.msg_type === "tick") {
              const { symbol, quote } = msg.tick || {};
              if (symbol && quote) {
                setTicks(prev => {
                  const arr = [...(prev[symbol] || []), quote].slice(-60);
                  return { ...prev, [symbol]: arr };
                });
              }
            }
          },
        });

        const authWs = useWebSocket(null, {
          onOpen: () => {
            authWs.send({ balance: 1, subscribe: 1 });
            authWs.send({ portfolio: 1 });
          },
          onMessage: (msg) => {
            if (msg.msg_type === "balance")   setBalance(msg.balance);
            if (msg.msg_type === "portfolio") setPortfolio(msg.portfolio?.contracts || []);
            if (msg.msg_type === "proposal") {
              setProposal(msg.proposal);
              proposalIdRef.current = msg.proposal?.id;
              setProposalLoading(false);
            }
            if (msg.msg_type === "buy") {
              setBuyResult(msg.buy);
              setBuyLoading(false);
              showToast(msg.error ? `Buy failed: ${msg.error.message}` : `✓ Contract purchased — ID ${msg.buy?.contract_id}`, !msg.error);
              authWs.send({ balance: 1, subscribe: 1 });
              authWs.send({ portfolio: 1 });
            }
            if (msg.error) {
              showToast(`Error: ${msg.error.message}`, false);
              setProposalLoading(false);
              setBuyLoading(false);
            }
          },
        });

        useEffect(() => { pubWs.connect(PUBLIC_WS_URL); }, []);

        useEffect(() => {
          const code = getOAuthCode();
          if (code) {
            setAuthState("loading");
            window.history.replaceState({}, "", window.location.pathname);
            exchangeCode(code)
              .then(async (data) => {
                const { access_token, account_id } = data;
                setAccount({ access_token, account_id });
                const otp = await fetchOTP(account_id, access_token);
                setAuthState("authed");
                return otp.ws_url;
              })
              .then((wsUrl) => authWs.connect(wsUrl))
              .catch((e) => { setAuthState("error"); setAuthError(e.message); });
          }
        }, []);

        useEffect(() => {
          if (!selectedSymbol || pubStatus !== "connected") return;
          pubWs.send({ ticks: selectedSymbol, subscribe: 1 });
          pubWs.send({ contracts_for: selectedSymbol, currency: "USD", product_type: "basic" });
        }, [selectedSymbol, pubStatus]);

        const requestProposal = () => {
          if (!selectedSymbol || !selectedContract) return;
          setProposalLoading(true);
          setProposal(null);
          authWs.send({
            proposal: 1,
            amount: parseFloat(stake) || 10,
            basis: "stake",
            contract_type: selectedContract.contract_type,
            currency: "USD",
            duration: parseInt(duration) || 5,
            duration_unit: durationUnit,
            symbol: selectedSymbol,
          });
        };

        const buyContract = () => {
          if (!proposalIdRef.current) return;
          setBuyLoading(true);
          authWs.send({ buy: proposalIdRef.current, price: parseFloat(proposal?.ask_price || stake) });
        };

        const showToast = (msg, ok = true) => {
          setToast({ msg, ok });
          setTimeout(() => setToast(null), 4000);
        };

        const currentTick = selectedSymbol && ticks[selectedSymbol] ? ticks[selectedSymbol].slice(-1)[0] : null;
        const prevTick    = selectedSymbol && ticks[selectedSymbol]?.length > 1 ? ticks[selectedSymbol].slice(-2)[0] : null;
        const tickUp      = currentTick != null && prevTick != null && currentTick > prevTick;
        const tickDown    = currentTick != null && prevTick != null && currentTick < prevTick;

        const s = {
          app: { display:"flex", height:"100vh", background:"#080f1e", fontFamily:"'Inter','Segoe UI',system-ui,sans-serif", color:"#f1f5f9", overflow:"hidden" },
          sidebar: { width:220, background:"#060d1a", borderRight:"1px solid #0f172a", display:"flex", flexDirection:"column", padding:"24px 0 16px", flexShrink:0 },
          logo: { display:"flex", alignItems:"center", gap:10, padding:"0 20px 28px", borderBottom:"1px solid #0f172a" },
          logoMark: { background:"#22d3ee", color:"#060d1a", fontWeight:900, fontSize:14, borderRadius:6, padding:"3px 7px" },
          logoText: { fontSize:16, fontWeight:700, color:"#f1f5f9" },
          sideNav: { display:"flex", flexDirection:"column", gap:2, padding:"20px 0", flex:1 },
          accountPanel: { padding:"16px", borderTop:"1px solid #0f172a", display:"flex", flexDirection:"column", gap:8 },
          dot: { width:7, height:7, borderRadius:"50%", background:"#22c55e", display:"inline-block" },
          balanceDisplay: { display:"flex", flexDirection:"column", gap:2, background:"#0a1628", borderRadius:8, padding:"10px 12px", border:"1px solid #1e293b" },
          loginBtn: { background:"#22d3ee", color:"#060d1a", border:"none", borderRadius:8, padding:"10px 14px", fontSize:13, fontWeight:700, cursor:"pointer", width:"100%" },
          wsStatus: { display:"flex", alignItems:"center", gap:6, padding:"10px 20px 0" },
          main: { flex:1, overflow:"auto", background:"#080f1e" },
          tabContent: { padding:"32px", maxWidth:1100 },
          tabTitle: { fontSize:22, fontWeight:700, color:"#f1f5f9", margin:"0 0 24px", letterSpacing:-0.5 },
          symbolGrid: { display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(200px,1fr))", gap:12 },
          symbolCard: { borderRadius:10, padding:"14px 14px 10px", cursor:"pointer", display:"flex", flexDirection:"column", gap:8 },
          tradeLayout: { display:"grid", gridTemplateColumns:"1fr 1fr", gap:24, alignItems:"start" },
          tradePanel: { background:"#0d1526", border:"1px solid #1e293b", borderRadius:12, padding:24, display:"flex", flexDirection:"column", gap:16 },
          proposalPanel: { display:"flex", flexDirection:"column", gap:16 },
          livePriceBox: { background:"#080f1e", border:"1px solid #1e293b", borderRadius:8, padding:"12px 14px", display:"flex", flexDirection:"column", gap:4 },
          fieldLabel: { fontSize:11, fontWeight:600, color:"#64748b", letterSpacing:1, textTransform:"uppercase", display:"block", marginBottom:-8 },
          select: { background:"#0a1628", border:"1px solid #1e293b", borderRadius:8, color:"#f1f5f9", padding:"9px 12px", fontSize:14, width:"100%", outline:"none", cursor:"pointer" },
          input: { background:"#0a1628", border:"1px solid #1e293b", borderRadius:8, color:"#f1f5f9", padding:"9px 12px", fontSize:14, width:"100%", outline:"none", boxSizing:"border-box" },
          row2: { display:"flex", gap:12 },
          primaryBtn: { background:"#22d3ee", color:"#060d1a", border:"none", borderRadius:8, padding:11, fontSize:14, fontWeight:700, cursor:"pointer", width:"100%" },
          buyBtn: { background:"#22c55e", color:"#052e16", border:"none", borderRadius:8, padding:13, fontSize:15, fontWeight:800, cursor:"pointer", width:"100%", marginTop:8 },
          proposalCard: { background:"#0d1526", border:"1px solid #1e293b", borderRadius:12, padding:20, display:"flex", flexDirection:"column", gap:14 },
          proposalRow: { display:"flex", justifyContent:"space-between", alignItems:"flex-start", borderBottom:"1px solid #0f172a", paddingBottom:12 },
          propLabel: { color:"#64748b", fontSize:12, fontWeight:600 },
          propValue: { color:"#f1f5f9", fontFamily:"monospace", fontSize:15, fontWeight:700 },
          emptyProposal: { background:"#0d1526", border:"1px dashed #1e293b", borderRadius:12, padding:"40px 20px", textAlign:"center", minHeight:200, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center" },
          buyResultCard: { background:"#052e16", border:"1px solid #22c55e", borderRadius:10, padding:"16px 20px", display:"flex", flexDirection:"column", gap:10 },
          portfolioTable: { border:"1px solid #1e293b", borderRadius:12, overflow:"hidden" },
          tableHeader: { display:"grid", gridTemplateColumns:"1fr 1fr 1fr 1fr 1fr", padding:"12px 20px", background:"#0a1628", fontSize:11, fontWeight:700, color:"#475569", letterSpacing:1, textTransform:"uppercase", borderBottom:"1px solid #1e293b" },
          tableRow: { display:"grid", gridTemplateColumns:"1fr 1fr 1fr 1fr 1fr", padding:"14px 20px", fontSize:13, color:"#94a3b8", borderBottom:"1px solid #0f172a", alignItems:"center" },
          authPrompt: { background:"#0d1526", border:"1px solid #1e293b", borderRadius:12, padding:32, textAlign:"center", maxWidth:360 },
          emptyState: { textAlign:"center", padding:"80px 20px", color:"#475569" },
          toast: { position:"fixed", bottom:24, right:24, padding:"14px 20px", borderRadius:10, border:"1px solid", fontSize:13, fontWeight:600, maxWidth:360, zIndex:1000, boxShadow:"0 8px 32px rgba(0,0,0,0.5)" },
        };

        return (
          <div style={s.app}>
            <aside style={s.sidebar}>
              <div style={s.logo}>
                <span style={s.logoMark}>TN</span>
                <span style={s.logoText}>TraderNova</span>
              </div>
              <div style={s.sideNav}>
                {[
                  { key:"market",    label:"Markets",   icon:"◈" },
                  { key:"trade",     label:"Trade",     icon:"⚡" },
                  { key:"portfolio", label:"Portfolio", icon:"▤" },
                ].map(({ key, label, icon }) => (
                  <button key={key} onClick={() => setTab(key)} style={{
                    display:"flex", alignItems:"center", gap:12, padding:"10px 20px",
                    border:"none", borderLeft: tab===key ? "2px solid #22d3ee" : "2px solid transparent",
                    cursor:"pointer", fontSize:14, fontWeight:500, textAlign:"left", width:"100%",
                    background: tab===key ? "#0f172a" : "transparent",
                    color: tab===key ? "#22d3ee" : "#94a3b8",
                  }}>
                    <span style={{ fontSize:18, width:24 }}>{icon}</span>
                    <span>{label}</span>
                  </button>
                ))}
              </div>
              <div style={s.accountPanel}>
                {authState === "authed" ? (
                  <>
                    <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                      <span style={s.dot} />
                      <span style={{ color:"#94a3b8", fontSize:11 }}>Demo Account</span>
                    </div>
                    <div style={s.balanceDisplay}>
                      <span style={{ color:"#64748b", fontSize:11, letterSpacing:1 }}>BALANCE</span>
                      <span style={{ color:"#f1f5f9", fontSize:22, fontFamily:"monospace", fontWeight:700 }}>${fmtMoney(balance?.balance)}</span>
                      <span style={{ color:"#64748b", fontSize:11 }}>{balance?.currency || "USD"}</span>
                    </div>
                  </>
                ) : authState === "loading" ? (
                  <div style={{ color:"#64748b", fontSize:12, textAlign:"center" }}>Authenticating…</div>
                ) : authState === "error" ? (
                  <div style={{ color:"#f87171", fontSize:12 }}>{authError}</div>
                ) : (
                  <button style={s.loginBtn} onClick={redirectToOAuth}>Connect Demo Account</button>
                )}
              </div>
              <div style={s.wsStatus}>
                <span style={{ ...s.dot, background: pubStatus==="connected" ? "#22c55e" : "#ef4444" }} />
                <span style={{ color:"#475569", fontSize:10, letterSpacing:1 }}>MARKET {pubStatus.toUpperCase()}</span>
              </div>
            </aside>

            <main style={s.main}>
              {tab === "market" && (
                <div style={s.tabContent}>
                  <h2 style={s.tabTitle}>Live Markets</h2>
                  <div style={s.symbolGrid}>
                    {symbols.slice(0,30).map(sym => {
                      const symTicks = ticks[sym.symbol] || [];
                      const last = symTicks.slice(-1)[0];
                      const prev = symTicks.slice(-2)[0];
                      const up   = last != null && prev != null && last > prev;
                      const dn   = last != null && prev != null && last < prev;
                      const active = sym.symbol === selectedSymbol;
                      return (
                        <div key={sym.symbol} onClick={() => setSelectedSymbol(sym.symbol)} style={{
                          ...s.symbolCard,
                          border: active ? "1px solid #22d3ee" : "1px solid #1e293b",
                          background: active ? "#0f172a" : "#0d1526",
                        }}>
                          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start" }}>
                            <div>
                              <div style={{ color:"#f1f5f9", fontSize:13, fontWeight:600 }}>{sym.display_name}</div>
                              <div style={{ color:"#475569", fontSize:10, marginTop:2 }}>{sym.symbol}</div>
                            </div>
                            <div style={{ fontSize:14, fontFamily:"monospace", fontWeight:700, color: up?"#22c55e":dn?"#f87171":"#94a3b8", minWidth:80, textAlign:"right" }}>
                              {last != null ? fmt(last) : "—"}
                            </div>
                          </div>
                          <Sparkline ticks={symTicks} color={up?"#22c55e":dn?"#f87171":"#475569"} />
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {tab === "trade" && (
                <div style={s.tabContent}>
                  <h2 style={s.tabTitle}>Place a Trade</h2>
                  {authState !== "authed" && (
                    <div style={{ ...s.authPrompt, marginBottom:24 }}>
                      <p style={{ color:"#94a3b8", margin:"0 0 12px" }}>Connect your demo account to trade.</p>
                      <button style={s.loginBtn} onClick={redirectToOAuth}>Connect Demo Account</button>
                    </div>
                  )}
                  <div style={s.tradeLayout}>
                    <div style={s.tradePanel}>
                      <label style={s.fieldLabel}>Asset</label>
                      <select style={s.select} value={selectedSymbol || ""} onChange={e => setSelectedSymbol(e.target.value)}>
                        {symbols.map(s => <option key={s.symbol} value={s.symbol}>{s.display_name}</option>)}
                      </select>
                      <div style={s.livePriceBox}>
                        <span style={{ color:"#64748b", fontSize:11, letterSpacing:1 }}>LIVE PRICE</span>
                        <span style={{ fontSize:28, fontFamily:"monospace", fontWeight:800, color: tickUp?"#22c55e":tickDown?"#f87171":"#f1f5f9", transition:"color 0.3s" }}>
                          {currentTick != null ? fmt(currentTick) : "—"}
                        </span>
                        <Sparkline ticks={ticks[selectedSymbol] || []} color="#22d3ee" />
                      </div>
                      <label style={s.fieldLabel}>Contract Type</label>
                      <select style={s.select} value={selectedContract?.contract_type || ""}
                        onChange={e => { const c = contracts.find(x => x.contract_type === e.target.value); setSelectedContract(c || null); }}>
                        {contracts.map(c => <option key={c.contract_type} value={c.contract_type}>{c.contract_display_name || c.contract_type}</option>)}
                      </select>
                      <div style={s.row2}>
                        <div style={{ flex:1 }}>
                          <label style={s.fieldLabel}>Stake (USD)</label>
                          <input style={s.input} type="number" min="1" value={stake} onChange={e => setStake(e.target.value)} />
                        </div>
                        <div style={{ flex:1 }}>
                          <label style={s.fieldLabel}>Duration</label>
                          <div style={{ display:"flex", gap:6 }}>
                            <input style={{ ...s.input, flex:1 }} type="number" min="1" value={duration} onChange={e => setDuration(e.target.value)} />
                            <select style={{ ...s.select, width:70 }} value={durationUnit} onChange={e => setDurationUnit(e.target.value)}>
                              <option value="t">ticks</option>
                              <option value="s">secs</option>
                              <option value="m">mins</option>
                              <option value="h">hours</option>
                              <option value="d">days</option>
                            </select>
                          </div>
                        </div>
                      </div>
                      <button style={{ ...s.primaryBtn, opacity: authState!=="authed"?0.4:1 }}
                        disabled={authState!=="authed" || proposalLoading} onClick={requestProposal}>
                        {proposalLoading ? "Getting quote…" : "Get Price Quote"}
                      </button>
                    </div>
                    <div style={s.proposalPanel}>
                      {proposal ? (
                        <div style={s.proposalCard}>
                          <div style={s.proposalRow}>
                            <span style={s.propLabel}>Ask Price</span>
                            <span style={s.propValue}>${fmtMoney(proposal.ask_price)}</span>
                          </div>
                          <div style={s.proposalRow}>
                            <span style={s.propLabel}>Payout</span>
                            <span style={{ ...s.propValue, color:"#22c55e" }}>${fmtMoney(proposal.payout)}</span>
                          </div>
                          {proposal.spot && (
                            <div style={s.proposalRow}>
                              <span style={s.propLabel}>Entry Spot</span>
                              <span style={s.propValue}>{fmt(proposal.spot)}</span>
                            </div>
                          )}
                          {proposal.longcode && (
                            <div style={{ ...s.proposalRow, flexDirection:"column", gap:4 }}>
                              <span style={s.propLabel}>Contract</span>
                              <span style={{ color:"#94a3b8", fontSize:12, lineHeight:1.5 }}>{proposal.longcode}</span>
                            </div>
                          )}
                          <button style={{ ...s.buyBtn, opacity: buyLoading?0.5:1 }} disabled={buyLoading} onClick={buyContract}>
                            {buyLoading ? "Buying…" : `Buy for $${fmtMoney(proposal.ask_price)}`}
                          </button>
                        </div>
                      ) : (
                        <div style={s.emptyProposal}>
                          <span style={{ fontSize:40 }}>⚡</span>
                          <p style={{ color:"#475569", margin:"12px 0 0", fontSize:14 }}>Select an asset and contract, then get a price quote.</p>
                        </div>
                      )}
                      {buyResult && (
                        <div style={s.buyResultCard}>
                          <div style={{ color:"#22c55e", fontWeight:700, marginBottom:8 }}>Contract Purchased</div>
                          <div style={s.proposalRow}>
                            <span style={s.propLabel}>Contract ID</span>
                            <span style={s.propValue}>{buyResult.contract_id}</span>
                          </div>
                          <div style={s.proposalRow}>
                            <span style={s.propLabel}>Transaction</span>
                            <span style={s.propValue}>{buyResult.transaction_id}</span>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {tab === "portfolio" && (
                <div style={s.tabContent}>
                  <h2 style={s.tabTitle}>Portfolio</h2>
                  {authState !== "authed" ? (
                    <div style={s.authPrompt}>
                      <p style={{ color:"#94a3b8", margin:"0 0 12px" }}>Connect your demo account to view your portfolio.</p>
                      <button style={s.loginBtn} onClick={redirectToOAuth}>Connect Demo Account</button>
                    </div>
                  ) : portfolio.length === 0 ? (
                    <div style={s.emptyState}>
                      <span style={{ fontSize:48 }}>▤</span>
                      <p style={{ color:"#475569", marginTop:16 }}>No open contracts. Place a trade to get started.</p>
                    </div>
                  ) : (
                    <div style={s.portfolioTable}>
                      <div style={s.tableHeader}>
                        <span>Asset</span><span>Type</span><span>Buy Price</span><span>Payout</span><span>Expiry</span>
                      </div>
                      {portfolio.map(c => (
                        <div key={c.contract_id} style={s.tableRow}>
                          <span style={{ color:"#f1f5f9", fontWeight:600 }}>{c.underlying_symbol || c.symbol}</span>
                          <span style={{ color:"#94a3b8" }}>{c.contract_type}</span>
                          <span style={{ fontFamily:"monospace" }}>${fmtMoney(c.buy_price)}</span>
                          <span style={{ color:"#22c55e", fontFamily:"monospace" }}>${fmtMoney(c.payout)}</span>
                          <span style={{ color:"#64748b", fontSize:12 }}>{c.expiry_time ? new Date(c.expiry_time*1000).toLocaleTimeString() : "—"}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </main>

            {toast && (
              <div style={{ ...s.toast, background: toast.ok?"#052e16":"#1f0a0a", borderColor: toast.ok?"#22c55e":"#f87171", color: toast.ok?"#22c55e":"#f87171" }}>
                {toast.msg}
              </div>
            )}
          </div>
        );
      }

      ReactDOM.createRoot(document.getElementById('root')).render(<DBTraders />);
    </script>
  </body>
</html>

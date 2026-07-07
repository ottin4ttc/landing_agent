// landingAgent-specific (not upstream openclaw)
export function esc(s: unknown): string {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function renderDashboardHtml(session: { open_id: string; name: string | null }): string {
  const who = esc(session.name ?? session.open_id);
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>landingAgent QA 监控</title>
<style>
  body{margin:0;font-family:-apple-system,"PingFang SC",sans-serif;background:#f5f7fa;color:#1a2430}
  .top{background:linear-gradient(90deg,#0e7c86,#0a5960);color:#fff;padding:14px 20px;display:flex;align-items:center;gap:12px}
  .top b{font-size:16px}.top .sp{margin-left:auto;font-size:13px;opacity:.9}
  .top a{color:#fff;font-size:13px;margin-left:14px}
  .wrap{max-width:1100px;margin:0 auto;padding:20px}
  .filters{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px}
  .filters input,.filters select{padding:6px 8px;border:1px solid #cfd8de;border-radius:6px}
  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:20px}
  .card{background:#fff;border:1px solid #e3e8ec;border-radius:10px;padding:14px 16px}
  .card .k{font-size:12px;color:#5a6b78}.card .v{font-size:24px;font-weight:700;margin-top:4px}
  h3{font-size:14px;margin:18px 0 8px}
  table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e3e8ec;border-radius:10px;overflow:hidden}
  th,td{text-align:left;padding:8px 12px;border-bottom:1px solid #eef2f5;font-size:13px}
  th{background:#f0f4f6;color:#5a6b78}
  .bar{height:14px;background:#0e7c86;border-radius:3px}
</style></head><body>
<div class="top"><b>landingAgent QA 监控</b><span style="font-size:12px;opacity:.85">仅管理员</span>
  <span class="sp">登录：${who}<a href="/qa-admin/logout">登出</a></span></div>
<div class="wrap">
  <div class="filters">
    <input type="date" id="from"><input type="date" id="to">
    <input type="text" id="user" placeholder="用户 openId">
    <select id="chatType"><option value="">全部</option><option value="direct">私聊</option><option value="group">群聊</option></select>
    <button onclick="load()">查询</button>
  </div>
  <div class="cards" id="cards"></div>
  <h3>每日趋势</h3><div id="daily"></div>
  <h3>按人排行</h3><div id="topusers"></div>
  <h3>按会话类型</h3><div id="bychat"></div>
</div>
<script>
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}
function card(k,v){return '<div class="card"><div class="k">'+esc(k)+'</div><div class="v">'+esc(v)+'</div></div>';}
async function load(){
  const q=new URLSearchParams();
  for(const id of ['from','to','user','chatType']){const el=document.getElementById(id);if(el&&el.value){
    if(id==='from')q.set('from',String(new Date(el.value+'T00:00:00+08:00').getTime()));
    else if(id==='to')q.set('to',String(new Date(el.value+'T23:59:59+08:00').getTime()));
    else q.set(id,el.value);}}
  const r=await fetch('/qa-admin/api/dashboard?'+q.toString());
  if(r.status===401){location.href='/qa-admin/login';return;}
  const d=await r.json();
  document.getElementById('cards').innerHTML=
    card('会话总数',d.totalSessions)+card('总消息数',d.totalMessages)+card('活跃用户',d.activeUsers)+
    card('DAU',d.dau)+card('WAU',d.wau)+card('Token 消耗',d.totalTokens)+
    card('成本(USD)',(d.totalCost||0).toFixed(3))+card('平均延迟(ms)',d.avgLatencyMs==null?'—':Math.round(d.avgLatencyMs))+
    card('P95 延迟(ms)',d.p95LatencyMs==null?'—':Math.round(d.p95LatencyMs));
  const maxT=Math.max(1,...d.daily.map(x=>x.tokens||0));
  document.getElementById('daily').innerHTML=d.daily.map(x=>
    '<div style="display:flex;align-items:center;gap:8px;margin:2px 0"><span style="width:90px;font-size:12px">'+esc(x.date)+
    '</span><div class="bar" style="width:'+Math.round(300*(x.tokens||0)/maxT)+'px"></div><span style="font-size:12px">'+esc(x.tokens)+'</span></div>').join('');
  document.getElementById('topusers').innerHTML='<table><tr><th>用户</th><th>会话</th><th>消息</th><th>Token</th><th>成本</th></tr>'+
    d.topUsers.map(u=>'<tr><td>'+esc(u.user_name||u.user_id)+'</td><td>'+esc(u.sessions)+'</td><td>'+esc(u.messages)+'</td><td>'+esc(u.tokens)+'</td><td>'+esc((u.cost||0).toFixed(3))+'</td></tr>').join('')+'</table>';
  document.getElementById('bychat').innerHTML='<table><tr><th>类型</th><th>会话</th><th>Token</th></tr>'+
    d.byChatType.map(c=>'<tr><td>'+esc(c.chat_type)+'</td><td>'+esc(c.sessions)+'</td><td>'+esc(c.tokens)+'</td></tr>').join('')+'</table>';
}
load();
</script></body></html>`;
}

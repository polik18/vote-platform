import './styles.css';
import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from 'firebase/auth';
import { CONFIG } from './config.js';

const firebaseApp = initializeApp(CONFIG.firebase);
const auth = getAuth(firebaseApp);
const provider = new GoogleAuthProvider();
provider.setCustomParameters({ prompt: 'select_account' });

const app = document.querySelector('#app');
const state = { user: null, me: null, polls: [], currentPoll: null };

const esc = (s='') => String(s).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
const fmt = v => v ? new Date(v).toLocaleString('zh-TW', { hour12:false }) : '—';
const route = () => location.hash.slice(1) || '/';
const qs = sel => document.querySelector(sel);
const qsa = sel => [...document.querySelectorAll(sel)];

async function api(path, options={}) {
  if (!state.user) throw new Error('尚未登入');
  const token = await state.user.getIdToken();
  const res = await fetch(`${CONFIG.apiBase}${path}`, {
    ...options,
    headers: { 'content-type':'application/json', authorization:`Bearer ${token}`, ...(options.headers||{}) }
  });
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('text/csv')) return res;
  const data = await res.json().catch(()=>({}));
  if (!res.ok) throw Object.assign(new Error(data.message || data.error || `HTTP ${res.status}`), { data, status:res.status });
  return data;
}

function shell(content) {
  const role = state.me?.role;
  return `
  <div class="shell">
    <a class="skip-link" href="#main">跳到主要內容</a>
    <header class="topbar">
      <div class="topbar-inner">
        <button class="app-brand" data-nav="/" aria-label="回到 Polik Vote 投票首頁">
          <img src="./polik-vote-mark.svg" alt="" width="44" height="44">
          <span><strong>Polik Vote</strong><small>共識投票平台</small></span>
        </button>
        <nav class="nav" aria-label="投票平台導覽">
          <a class="portfolio-link" href="https://polik18.github.io/">← Polik 專案總覽</a>
          <button data-nav="/">投票首頁</button>
          ${state.user ? `<button data-nav="/polls">參與投票</button>` : ''}
          ${role==='admin'||role==='super_admin' ? `<button data-nav="/admin">管理</button>` : ''}
          ${role==='super_admin' ? `<button data-nav="/admins">管理員</button>` : ''}
          ${state.user ? `<span class="account-chip" title="${esc(state.user.email||'')}">${esc(state.user.email||'')}</span><button id="logoutBtn" class="ghost">登出</button>` : `<button id="loginBtn" class="primary">Google 登入</button>`}
        </nav>
      </div>
    </header>
    <main class="container" id="main">${content}</main>
    <footer class="app-footer">
      <div><strong>Polik Vote</strong><span>讓表決有清楚的規則、資格與結果。</span></div>
      <div><a href="https://polik18.github.io/">Polik Projects</a><span>GitHub Pages · Firebase · Cloudflare</span></div>
    </footer>
  </div>`;
}

function bindShell() {
  qsa('[data-nav]').forEach(b=>b.onclick=()=>location.hash=b.dataset.nav);
  if (qs('#loginBtn')) qs('#loginBtn').onclick = () => signInWithPopup(auth, provider).catch(showError);
  if (qs('#logoutBtn')) qs('#logoutBtn').onclick = () => signOut(auth);
}

function showError(e) {
  console.error(e);
  alert(`發生錯誤：${e?.data?.error || e?.message || e}`);
}

async function render() {
  const r = route();
  if (!state.user && r !== '/') location.hash='/';
  if (r==='/') return renderHome();
  if (r==='/polls') return renderPolls();
  if (r.startsWith('/poll/')) return renderPoll(r.split('/')[2]);
  if (r==='/admin') return renderAdmin();
  if (r==='/admin/create') return renderPollEditor();
  if (r.startsWith('/admin/poll/')) return renderPollAdmin(r.split('/')[3]);
  if (r==='/admins') return renderAdmins();
  app.innerHTML=shell('<div class="card"><h2>找不到頁面</h2></div>'); bindShell();
}

function renderHome() {
  app.innerHTML = shell(`
    <section class="hero">
      <div class="hero-copy">
        <p class="eyebrow">Polik Projects · Voting & Decisions</p>
        <div class="badge-row"><span class="badge">Google 帳號驗證</span><span class="badge warm">支援 300+ 人</span></div>
        <h1>讓每一次投票，<em>都有清楚的規則與結果。</em></h1>
        <p>從班級票選、校務意見到組織決策，支援記名／不記名、白名單、指定網域與多種票制，讓發起、參與和結果管理集中在同一個流程。</p>
        <div class="row hero-actions">
          ${state.user ? `<button class="primary" data-nav="/polls">查看可參與投票</button>` : `<button id="heroLogin" class="primary">使用 Google 帳號登入</button>`}
          ${state.me?.role==='admin'||state.me?.role==='super_admin' ? `<button class="secondary" data-nav="/admin">進入管理後台</button>` : ''}
        </div>
        <p class="service-note">本服務需要 Google 帳號與網路連線；是否可參與由各投票的資格規則決定。</p>
      </div>
      <div class="hero-card">
        <div class="hero-card-label">A clear voting flow</div>
        <h2>從資格設定到結果匯出，<br>每一步都看得懂。</h2>
        <ol class="flow-list">
          <li><span>01</span><div><strong>設定參與資格</strong><small>公開、Email 白名單或指定網域</small></div></li>
          <li><span>02</span><div><strong>選擇票制與規則</strong><small>單選、多選、配票及是否允許改票</small></div></li>
          <li><span>03</span><div><strong>掌握結果與門檻</strong><small>法定人數、通過條件與 CSV 匯出</small></div></li>
        </ol>
      </div>
    </section>
    <section class="feature-grid" aria-label="平台特色">
      <article><span>IDENTITY</span><h2>資格有依據</h2><p>透過 Google 帳號辨識參與者，並依公開、白名單或 Workspace 網域控制資格。</p></article>
      <article><span>BALLOT</span><h2>票制有彈性</h2><p>支援一人一票、多選與自由配票，也能設定記名、不記名、截止與改票規則。</p></article>
      <article><span>RESULTS</span><h2>結果可管理</h2><p>依需求控制公布時機，搭配排名、百分比、法定人數、通過門檻與 CSV 匯出。</p></article>
    </section>
  `); bindShell();
  if (qs('#heroLogin')) qs('#heroLogin').onclick=()=>signInWithPopup(auth,provider).catch(showError);
  qsa('[data-nav]').forEach(b=>b.onclick=()=>location.hash=b.dataset.nav);
}

async function loadPolls(){ const d=await api('/polls'); state.polls=d.polls||[]; return state.polls; }

async function renderPolls(){
  app.innerHTML=shell('<div class="card">載入中…</div>'); bindShell();
  try {
    const polls=await loadPolls();
    const visible=polls.filter(p=>p.eligible && ['scheduled','open','paused','closed'].includes(p.effectiveStatus));
    app.innerHTML=shell(`<div class="row-between"><div><h1>可參與投票</h1><p class="muted">使用目前的 Google 帳號參加符合資格的投票。</p></div></div>
      <div class="poll-list">${visible.length?visible.map(p=>pollCard(p,false)).join(''):'<div class="card muted">目前沒有可參與的投票。</div>'}</div>`); bindShell();
    qsa('[data-open-poll]').forEach(b=>b.onclick=()=>location.hash=`/poll/${b.dataset.openPoll}`);
  } catch(e){ showError(e); }
}

function pollCard(p,admin){
  return `<div class="card poll-item">
    <div class="row-between"><div><span class="badge ${p.effectiveStatus}">${statusText(p.effectiveStatus)}</span><h3 style="margin:10px 0 4px">${esc(p.title)}</h3><div class="muted small">${esc(p.description||'')}</div></div><div class="small muted">${esc(p.anonymity==='anonymous'?'不記名':'記名')} · ${voteModeText(p)}</div></div>
    <div class="row small muted"><span>開始：${fmt(p.startAt)}</span><span>截止：${fmt(p.endAt)}</span><span>資格：${eligibilityText(p)}</span></div>
    <div class="row">${admin?`<button class="primary" data-admin-poll="${p.id}">管理</button>`:`<button class="primary" data-open-poll="${p.id}">${p.effectiveStatus==='open'?'進入投票':'查看'}</button>`}</div>
  </div>`;
}
function statusText(s){return ({draft:'草稿',scheduled:'尚未開始',open:'投票中',paused:'已暫停',closed:'已截止',archived:'已封存'})[s]||s;}
function voteModeText(p){return p.voteMode==='single'?'一人一票':p.voteMode==='multiple'?`最多選 ${p.maxVotes} 個`:`每人 ${p.maxVotes} 票自由分配`;}
function eligibilityText(p){return p.eligibilityMode==='public'?'所有 Google 帳號':p.eligibilityMode==='whitelist'?'Email 白名單':`@${p.allowedDomain}`;}

async function renderPoll(id){
  app.innerHTML=shell('<div class="card">載入投票…</div>'); bindShell();
  try {
    const d=await api(`/polls/${id}`); const p=d.poll; state.currentPoll=p;
    let body=`<div class="card"><div class="row-between"><div><span class="badge ${p.effectiveStatus}">${statusText(p.effectiveStatus)}</span><h1 style="margin:12px 0 6px">${esc(p.title)}</h1><p class="muted">${esc(p.description||'')}</p></div><div class="small muted">${p.anonymity==='anonymous'?'不記名':'記名'} · ${voteModeText(p)}</div></div>`;
    if(d.participation) body+=`<div class="notice success">你已於 ${fmt(d.participation.submitted_at)} 完成投票。${p.allowChange&&p.effectiveStatus==='open'?'截止前可以修改。':''}</div>`;
    body+=`<hr><div id="voteArea">${renderVoteInputs(p,d.participation)}</div><hr><div class="row"><button class="secondary" id="resultsBtn">查看結果</button></div><div id="resultsArea"></div></div>`;
    app.innerHTML=shell(body); bindShell(); bindVote(p,d.participation); qs('#resultsBtn').onclick=()=>loadResults(p.id,true);
  } catch(e){ app.innerHTML=shell(`<div class="notice error">${esc(e?.data?.error||e.message)}</div>`); bindShell(); }
}

function renderVoteInputs(p,participation){
  if(p.effectiveStatus!=='open') return `<div class="notice">目前狀態：${statusText(p.effectiveStatus)}，無法送出投票。</div>`;
  if(participation&&!p.allowChange) return `<div class="notice">本投票送出後不可修改。</div>`;
  let options='';
  if(p.voteMode==='single') options=p.options.map(o=>`<label class="vote-option"><span><input type="radio" name="single" value="${o.id}"> <strong>${esc(o.code)} ${esc(o.label)}</strong></span><span class="muted small">${esc(o.description||'')}</span></label>`).join('');
  if(p.voteMode==='multiple') options=p.options.map(o=>`<label class="vote-option"><span><input type="checkbox" class="multi" value="${o.id}"> <strong>${esc(o.code)} ${esc(o.label)}</strong></span><span class="muted small">${esc(o.description||'')}</span></label>`).join('');
  if(p.voteMode==='allocate') options=p.options.map(o=>`<div class="vote-option alloc"><div><strong>${esc(o.code)} ${esc(o.label)}</strong><div class="muted small">${esc(o.description||'')}</div></div><input class="allocInput" type="number" min="0" max="${p.maxVotes}" value="0" data-option="${o.id}"></div>`).join('');
  return `<h3>請投票</h3><p class="muted">${p.requireAllVotes?'必須使用完整票數。':'可以不投滿全部票數。'} ${p.allowChange?'截止前可修改。':'送出後不可修改。'}</p><div class="grid">${options}</div><div class="row-between" style="margin-top:16px"><span id="voteCounter" class="muted small"></span><button id="submitVote" class="primary">${participation?'更新投票':'送出投票'}</button></div>`;
}

function bindVote(p){
  if(!qs('#submitVote')) return;
  const update=()=>{
    let n=0; if(p.voteMode==='single')n=qs('input[name="single"]:checked')?1:0;
    if(p.voteMode==='multiple')n=qsa('.multi:checked').length;
    if(p.voteMode==='allocate')n=qsa('.allocInput').reduce((s,x)=>s+Number(x.value||0),0);
    qs('#voteCounter').textContent=p.voteMode==='single'?`${n}/1`: `${n}/${p.maxVotes} 票`;
  };
  qsa('input').forEach(x=>x.oninput=update); update();
  qs('#submitVote').onclick=async()=>{
    const choices=[];
    if(p.voteMode==='single'){const x=qs('input[name="single"]:checked'); if(x)choices.push({optionId:x.value,votes:1});}
    if(p.voteMode==='multiple')qsa('.multi:checked').forEach(x=>choices.push({optionId:x.value,votes:1}));
    if(p.voteMode==='allocate')qsa('.allocInput').filter(x=>Number(x.value)>0).forEach(x=>choices.push({optionId:x.dataset.option,votes:Number(x.value)}));
    if(!confirm('確定送出這次投票嗎？'))return;
    try{await api(`/polls/${p.id}/vote`,{method:'POST',body:JSON.stringify({choices})}); alert('投票成功'); renderPoll(p.id);}catch(e){showError(e);}
  };
}

async function loadResults(id,inline=false){
  try{
    const d=await api(`/polls/${id}/results`);
    const max=Math.max(1,...d.results.map(r=>r.votes));
    const html=`<hr><h3>結果</h3><div class="grid grid-3"><div class="stat"><span>投票人數</span><strong>${d.totalParticipants}</strong></div><div class="stat"><span>總票數</span><strong>${d.totalVotes}</strong></div><div class="stat"><span>法定人數</span><strong>${d.quorum?.configured ? (d.quorum.met===true?'已達成':d.quorum.met===false?'未達成':'待判定') : '未設定'}</strong></div></div><div class="grid" style="margin-top:16px">${d.results.map(r=>`<div class="card"><div class="row-between"><strong>#${r.rank} ${esc(r.code)} ${esc(r.label)}</strong><span>${r.votes} 票 · ${r.percentage}% ${r.approved===true?'· 通過':r.approved===false?'· 未通過':''}</span></div><div class="progress"><div style="width:${Math.max(2,r.votes/max*100)}%"></div></div></div>`).join('')}</div>`;
    if(inline&&qs('#resultsArea')) qs('#resultsArea').innerHTML=html; else return html;
  }catch(e){ if(inline&&qs('#resultsArea'))qs('#resultsArea').innerHTML=`<div class="notice error" style="margin-top:12px">${esc(e?.data?.error||e.message)}</div>`; else throw e; }
}

async function renderAdmin(){
  app.innerHTML=shell('<div class="card">載入管理後台…</div>'); bindShell();
  try{
    const polls=await loadPolls(); const mine=state.me.role==='super_admin'?polls:polls.filter(p=>p.canManage);
    app.innerHTML=shell(`<div class="row-between"><div><h1>管理後台</h1><p class="muted">${state.me.role==='super_admin'?'你可以管理全部投票。':'你只能管理自己建立的投票。'}</p></div><button class="primary" data-nav="/admin/create">＋ 建立投票</button></div><div class="poll-list">${mine.length?mine.map(p=>pollCard(p,true)).join(''):'<div class="card muted">尚未建立投票。</div>'}</div>`); bindShell();
    qsa('[data-admin-poll]').forEach(b=>b.onclick=()=>location.hash=`/admin/poll/${b.dataset.adminPoll}`);
    qsa('[data-nav]').forEach(b=>b.onclick=()=>location.hash=b.dataset.nav);
  }catch(e){showError(e);}
}

function pollForm(p={}){
  const o=p.options?.length?p.options:[{code:'A',label:'選項 A',description:''},{code:'B',label:'選項 B',description:''}];
  return `<form id="pollForm" class="grid">
    <div class="grid grid-2"><label>投票名稱<input name="title" required value="${esc(p.title||'')}"></label><label>狀態<select name="status">${['draft','scheduled','open','paused','closed','archived'].map(x=>`<option value="${x}" ${p.status===x?'selected':''}>${statusText(x)}</option>`).join('')}</select></label></div>
    <label>說明<textarea name="description">${esc(p.description||'')}</textarea></label>
    <div class="grid grid-3">
      <label>記名方式<select name="anonymity"><option value="named" ${p.anonymity==='named'?'selected':''}>記名</option><option value="anonymous" ${p.anonymity==='anonymous'?'selected':''}>不記名</option></select></label>
      <label>票制<select name="voteMode"><option value="single" ${p.voteMode==='single'?'selected':''}>一人一票</option><option value="multiple" ${p.voteMode==='multiple'?'selected':''}>最多選 N 個不同選項</option><option value="allocate" ${p.voteMode==='allocate'?'selected':''}>N 票自由分配</option></select></label>
      <label>最大票數<input name="maxVotes" type="number" min="1" max="100" value="${p.maxVotes||1}"></label>
    </div>
    <div class="row"><label><input style="width:auto" type="checkbox" name="requireAllVotes" ${p.requireAllVotes?'checked':''}> 必須投滿</label><label><input style="width:auto" type="checkbox" name="allowChange" ${p.allowChange?'checked':''}> 截止前允許改票</label></div>
    <div class="grid grid-2"><label>投票資格<select name="eligibilityMode"><option value="public" ${p.eligibilityMode==='public'?'selected':''}>公開 Google 帳號</option><option value="whitelist" ${p.eligibilityMode==='whitelist'?'selected':''}>Email 白名單</option><option value="domain" ${p.eligibilityMode==='domain'?'selected':''}>指定網域</option></select></label><label>指定網域（如 company.com）<input name="allowedDomain" value="${esc(p.allowedDomain||'')}"></label></div>
    <div class="grid grid-2"><label>開始時間<input name="startAt" type="datetime-local" value="${toLocalInput(p.startAt)}"></label><label>截止時間<input name="endAt" type="datetime-local" value="${toLocalInput(p.endAt)}"></label></div>
    <div class="grid grid-3"><label>結果顯示<select name="resultsVisibility"><option value="public" ${p.resultsVisibility==='public'?'selected':''}>即時公開</option><option value="after_vote" ${p.resultsVisibility==='after_vote'?'selected':''}>投票後可看</option><option value="after_close" ${!p.resultsVisibility||p.resultsVisibility==='after_close'?'selected':''}>截止後公開</option><option value="admin_only" ${p.resultsVisibility==='admin_only'?'selected':''}>僅管理員</option></select></label><label>法定人數<select name="quorumType"><option value="none">不設定</option><option value="count" ${p.quorumType==='count'?'selected':''}>指定人數</option><option value="percent" ${p.quorumType==='percent'?'selected':''}>資格人數百分比</option></select></label><label>法定值<input name="quorumValue" type="number" step="0.01" value="${p.quorumValue??''}"></label></div>
    <div class="grid grid-2"><label>通過條件<select name="approvalType"><option value="none">不設定</option><option value="gt50" ${p.approvalType==='gt50'?'selected':''}>&gt; 50%</option><option value="gte50" ${p.approvalType==='gte50'?'selected':''}>≥ 50%</option><option value="two_thirds" ${p.approvalType==='two_thirds'?'selected':''}>≥ 2/3</option><option value="percent" ${p.approvalType==='percent'?'selected':''}>自訂百分比</option><option value="count" ${p.approvalType==='count'?'selected':''}>自訂票數</option></select></label><label>通過值<input name="approvalValue" type="number" step="0.01" value="${p.approvalValue??''}"></label></div>
    <fieldset><legend>候選項目</legend><div id="optionsEditor">${o.map(optionRow).join('')}</div><button type="button" id="addOption" class="secondary">＋ 新增選項</button></fieldset>
    <div class="row"><button class="primary" type="submit">儲存</button></div>
  </form>`;
}
function optionRow(o={},i=0){return `<div class="option-row"><label>編號<input class="opt-code" value="${esc(o.code||String(i+1))}"></label><label>名稱<input class="opt-label" value="${esc(o.label||'')}"></label><label>說明<input class="opt-desc" value="${esc(o.description||'')}"></label><button type="button" class="danger removeOpt">刪除</button></div>`;}
function toLocalInput(v){if(!v)return''; const d=new Date(v); const z=n=>String(n).padStart(2,'0'); return `${d.getFullYear()}-${z(d.getMonth()+1)}-${z(d.getDate())}T${z(d.getHours())}:${z(d.getMinutes())}`;}

async function renderPollEditor(existing=null){
  app.innerHTML=shell(`<div class="card"><h1>${existing?'編輯投票':'建立投票'}</h1>${pollForm(existing||{anonymity:'anonymous',voteMode:'single',eligibilityMode:'public',resultsVisibility:'after_close',status:'draft',showPercentages:true,showRanking:true})}</div>`); bindShell(); bindPollForm(existing);
}
function bindPollForm(existing){
  qs('#addOption').onclick=()=>{qs('#optionsEditor').insertAdjacentHTML('beforeend',optionRow({},qsa('.option-row').length)); bindRemove();}; bindRemove();
  qs('#pollForm').onsubmit=async e=>{e.preventDefault(); const f=new FormData(e.currentTarget); const options=qsa('.option-row').map(r=>({code:r.querySelector('.opt-code').value,label:r.querySelector('.opt-label').value,description:r.querySelector('.opt-desc').value}));
    const body={title:f.get('title'),description:f.get('description'),status:f.get('status'),anonymity:f.get('anonymity'),voteMode:f.get('voteMode'),maxVotes:Number(f.get('maxVotes')),requireAllVotes:f.get('requireAllVotes')==='on',allowChange:f.get('allowChange')==='on',eligibilityMode:f.get('eligibilityMode'),allowedDomain:f.get('allowedDomain'),startAt:f.get('startAt')?new Date(f.get('startAt')).toISOString():null,endAt:f.get('endAt')?new Date(f.get('endAt')).toISOString():null,resultsVisibility:f.get('resultsVisibility'),showPercentages:true,showRanking:true,quorumType:f.get('quorumType'),quorumValue:f.get('quorumValue')?Number(f.get('quorumValue')):null,approvalType:f.get('approvalType'),approvalValue:f.get('approvalValue')?Number(f.get('approvalValue')):null,options};
    try{ const d=existing?await api(`/polls/${existing.id}`,{method:'PATCH',body:JSON.stringify(body)}):await api('/polls',{method:'POST',body:JSON.stringify(body)}); alert('已儲存'); location.hash=`/admin/poll/${existing?.id||d.id}`;}catch(err){showError(err);} };
}
function bindRemove(){qsa('.removeOpt').forEach(b=>b.onclick=()=>b.closest('.option-row').remove());}

async function renderPollAdmin(id){
  app.innerHTML=shell('<div class="card">載入管理頁…</div>'); bindShell();
  try{
    const d=await api(`/polls/${id}`); const p=d.poll;
    const results=await api(`/polls/${id}/results`).catch(()=>null); const participants=await api(`/polls/${id}/participants`).catch(()=>({participants:[]}));
    app.innerHTML=shell(`<div class="row-between"><div><span class="badge ${p.effectiveStatus}">${statusText(p.effectiveStatus)}</span><h1 style="margin:10px 0">${esc(p.title)}</h1><div class="muted">建立者：${esc(p.ownerEmail)}</div></div><div class="row"><button class="secondary" id="duplicateBtn">複製</button><button class="danger" id="deleteBtn">刪除</button></div></div>
      <div class="grid grid-3" style="margin:18px 0"><div class="stat"><span>參與人數</span><strong>${participants.participants.length}</strong></div><div class="stat"><span>總票數</span><strong>${results?.totalVotes??'—'}</strong></div><div class="stat"><span>模式</span><strong style="font-size:18px">${p.anonymity==='anonymous'?'不記名':'記名'} / ${voteModeText(p)}</strong></div></div>
      <div class="tabs"><button class="active" data-tab="edit">設定</button><button data-tab="participants">參與名單</button><button data-tab="results">結果</button><button data-tab="whitelist">白名單</button><button data-tab="audit">Audit Log</button></div>
      <div id="tab-edit" class="tabPane card">${pollForm(p)}</div>
      <div id="tab-participants" class="tabPane card" hidden>${participantsTable(participants.participants)}<div class="row"><button class="secondary exportBtn" data-type="participants">匯出參與名單 CSV</button>${p.anonymity==='named'?'<button class="secondary exportBtn" data-type="named_votes">匯出記名選票 CSV</button>':''}</div></div>
      <div id="tab-results" class="tabPane card" hidden>${results?resultsHtml(results):'<div class="muted">目前無法查看結果。</div>'}<div class="row"><button class="secondary exportBtn" data-type="results">匯出結果 CSV</button></div></div>
      <div id="tab-whitelist" class="tabPane card" hidden>${whitelistPanel(p)}</div>
      <div id="tab-audit" class="tabPane card" hidden><button id="loadAudit" class="secondary">載入紀錄</button><div id="auditArea"></div></div>`); bindShell(); bindPollForm(p); bindAdminTabs();
    qs('#duplicateBtn').onclick=async()=>{try{const r=await api(`/polls/${id}/duplicate`,{method:'POST',body:'{}'}); location.hash=`/admin/poll/${r.id}`;}catch(e){showError(e);}};
    qs('#deleteBtn').onclick=async()=>{if(!confirm('確定刪除？已有投票紀錄時系統會拒絕，請改用封存。'))return;try{await api(`/polls/${id}`,{method:'DELETE'});location.hash='/admin';}catch(e){showError(e);}};
    qsa('.exportBtn').forEach(b=>b.onclick=()=>downloadCsv(id,b.dataset.type));
    bindWhitelist(id,p); qs('#loadAudit').onclick=()=>loadAudit(id);
  }catch(e){showError(e);}
}
function bindAdminTabs(){qsa('[data-tab]').forEach(b=>b.onclick=()=>{qsa('[data-tab]').forEach(x=>x.classList.remove('active'));b.classList.add('active');qsa('.tabPane').forEach(p=>p.hidden=true);qs(`#tab-${b.dataset.tab}`).hidden=false;});}
function participantsTable(rows){return `<div class="table-wrap"><table><thead><tr><th>姓名</th><th>Email</th><th>票數</th><th>首次送出</th><th>更新</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${esc(r.display_name||'')}</td><td>${esc(r.email)}</td><td>${r.vote_count}</td><td>${fmt(r.submitted_at)}</td><td>${fmt(r.updated_at)}</td></tr>`).join('')}</tbody></table></div>`;}
function resultsHtml(d){return `<div class="grid">${d.results.map(r=>`<div><div class="row-between"><strong>#${r.rank} ${esc(r.code)} ${esc(r.label)}</strong><span>${r.votes} 票 · ${r.percentage}% ${r.approved===true?'· 通過':r.approved===false?'· 未通過':''}</span></div></div>`).join('')}</div>`;}
function whitelistPanel(p){return p.eligibilityMode!=='whitelist'?'<div class="notice">此投票不是 Email 白名單模式。</div>':`<p class="muted">可直接貼上 Email，或選擇 CSV。CSV 支援欄位 <code>email,name</code>，name 可省略。</p><textarea id="emailsText" placeholder="a@example.com\nb@example.com"></textarea><div class="row"><input id="csvFile" type="file" accept=".csv,text/csv"><button id="importWhitelist" class="primary">匯入白名單</button><button id="loadWhitelist" class="secondary">查看目前名單</button></div><div id="whitelistArea"></div>`;}
function bindWhitelist(id,p){if(p.eligibilityMode!=='whitelist')return; qs('#importWhitelist').onclick=async()=>{try{let entries=[]; const txt=qs('#emailsText').value.trim(); if(txt)entries.push(...txt.split(/\r?\n|,/).map(x=>x.trim()).filter(x=>x.includes('@'))); const file=qs('#csvFile').files[0]; if(file){const rows=parseCsv(await file.text()); const head=rows.shift().map(x=>x.toLowerCase()); const ei=head.indexOf('email'); const ni=head.indexOf('name'); entries.push(...rows.map(r=>({email:r[ei>=0?ei:0],name:ni>=0?r[ni]:''})));} const d=await api(`/polls/${id}/whitelist`,{method:'POST',body:JSON.stringify({entries})}); alert(`已匯入 ${d.count} 筆`);}catch(e){showError(e);}}; qs('#loadWhitelist').onclick=async()=>{try{const d=await api(`/polls/${id}/whitelist`);qs('#whitelistArea').innerHTML=`<p>${d.entries.length} 筆</p><div class="table-wrap"><table><tr><th>Email</th><th>名稱</th></tr>${d.entries.map(x=>`<tr><td>${esc(x.email)}</td><td>${esc(x.display_name||'')}</td></tr>`).join('')}</table></div>`;}catch(e){showError(e);}};}
function parseCsv(text){const out=[];let row=[],cell='',q=false;for(let i=0;i<text.length;i++){const c=text[i],n=text[i+1];if(q){if(c==='"'&&n==='"'){cell+='"';i++;}else if(c==='"')q=false;else cell+=c;}else{if(c==='"')q=true;else if(c===','){row.push(cell);cell='';}else if(c==='\n'){row.push(cell.replace(/\r$/,''));out.push(row);row=[];cell='';}else cell+=c;}}if(cell||row.length){row.push(cell);out.push(row);}return out.filter(r=>r.some(x=>x.trim()));}
async function loadAudit(id){try{const d=await api(`/polls/${id}/audit`);qs('#auditArea').innerHTML=`<div class="table-wrap"><table><tr><th>時間</th><th>操作者</th><th>動作</th><th>細節</th></tr>${d.logs.map(x=>`<tr><td>${fmt(x.created_at)}</td><td>${esc(x.actor_email||'')}</td><td>${esc(x.action)}</td><td><code>${esc(JSON.stringify(x.detail))}</code></td></tr>`).join('')}</table></div>`;}catch(e){showError(e);}}
async function downloadCsv(id,type){try{const res=await api(`/polls/${id}/export?type=${encodeURIComponent(type)}`);const blob=await res.blob();const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`${id}-${type}.csv`;a.click();URL.revokeObjectURL(a.href);}catch(e){showError(e);}}

async function renderAdmins(){
  if(state.me?.role!=='super_admin'){location.hash='/';return;}
  try{const d=await api('/admins');app.innerHTML=shell(`<div class="card"><h1>管理員</h1><div class="row"><input id="newAdmin" style="max-width:360px" placeholder="admin@example.com"><button id="addAdmin" class="primary">新增管理員</button></div><hr><div class="table-wrap"><table><tr><th>Email</th><th>建立時間</th><th></th></tr>${d.admins.map(a=>`<tr><td>${esc(a.email)}</td><td>${fmt(a.created_at)}</td><td><button class="danger removeAdmin" data-email="${esc(a.email)}">移除</button></td></tr>`).join('')}</table></div><p class="muted small">Super Admin 由 Worker 環境變數 SUPER_ADMIN_EMAIL 指定，不會出現在這個清單。</p></div>`);bindShell();qs('#addAdmin').onclick=async()=>{try{await api('/admins',{method:'POST',body:JSON.stringify({email:qs('#newAdmin').value})});renderAdmins();}catch(e){showError(e);}};qsa('.removeAdmin').forEach(b=>b.onclick=async()=>{if(confirm(`移除 ${b.dataset.email}？`)){await api(`/admins/${encodeURIComponent(b.dataset.email)}`,{method:'DELETE'});renderAdmins();}});}catch(e){showError(e);}
}

onAuthStateChanged(auth, async user=>{
  state.user=user; state.me=null;
  if(user){try{state.me=await api('/me');}catch(e){console.error(e);}}
  render();
});
window.addEventListener('hashchange',render);

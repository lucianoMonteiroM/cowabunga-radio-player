'use strict';

/* ── Config ──────────────────────────────────────────────── */
const IDENTIFIER = 'aadamjacobs';
const BASE       = 'https://archive.org';
const BATCH      = 5000;
const searchURL  = (id, rows, start) =>
  `${BASE}/advancedsearch.php?q=collection:${id}+mediatype:audio` +
  `&fl[]=identifier&fl[]=title&fl[]=creator&fl[]=date` +
  `&rows=${rows}&start=${start}&output=json&sort[]=creator+asc&sort[]=title+asc`;
const metaURL  = id       => `${BASE}/metadata/${id}`;
const dlURL    = (id, fn) => `${BASE}/download/${id}/${encodeURIComponent(fn)}`;
const coverURL = id       => `${BASE}/services/img/${id}`;

/* ── DOM ─────────────────────────────────────────────────── */
const audio = document.getElementById('audio-el');
const $     = id => document.getElementById(id);

/* ── State ───────────────────────────────────────────────── */
let allAlbums = [], filtered = [], tracks = [];
let albumIdx = -1, trackIdx = -1, expanded = {};
const coverCache = new Set();
let likedAlbums = new Set(JSON.parse(localStorage.getItem('liked_albums') || '[]'));

/* ── Web Audio ───────────────────────────────────────────── */
let actx = null, srcNode = null, hpfNode = null;
let eqFilters = [], compNode = null, masterGain = null, analyserNode = null;
let compEnabled = false, eqOpen = false, animFrameId = null, currentPreset = 'flat';

const EQ_BANDS = [
  { freq: 80,    type: 'lowshelf',  label: '80Hz',   sub: 'Bass'     },
  { freq: 250,   type: 'peaking',   label: '250Hz',  sub: 'Low Mid'  },
  { freq: 1000,  type: 'peaking',   label: '1kHz',   sub: 'Mid'      },
  { freq: 4000,  type: 'peaking',   label: '4kHz',   sub: 'Presence' },
  { freq: 12000, type: 'highshelf', label: '12kHz',  sub: 'Air'      },
];
const PRESETS = {
  flat:  { label:'Flat',    gains:[ 0,  0,  0,  0,  0], hpf: 20,  comp:false, thr:-24, ratio:4 },
  vinyl: { label:'Vinil',   gains:[ 3, -2,  0,  4,  2], hpf: 80,  comp:true,  thr:-20, ratio:3 },
  live:  { label:'Ao Vivo', gains:[-2,  0,  2,  5,  1], hpf: 40,  comp:true,  thr:-26, ratio:6 },
  radio: { label:'Rádio',   gains:[-3,  2,  4,  3, -1], hpf:100,  comp:true,  thr:-18, ratio:4 },
  voice: { label:'Voz',     gains:[ 0, -4,  2,  5,  1], hpf:120,  comp:true,  thr:-16, ratio:3 },
};

/* ── Helpers ─────────────────────────────────────────────── */
const esc = s => (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
function fmtTime(s) {
  const n = parseFloat(s);
  if (!n || isNaN(n)) return '0:00';
  return `${Math.floor(n/60)}:${String(Math.floor(n%60)).padStart(2,'0')}`;
}
const SMALL = new Set(['a','an','the','and','but','or','for','nor','on','at','to','by','in','of','up','as','is','vs','e','de','do','da','dos','das','em','no','na','nos','nas','com','por','para','o','os','as']);
function toTitleCase(str) {
  if (!str) return '';
  return str.replace(/[_-]+/g,' ').replace(/\s+/g,' ').trim().split(' ')
    .map((w,i) => { const l=w.toLowerCase(); return (i>0&&SMALL.has(l))?l:l.charAt(0).toUpperCase()+l.slice(1); }).join(' ');
}
function getTrackTitle(f) {
  const t = (f.title||'').trim();
  if (t && !/^unknow/i.test(t) && t.toLowerCase() !== (f.name||'').toLowerCase()) return toTitleCase(t);
  return toTitleCase((f.name||'').replace(/\.[^.]+$/,'').replace(/^[\d\s._-]+/,'').trim()) || f.name || '—';
}
function isAudio(f) {
  const e=(f.name||'').split('.').pop().toLowerCase(), fm=(f.format||'').toLowerCase();
  return /^(mp3|ogg|opus|flac|wav|m4a|aac)$/.test(e) || /mp3|vbr|ogg|vorbis|flac|wav/i.test(fm);
}
const isMobile  = () => window.innerWidth <= 767;
const isTablet  = () => window.innerWidth >= 768 && window.innerWidth <= 1023;
const isDesktop = () => window.innerWidth >= 1024;

/* ── Liked albums ────────────────────────────────────────── */
function saveLiked() {
  localStorage.setItem('liked_albums', JSON.stringify([...likedAlbums]));
}
function toggleLiked(identifier) {
  if (likedAlbums.has(identifier)) {
    likedAlbums.delete(identifier);
  } else {
    likedAlbums.add(identifier);
    $('liked-section').classList.add('open');
  }
  saveLiked();
  renderLikedSection();
  document.querySelectorAll('#artist-list .btn-like').forEach(btn => {
    if (btn.dataset.id === identifier) btn.classList.toggle('liked', likedAlbums.has(identifier));
  });
}
function renderLikedSection() {
  const list = $('liked-list'), countEl = $('liked-count');
  if (!list) return;
  const validLiked = [...likedAlbums].map(id => allAlbums.find(a => a.identifier === id)).filter(Boolean);
  countEl.textContent = validLiked.length || '';
  if (!validLiked.length) {
    list.innerHTML = `<div class="liked-empty">Nenhum álbum curtido</div>`;
    return;
  }
  list.innerHTML = validLiked.map(a => {
    const ri = allAlbums.indexOf(a);
    return `
      <div class="album-item${ri===albumIdx?' active':''}" data-real="${ri}" tabindex="0" role="button">
        <div class="album-thumb-ph">♪</div>
        <img class="album-thumb" loading="lazy" src="${coverURL(a.identifier)}" alt=""
             onerror="this.style.display='none';this.previousElementSibling.style.display='flex'"
             onload="this.previousElementSibling.style.display='none'">
        <div class="album-info">
          <div class="album-name">${esc(a.title)}</div>
          <div class="album-date">${a.date||'—'}</div>
        </div>
        <button class="btn-like liked" data-id="${esc(a.identifier)}" aria-label="Remover dos curtidos" title="Remover dos curtidos">
          <svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.5"/><path d="M12 7v10M7 12h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
        </button>
      </div>`;
  }).join('');
}
$('liked-hdr').addEventListener('click', () => $('liked-section').classList.toggle('open'));
$('liked-list').addEventListener('click', e => {
  const btn = e.target.closest('.btn-like');
  if (btn) { e.stopPropagation(); toggleLiked(btn.dataset.id); return; }
  const item = e.target.closest('.album-item');
  if (item) selectAlbum(+item.dataset.real);
});
if (likedAlbums.size > 0) $('liked-section').classList.add('open');

/* ── Sidebar drawer (mobile) ─────────────────────────────── */
function openSidebar()  {
  $('sidebar').classList.add('open');
  $('sidebar-overlay').classList.add('vis');
}
function closeSidebar() {
  $('sidebar').classList.remove('open');
  $('sidebar-overlay').classList.remove('vis');
}
$('btn-menu').addEventListener('click', openSidebar);
$('btn-sidebar-close').addEventListener('click', closeSidebar);
$('sidebar-overlay').addEventListener('click', closeSidebar);

/* ── Web Audio ───────────────────────────────────────────── */
function initAudio() {
  if (actx) { actx.resume(); return; }
  try {
    actx = new (window.AudioContext || window.webkitAudioContext)();
    srcNode = actx.createMediaElementSource(audio);
    hpfNode = actx.createBiquadFilter();
    hpfNode.type = 'highpass'; hpfNode.frequency.value = 20; hpfNode.Q.value = 0.707;
    eqFilters = EQ_BANDS.map(b => {
      const f = actx.createBiquadFilter();
      f.type = b.type; f.frequency.value = b.freq; f.gain.value = 0;
      f.Q.value = b.type==='peaking' ? 1.4 : 0.707;
      return f;
    });
    compNode = actx.createDynamicsCompressor();
    compNode.threshold.value=-24; compNode.knee.value=6; compNode.ratio.value=1;
    compNode.attack.value=0.005; compNode.release.value=0.15;
    analyserNode = actx.createAnalyser();
    analyserNode.fftSize=512; analyserNode.smoothingTimeConstant=0.78;
    masterGain = actx.createGain(); masterGain.gain.value=1;
    let node = srcNode;
    node.connect(hpfNode); node=hpfNode;
    for (const f of eqFilters) { node.connect(f); node=f; }
    node.connect(compNode); compNode.connect(analyserNode);
    analyserNode.connect(masterGain); masterGain.connect(actx.destination);
    renderEqBands(); updateEqStatus();
  } catch(e) { console.warn('[WebAudio]', e.message); actx=null; }
}
function setEqGain(i,g) { if(eqFilters[i]&&actx) eqFilters[i].gain.setTargetAtTime(g,actx.currentTime,0.008); }
function applyPreset(key) {
  const p = PRESETS[key]; if(!p) return;
  currentPreset = key;
  p.gains.forEach((g,i) => {
    const sl=$(`eq-${i}`), vl=$(`eqval-${i}`);
    if(sl) sl.value=g; if(vl) vl.textContent=(g>=0?'+':'')+g+' dB';
    if(actx) setEqGain(i,g);
  });
  if(hpfNode&&actx) hpfNode.frequency.setTargetAtTime(p.hpf,actx.currentTime,0.01);
  compEnabled=p.comp;
  if(compNode&&actx) {
    compNode.threshold.setTargetAtTime(p.thr,actx.currentTime,0.01);
    compNode.ratio.setTargetAtTime(p.comp?p.ratio:1,actx.currentTime,0.01);
  }
  const ct=$('comp-toggle');
  if(ct){ct.classList.toggle('on',p.comp);ct.textContent=p.comp?'ON':'OFF';}
  const ts=$('comp-threshold'),tv=$('comp-thr-val');
  if(ts) ts.value=p.thr; if(tv) tv.textContent=p.thr+' dB';
  const rs=$('comp-ratio'),rv=$('comp-ratio-val');
  if(rs) rs.value=p.ratio; if(rv) rv.textContent=p.ratio+' : 1';
  document.querySelectorAll('.preset-btn').forEach(b=>b.classList.toggle('active',b.dataset.preset===key));
  updateEqStatus();
}
function updateEqStatus() {
  const st=$('eq-status'); if(!st) return;
  if(currentPreset==='flat'){ st.textContent=''; st.classList.remove('vis'); }
  else { st.textContent=PRESETS[currentPreset]?.label||''; st.classList.add('vis'); }
}
function drawSpectrum() {
  if(!analyserNode||!eqOpen||isMobile()) return;
  const canvas=$('eq-canvas'); if(!canvas) return;
  const c=canvas.getContext('2d'), W=canvas.width, H=canvas.height;
  const data=new Uint8Array(analyserNode.frequencyBinCount);
  analyserNode.getByteFrequencyData(data);
  c.clearRect(0,0,W,H);
  const step=Math.ceil(data.length/W);
  for(let x=0;x<W;x++){
    let sum=0; for(let s=0;s<step;s++) sum+=data[x*step+s]||0;
    const v=sum/step, h=(v/255)*H;
    c.fillStyle=`rgba(212,167,${Math.round(58+v/255*100)},${0.25+v/255*0.65})`;
    c.fillRect(x,H-h,1,h);
  }
  animFrameId=requestAnimationFrame(drawSpectrum);
}
function renderEqBands() {
  const container=$('eq-bands'); if(!container) return;
  container.innerHTML = EQ_BANDS.map((b,i)=>`
    <div class="eq-band">
      <div class="eq-freq">${b.label}<br><small>${b.sub}</small></div>
      <div class="eq-slider-wrap">
        <input type="range" class="eq-slider" id="eq-${i}" min="-12" max="12" value="0" step="0.5" data-band="${i}">
      </div>
      <div class="eq-val" id="eqval-${i}">0 dB</div>
    </div>`).join('');
  container.addEventListener('input', e=>{
    const sl=e.target.closest('.eq-slider'); if(!sl) return;
    const i=+sl.dataset.band, g=+sl.value;
    const vl=$(`eqval-${i}`); if(vl) vl.textContent=(g>=0?'+':'')+g+' dB';
    if(actx) setEqGain(i,g);
    document.querySelectorAll('.preset-btn').forEach(b=>b.classList.remove('active'));
    currentPreset='custom'; updateEqStatus();
  });
}
function toggleEqPanel() {
  eqOpen=!eqOpen;
  $('eq-panel').classList.toggle('open',eqOpen);
  $('btn-eq').classList.toggle('active',eqOpen);
  if(eqOpen){ if(actx) drawSpectrum(); else renderEqBands(); }
  else { if(animFrameId){cancelAnimationFrame(animFrameId);animFrameId=null;} }
}
$('comp-toggle').addEventListener('click',()=>{
  compEnabled=!compEnabled;
  const btn=$('comp-toggle'); btn.classList.toggle('on',compEnabled); btn.textContent=compEnabled?'ON':'OFF';
  if(compNode&&actx) compNode.ratio.setTargetAtTime(compEnabled?parseFloat($('comp-ratio').value):1,actx.currentTime,0.01);
});
$('comp-threshold').addEventListener('input',function(){
  $('comp-thr-val').textContent=this.value+' dB';
  if(compNode&&actx) compNode.threshold.setTargetAtTime(+this.value,actx.currentTime,0.01);
  currentPreset='custom'; updateEqStatus();
});
$('comp-ratio').addEventListener('input',function(){
  $('comp-ratio-val').textContent=this.value+' : 1';
  if(compNode&&actx&&compEnabled) compNode.ratio.setTargetAtTime(+this.value,actx.currentTime,0.01);
  currentPreset='custom'; updateEqStatus();
});
$('eq-presets').addEventListener('click',e=>{ const b=e.target.closest('.preset-btn'); if(b){initAudio();applyPreset(b.dataset.preset);} });
$('btn-eq').addEventListener('click',toggleEqPanel);

/* ── Bootstrap ───────────────────────────────────────────── */
async function init() {
  try {
    const [itemRes,p1Res] = await Promise.all([
      fetch(metaURL(IDENTIFIER)), fetch(searchURL(IDENTIFIER,BATCH,0))
    ]);
    const [itemData,p1] = await Promise.all([itemRes.json(),p1Res.json()]);
    const meta=itemData.metadata||{}, numFound=parseInt(p1.response?.numFound)||0;
    let docs=p1.response?.docs||[];
    $('album-count').textContent=numFound>docs.length?`${docs.length} / ${numFound}`:docs.length;
    if(numFound>docs.length){
      for(let start=BATCH;start<numFound;start+=BATCH){
        try{
          const pd=await fetch(searchURL(IDENTIFIER,BATCH,start)).then(r=>r.json());
          docs=docs.concat(pd.response?.docs||[]);
          $('album-count').textContent=`${docs.length} / ${numFound}`;
        }catch(pe){console.warn('[pagination]',pe);break;}
      }
    }
    document.title=`Archive Player · ${meta.title||IDENTIFIER}`;
    if(docs.length>0){
      allAlbums=docs.map(d=>({
        identifier:d.identifier,
        title:toTitleCase(d.title||d.identifier),
        creator:Array.isArray(d.creator)?d.creator[0]:(d.creator||''),
        date:(d.date||'').slice(0,4),
      }));
    } else {
      allAlbums=[{
        identifier:IDENTIFIER,
        title:toTitleCase(meta.title||IDENTIFIER),
        creator:Array.isArray(meta.creator)?meta.creator[0]:(meta.creator||''),
        date:(meta.date||'').slice(0,4),
        files:(itemData.files||[]).filter(isAudio),
      }];
    }
    filtered=[...allAlbums];
    const groups=groupByArtist(allAlbums);
    groups.forEach(([k])=>{ expanded[k]=false; });
    renderSidebar();
    renderLikedSection();
    if(allAlbums.length===1) selectAlbum(0);
  } catch(e) {
    $('artist-list').innerHTML=`<div class="state" style="padding:2rem"><div class="state-icon">⚠</div><div>Erro ao carregar<br><small>${esc(e.message)}</small></div></div>`;
  }
}

/* ── Group by artist ─────────────────────────────────────── */
function groupByArtist(albums) {
  const map={};
  albums.forEach(a=>{ const k=(a.creator||'Desconhecido').trim(); if(!map[k])map[k]=[]; map[k].push(a); });
  Object.values(map).forEach(arr=>arr.sort((a,b)=>(a.date||'9999').localeCompare(b.date||'9999')||a.title.localeCompare(b.title)));
  return Object.entries(map).sort((a,b)=>a[0].localeCompare(b[0],undefined,{sensitivity:'base'}));
}

/* ── Cover cache helpers ─────────────────────────────────── */
function preloadCover(id) {
  if (coverCache.has(id)) return;
  const img = new Image();
  img.onload = () => coverCache.add(id);
  img.src = coverURL(id);
}

/* ── Preload group covers before opening ─────────────────── */
function preloadAndOpen(groupEl, artist) {
  const items = Array.from(groupEl.querySelectorAll('.album-item'));
  if (!items.length) { expanded[artist]=true; groupEl.classList.add('open'); return; }

  const hdr = groupEl.querySelector('.artist-hdr');
  hdr.style.opacity = '0.45';

  let done = 0, opened = false;
  const total = items.length;

  function open() {
    if (opened) return;
    opened = true;
    clearTimeout(timer);
    hdr.style.opacity = '';
    expanded[artist] = true;
    groupEl.classList.add('open');
  }

  const timer = setTimeout(open, 1500);

  items.forEach(item => {
    const ri = +item.dataset.real;
    if (isNaN(ri) || ri < 0 || ri >= allAlbums.length) { if (++done >= total) open(); return; }
    const img = new Image();
    img.onload = () => { coverCache.add(allAlbums[ri].identifier); if (++done >= total) open(); };
    img.onerror = () => { if (++done >= total) open(); };
    img.src = coverURL(allAlbums[ri].identifier);
  });
}

/* ── Render sidebar ──────────────────────────────────────── */
function renderSidebar() {
  const groups=groupByArtist(filtered);
  $('album-count').textContent=filtered.length===allAlbums.length?`${allAlbums.length} álbuns`:`${filtered.length} de ${allAlbums.length}`;
  if(!groups.length){ $('artist-list').innerHTML=`<div class="state" style="padding:2rem;font-size:12px">Nenhum resultado</div>`; return; }
  $('artist-list').innerHTML=groups.map(([artist,albums])=>{
    const isOpen=expanded[artist]===true;
    const albHtml=albums.map(a=>{
      const ri=allAlbums.indexOf(a);
      const isLiked=likedAlbums.has(a.identifier);
      return `
        <div class="album-item${ri===albumIdx?' active':''}" data-real="${ri}" tabindex="0" role="button">
          <div class="album-thumb-ph">♪</div>
          <img class="album-thumb" loading="lazy" src="${coverURL(a.identifier)}" alt=""
               onerror="this.style.display='none';this.previousElementSibling.style.display='flex'"
               onload="this.previousElementSibling.style.display='none'">
          <div class="album-info">
            <div class="album-name">${esc(a.title)}</div>
            <div class="album-date">${a.date||'—'}</div>
          </div>
          <button class="btn-like${isLiked?' liked':''}" data-id="${esc(a.identifier)}" aria-label="${isLiked?'Remover dos curtidos':'Curtir álbum'}" title="${isLiked?'Remover dos curtidos':'Adicionar aos curtidos'}">
            <svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.5"/><path d="M12 7v10M7 12h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
          </button>
        </div>`;
    }).join('');
    return `
      <div class="artist-group${isOpen?' open':''}" data-artist="${esc(artist)}">
        <div class="artist-hdr" tabindex="0" role="button">
          <span class="artist-chevron">▶</span>
          <span class="artist-hdr-name" title="${esc(artist)}">${esc(artist)}</span>
          <span class="artist-hdr-count">${albums.length}</span>
        </div>
        <div class="artist-albums">${albHtml}</div>
      </div>`;
  }).join('');
  $('artist-list').onclick=e=>{
    const likeBtn=e.target.closest('.btn-like');
    if(likeBtn){e.stopPropagation();toggleLiked(likeBtn.dataset.id);return;}
    const hdr=e.target.closest('.artist-hdr');
    if(hdr){
      const g=hdr.closest('.artist-group'),k=g.dataset.artist;
      if(g.classList.contains('open')){ expanded[k]=false; g.classList.remove('open'); }
      else {
        document.querySelectorAll('#artist-list .artist-group.open').forEach(el=>{
          expanded[el.dataset.artist]=false; el.classList.remove('open');
        });
        preloadAndOpen(g,k);
      }
      return;
    }
    const item=e.target.closest('.album-item');
    if(item) selectAlbum(+item.dataset.real);
  };
  $('artist-list').onkeydown=e=>{
    if(e.key!=='Enter') return;
    const hdr=e.target.closest('.artist-hdr'); if(hdr){hdr.click();return;}
    const item=e.target.closest('.album-item'); if(item) selectAlbum(+item.dataset.real);
  };
}

/* ── Search ──────────────────────────────────────────────── */
$('search-input').addEventListener('input',function(){
  const q=this.value.toLowerCase().trim();
  $('clear-btn').classList.toggle('vis',this.value.length>0);
  filtered=q?allAlbums.filter(a=>a.title.toLowerCase().includes(q)||a.creator.toLowerCase().includes(q)):[...allAlbums];
  if(q) groupByArtist(filtered).forEach(([k])=>{expanded[k]=true;});
  renderSidebar();
});
$('clear-btn').addEventListener('click',()=>{
  $('search-input').value='';
  Object.keys(expanded).forEach(k=>{expanded[k]=false;});
  $('search-input').dispatchEvent(new Event('input'));
  $('search-input').focus();
});

/* ── Select album ────────────────────────────────────────── */
async function selectAlbum(idx) {
  if(albumIdx===idx) return;
  albumIdx=idx; trackIdx=-1; tracks=[]; updateButtons();
  if(isMobile()) closeSidebar();
  document.querySelectorAll('.album-item').forEach(el=>el.classList.toggle('active',+el.dataset.real===idx));
  const album=allAlbums[idx];
  loadCover(album.identifier);
  $('main-panel').innerHTML=`
    <div class="panel-hdr">
      <div class="panel-cover-ph">♪</div>
      <div class="panel-hdr-text">
        <div class="panel-title">${esc(album.title)}</div>
        <div class="panel-meta">${album.creator?`<span>${esc(album.creator)}</span>`:''}${album.date?`<span>${esc(album.date)}</span>`:''}</div>
      </div>
    </div>
    <div class="state"><div class="state-icon" style="animation:pulse 1.2s infinite">♪</div><div>Carregando faixas…</div></div>`;
  try {
    let audioFiles;
    if(album.files){
      audioFiles=album.files;
    } else {
      const resp=await fetch(metaURL(album.identifier));
      const data=await resp.json();
      const all=(data.files||[]).filter(isAudio);
      const derivs=all.filter(f=>f.source==='derivative'&&/mp3|ogg|vorbis/i.test(f.format||''));
      audioFiles=derivs.length?derivs:all;
      const rt=data.metadata?.title;
      if(rt){
        allAlbums[idx].title=toTitleCase(rt);
        document.querySelectorAll(`.album-item[data-real="${idx}"] .album-name`).forEach(el=>el.textContent=allAlbums[idx].title);
      }
    }
    audioFiles.sort((a,b)=>{
      const ta=parseInt(a.track)||parseInt((a.name||'').match(/^(\d+)/)?.[1])||9999;
      const tb=parseInt(b.track)||parseInt((b.name||'').match(/^(\d+)/)?.[1])||9999;
      return ta!==tb?ta-tb:(a.name||'').localeCompare(b.name||'');
    });
    tracks=audioFiles; renderPanel(album,tracks); updateButtons();
  } catch(e) {
    $('main-panel').innerHTML=`<div class="state"><div class="state-icon">⚠</div><div>Erro ao carregar faixas<br><small>${esc(e.message)}</small></div></div>`;
  }
}

function loadCover(id) {
  const img=$('player-cover'), ph=$('cover-ph');
  if (coverCache.has(id)) {
    img.src=coverURL(id);
    img.classList.remove('hidden'); ph.style.display='none';
    return;
  }
  img.classList.add('hidden'); ph.style.display='flex';
  img.onload=()=>{ coverCache.add(id); img.classList.remove('hidden'); ph.style.display='none'; };
  img.onerror=()=>{ img.classList.add('hidden'); ph.style.display='flex'; };
  img.src=coverURL(id);
}

/* ── Track panel ─────────────────────────────────────────── */
function renderPanel(album,list) {
  const totalDur=list.reduce((s,f)=>s+(parseFloat(f.length)||0),0);
  const info=[`${list.length} faixa${list.length!==1?'s':''}`, ...(totalDur>0?[fmtTime(totalDur)+' total']:[])].join(' · ');
  const covId=album.identifier;
  $('main-panel').innerHTML=`
    <div class="panel-hdr">
      <div class="panel-cover-ph" id="pcov-ph">♪</div>
      <img class="panel-cover-img" id="pcov-img" alt="Capa">
      <div class="panel-hdr-text">
        <div class="panel-title">${esc(album.title)}</div>
        <div class="panel-meta">
          ${album.creator?`<span>${esc(album.creator)}</span>`:''}
          ${album.date   ?`<span>${esc(album.date)}</span>`   :''}
          <span>${esc(info)}</span>
        </div>
      </div>
    </div>
    <div class="track-list" id="track-list">
      ${list.length===0
        ?`<div class="state"><div class="state-icon">○</div><div>Nenhum arquivo de áudio encontrado</div></div>`
        :list.map(trackRow).join('')}
    </div>`;
  const pci=$('pcov-img'), pcp=$('pcov-ph');
  if(pci){
    if (coverCache.has(covId)) {
      pci.src=coverURL(covId); pci.style.display='block'; pcp.style.display='none';
    } else {
      pci.onload=()=>{ coverCache.add(covId); pci.style.display='block'; pcp.style.display='none'; };
      pci.onerror=()=>{ pci.style.display='none'; pcp.style.display='flex'; };
      pci.src=coverURL(covId);
    }
  }
  $('track-list').onclick=e=>{const r=e.target.closest('.track-row');if(r)playTrack(+r.dataset.i);};
  $('track-list').onkeydown=e=>{if(e.key==='Enter'){const r=e.target.closest('.track-row');if(r)playTrack(+r.dataset.i);}};
}
function trackRow(f,i) {
  const name=getTrackTitle(f), ext=(f.name||'').split('.').pop().toUpperCase(), dur=fmtTime(parseFloat(f.length));
  return `<div class="track-row${i===trackIdx?' active':''}" id="tr-${i}" data-i="${i}" tabindex="0" role="button">
    <div class="track-num">${i===trackIdx?'▶':String(i+1).padStart(2,'0')}</div>
    <div class="track-info"><div class="track-name" title="${esc(name)}">${esc(name)}</div></div>
    <div class="track-fmt">${esc(ext)}</div>
    <div class="track-dur">${dur}</div>
  </div>`;
}
function refreshRow(i) {
  const el=$(`tr-${i}`); if(!el) return;
  el.className=`track-row${i===trackIdx?' active':''}`;
  el.querySelector('.track-num').textContent=i===trackIdx?'▶':String(i+1).padStart(2,'0');
}

/* ── Playback ────────────────────────────────────────────── */
function playTrack(idx) {
  initAudio();
  const prev=trackIdx; trackIdx=idx;
  refreshRow(prev); refreshRow(idx);
  $(`tr-${idx}`)?.scrollIntoView({block:'nearest',behavior:'smooth'});
  const track=tracks[idx], album=allAlbums[albumIdx];
  showLoading();
  audio.src=dlURL(album.identifier,track.name);
  audio.volume=parseFloat($('vol-slider').value);
  audio.play().catch(err=>{console.warn('[player]',err);hideLoading();});
  $('np-track').textContent=getTrackTitle(track);
  $('np-album').textContent=album.title;
  if(eqOpen&&analyserNode&&!animFrameId) drawSpectrum();
  updateButtons();
}
function togglePlay() {
  if(trackIdx<0&&tracks.length>0){playTrack(0);return;}
  if(!audio.src) return;
  initAudio();
  audio.paused?audio.play().catch(console.warn):audio.pause();
}
function prevTrack() { if(trackIdx>0) playTrack(trackIdx-1); }
function nextTrack() { if(trackIdx<tracks.length-1) playTrack(trackIdx+1); }
function updateButtons() {
  $('btn-play').disabled=tracks.length===0;
  $('btn-prev').disabled=trackIdx<=0;
  $('btn-next').disabled=tracks.length===0||trackIdx>=tracks.length-1;
}

/* ── Loading overlay ─────────────────────────────────────── */
function showLoading() { $('loading-overlay').classList.add('vis'); }
function hideLoading() { $('loading-overlay').classList.remove('vis'); }

/* ── Audio events ────────────────────────────────────────── */
audio.addEventListener('play',    ()=>{$('icon-play').style.display='none';$('icon-pause').style.display='';});
audio.addEventListener('pause',   ()=>{$('icon-play').style.display='';   $('icon-pause').style.display='none';});
audio.addEventListener('playing', hideLoading);
audio.addEventListener('waiting', showLoading);
audio.addEventListener('error',   hideLoading);
audio.addEventListener('timeupdate',()=>{
  if(!audio.duration) return;
  const pct=(audio.currentTime/audio.duration*100).toFixed(2)+'%';
  $('prog-fill').style.width=$('prog-thumb').style.left=pct;
  $('np-time').textContent=`${fmtTime(audio.currentTime)} / ${fmtTime(audio.duration)}`;
});
audio.addEventListener('ended',()=>{
  if(trackIdx<tracks.length-1) nextTrack();
  else{$('icon-play').style.display='';$('icon-pause').style.display='none';}
});

/* ── Controls ────────────────────────────────────────────── */
$('btn-prev').addEventListener('click',prevTrack);
$('btn-play').addEventListener('click',togglePlay);
$('btn-next').addEventListener('click',nextTrack);
$('prog-wrap').addEventListener('click',e=>{
  if(!audio.duration) return;
  const r=e.currentTarget.getBoundingClientRect();
  audio.currentTime=Math.max(0,Math.min(1,(e.clientX-r.left)/r.width))*audio.duration;
});
$('vol-slider').addEventListener('input',e=>{audio.volume=parseFloat(e.target.value);});

/* ── Keyboard ────────────────────────────────────────────── */
document.addEventListener('keydown',e=>{
  if(e.target.tagName==='INPUT') return;
  ({
    Space:      ()=>{e.preventDefault();togglePlay();},
    ArrowRight: ()=>{e.preventDefault();audio.currentTime=Math.min(audio.duration||0,audio.currentTime+10);},
    ArrowLeft:  ()=>{e.preventDefault();audio.currentTime=Math.max(0,audio.currentTime-10);},
    ArrowUp:    ()=>{e.preventDefault();prevTrack();},
    ArrowDown:  ()=>{e.preventDefault();nextTrack();},
    KeyE:       ()=>{e.preventDefault();toggleEqPanel();},
  }[e.code]||Function)();
});

/* ── Resize ──────────────────────────────────────────────── */
let _lastMobile = isMobile();
window.addEventListener('resize', () => {
  const nowMobile = isMobile();
  if (nowMobile && eqOpen) toggleEqPanel();
  if (!nowMobile && _lastMobile) closeSidebar();
  _lastMobile = nowMobile;
});

/* ── Lib-title marquee (mobile only) ────────────────────── */
(function(){
  const outer = document.getElementById('lib-title');
  const inner = document.getElementById('lib-title-text');
  if (!outer || !inner) return;
  let timer = null;

  function runSlide() {
    if (!isMobile()) return;
    const overflow = inner.scrollWidth - outer.clientWidth;
    if (overflow <= 2) return;
    outer.style.setProperty('--lib-name-slide-dist', `-${overflow}px`);
    inner.classList.remove('sliding');
    void inner.offsetWidth;
    inner.classList.add('sliding');
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(runSlide, 400);
  }

  schedule();
  window.addEventListener('resize', () => {
    schedule();
    if (!isMobile()) inner.classList.remove('sliding');
  });

  new MutationObserver(schedule).observe(inner, { childList: true, characterData: true, subtree: true });
})();

/* ── Hover preload ───────────────────────────────────────── */
function onAlbumHover(e) {
  const item = e.target.closest('.album-item');
  if (!item) return;
  const ri = +item.dataset.real;
  if (!isNaN(ri) && allAlbums[ri]) preloadCover(allAlbums[ri].identifier);
}
$('artist-list').addEventListener('mouseover', onAlbumHover, { passive: true });
$('liked-list').addEventListener('mouseover', onAlbumHover, { passive: true });

/* ── Go ──────────────────────────────────────────────────── */
init();

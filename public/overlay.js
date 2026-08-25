// Overlay script: listens for server-sent events with the queue and updates the one-line display.
const $ = id => document.getElementById(id);

function escapeHtml(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}

function formatQueue(queue){
  if(!queue || !queue.length) return 'No songs in request queue - Try requesting one in chat (!queue, !search, !requestid)';
  return queue.map(r => {
    const title = escapeHtml(r.title || '(unknown)');
    const artist = r.artist ? ` - ${escapeHtml(r.artist)}` : '';
    return `ID:${r.song_id} ${title}${artist}`;
  }).join('  |  ');
}

function updateMessage(queue){
  const msg = formatQueue(queue);
  $("message").textContent = msg;
}

// Try EventSource first; fall back to polling if not available.
function startSSE(){
  try{
    const s = new EventSource('/overlay/queue/stream');
    s.addEventListener('message', (ev)=>{
      try{ const data = JSON.parse(ev.data); updateMessage(data); } catch(e){ console.error('Failed to parse SSE data', e); }
    });
    s.addEventListener('error', (e)=>{
      // On error, EventSource will retry automatically. If closed, fallback to polling.
      console.warn('SSE error', e);
    });
    return true;
  }catch(e){
    console.warn('SSE unavailable, falling back to polling', e);
    return false;
  }
}

async function poll(){
  try{
    const resp = await fetch('/api/queue');
    if(!resp.ok) throw new Error('Failed');
    const data = await resp.json();
    updateMessage(data);
  }catch(e){ console.error('Polling failed', e); }
}

if(!startSSE()){
  poll();
  setInterval(poll, 1000);
}

// Overlay script: listens for server-sent events with the queue and updates the multi-line display.
const $ = id => document.getElementById(id);

function escapeHtml(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}

function formatQueue(queue){
  if(!queue || !queue.length){
    return `
      <div class="queue-empty-state">
        <div class="queue-empty-row"></div>
        <div class="queue-empty-row"></div>
        <div class="queue-empty-row queue-empty-row--message">No songs in request queue - Try requesting one in chat (!queue, !search, !requestid)</div>
      </div>
    `;
  }

  return `
    <div class="queue-stack">
      ${queue.map((r, index) => {
        const title = escapeHtml(r.title || '(unknown)');
        const subtitle = escapeHtml(r.subtitle || '');
        const artist = escapeHtml(r.artist || '(unknown artist)');
        const pack = escapeHtml(r.pack || 'Unknown Pack');
        const requester = escapeHtml(r.requested_display || r.requested_by || 'unknown');
        const titleLine = subtitle ? `${title} (${subtitle}) - <${artist}>` : `${title} - <${artist}>`;

        return `
          <div class="queue-entry">
            <div class="queue-lines">
              <div class="queue-line queue-line-title">${titleLine}</div>
              <div class="queue-line queue-line-pack">${pack}</div>
              <div class="queue-line queue-line-requester">Requested by: @${requester}</div>
            </div>
            ${index < queue.length - 1 ? '<div class="queue-divider" aria-hidden="true"></div>' : ''}
          </div>
        `;
      }).join('')}
    </div>
  `;
}

function updateMessage(queue){
  const msg = formatQueue(queue);
  const el = $("message");
  el.innerHTML = msg;
  el.classList.remove('queue-animate');
  void el.offsetWidth;
  el.classList.add('queue-animate');
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

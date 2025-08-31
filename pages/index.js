import { useState, useEffect } from 'react';

export default function Home() {
  const [url, setUrl] = useState('');
  const [taskId, setTaskId] = useState(null);
  const [status, setStatus] = useState('idle');
  const [text, setText] = useState('');
  const [srt, setSrt] = useState('');

  async function start() {
    setTaskId(null); setStatus('submitting'); setText(''); setSrt('');
    const r = await fetch('/api/transcribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, language: 'zh' }),
    });
    const data = await r.json();
    if (data.id) { setTaskId(data.id); setStatus('processing'); }
    else { alert('提交失败：' + JSON.stringify(data)); setStatus('idle'); }
  }

  useEffect(() => {
    if (!taskId) return;
    const timer = setInterval(async () => {
      const r = await fetch('/api/status?id=' + taskId);
      const data = await r.json();
      setStatus(data.status);
      if (data.status === 'completed') {
        setText(data.text || '');
        setSrt(data.srt || '');
        clearInterval(timer);
      }
      if (data.status === 'error') {
        clearInterval(timer);
        alert('转写失败：' + data.error);
      }
    }, 5000);
    return () => clearInterval(timer);
  }, [taskId]);

  return (
    <div style={{ maxWidth: 820, margin: '40px auto', fontFamily: 'system-ui' }}>
      <h1>YouTube 转文字 / 字幕</h1>
      <div style={{ display: 'flex', gap: 8 }}>
        <input value={url} onChange={e => setUrl(e.target.value)} placeholder="粘贴 YouTube 链接"
               style={{ flex: 1, padding: 10, border: '1px solid #ccc', borderRadius: 8 }} />
        <button onClick={start} disabled={!url || status==='processing'}
                style={{ padding: '10px 16px', borderRadius: 8 }}>
          {status==='processing' ? '处理中...' : '开始转写'}
        </button>
      </div>

      <p style={{ color: '#666' }}>状态：{status}</p>

      {text && (
        <>
          <h3>文字稿（TXT）</h3>
          <textarea value={text} readOnly style={{ width: '100%', height: 260, padding: 12 }} />
          <button onClick={() => download('transcript.txt', text)}>下载 TXT</button>
        </>
      )}

      {srt && (
        <>
          <h3>字幕（SRT）</h3>
          <textarea value={srt} readOnly style={{ width: '100%', height: 180, padding: 12 }} />
          <button onClick={() => download('subtitles.srt', srt)}>下载 SRT</button>
        </>
      )}
    </div>
  );
}

function download(name, content) {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
}
